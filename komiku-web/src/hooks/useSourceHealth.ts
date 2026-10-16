/**
 * useSourceHealth — state pill source-health di TopBar.
 *
 * GET /api/unified/health saat mount, lalu poll tiap 30 detik; interval
 * dijeda selama tab disembunyikan dan probe langsung jalan lagi saat tab
 * kembali terlihat (kontrak plan source-health-badge.md, risk 1).
 *
 * Disiplin sama dengan useNotifications: satu AbortController per request,
 * di-abort saat unmount / saat request lebih baru menimpa, dan TIDAK ada
 * setState setelah unmount.
 *
 * Kegagalan (endpoint belum di-integrasikan lane server → 404, atau jaringan
 * mati) TIDAK menghapus baris terakhir: state jadi `stale` supaya pill tetap
 * tampil dengan angka terakhir yang diketahui (risk 4).
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { unifiedApi } from '../api'
import type { SourceHealthRow } from '../types'

const POLL_MS = 30_000

/** `loading` = belum pernah ada balasan, `live` = balasan sukses terakhir,
 *  `stale` = balasan terakhir diketahui, pemeriksaan terbaru gagal. */
export type HealthStatus = 'loading' | 'live' | 'stale'

export interface SourceHealthState {
  rows: SourceHealthRow[]
  healthy: number
  total: number
  checkedAtMs: number | null
  status: HealthStatus
  /** paksa probe ulang sekarang (mis. setelah tab kembali fokus). */
  refresh: () => void
}

const INITIAL: Omit<SourceHealthState, 'refresh'> = {
  rows: [],
  healthy: 0,
  total: 0,
  checkedAtMs: null,
  status: 'loading',
}

export function useSourceHealth(): SourceHealthState {
  const [state, setState] = useState<Omit<SourceHealthState, 'refresh'>>(INITIAL)
  const mounted = useRef(true)
  const inFlight = useRef<AbortController | null>(null)

  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
      inFlight.current?.abort()
      inFlight.current = null
    }
  }, [])

  const load = useCallback(async (force = false) => {
    inFlight.current?.abort()
    const ctrl = new AbortController()
    inFlight.current = ctrl
    try {
      const data = await unifiedApi.health(ctrl.signal, force)
      if (!mounted.current || ctrl.signal.aborted) return
      const rows = Array.isArray(data.sources) ? data.sources : []
      // total/healthy dipercaya dari server; kalau absen, hitung dari baris.
      const healthy =
        typeof data.healthy === 'number' ? data.healthy : rows.filter((r) => r.ok).length
      const total = typeof data.total === 'number' ? data.total : rows.length
      setState({
        rows,
        healthy,
        total,
        checkedAtMs: data.checked_at_ms ?? null,
        status: 'live',
      })
    } catch {
      // 404 (endpoint belum ada) / offline: jumlah terakhir dipertahankan.
      if (!mounted.current || ctrl.signal.aborted) return
      setState((s) => ({ ...s, status: 'stale' }))
    }
  }, [])

  // fetch awal + poll 30s (dilewati saat tab hidden) + refresh on focus tab
  useEffect(() => {
    void load()
    const id = setInterval(() => {
      if (document.visibilityState === 'hidden') return
      void load()
    }, POLL_MS)
    const onVisible = () => {
      if (document.visibilityState === 'visible') void load()
    }
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      clearInterval(id)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [load])

  // refresh MANUAL (tombol "periksa ulang") → force=1: lewati cache server,
  // jadi user benar-benar dapat hasil probe baru, bukan stale ≤30s.
  const refresh = useCallback(() => {
    void load(true)
  }, [load])

  return { ...state, refresh }
}
