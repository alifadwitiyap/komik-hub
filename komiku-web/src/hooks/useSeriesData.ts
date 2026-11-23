import { useCallback, useEffect, useRef, useState } from 'react'
import { unifiedApi } from '../api'
import type { MangaOut, UnifiedChapterOut } from '../types'
import { useProgress } from './useProgress'

export interface SeriesData {
  manga: MangaOut
  chapters: UnifiedChapterOut[]
  representative_source: string | null
}

// Server melakukan dua-fase: fase-1 menyajikan manga + daftar chapter SUMBER
// PELAYAN seketika, lalu union lintas sumber di-merge di background. Selama
// `pending` (sumber lain yang belum tercermin) tidak kosong, panggil ulang
// nanti sampai `pending` hilang — persis pola useUnifiedSearch.
const RETRY_DELAY_MS = 4000
const MAX_PHASE2_ATTEMPTS = 2

/**
 * Muat detail manga unified (route /manga/:handle) + daftar chapter-nya.
 *
 * Menutup fetch + abort saat unmount/ganti handle + muat ulang manual
 * (tombol "Coba lagi" di SourceStatus) + `failedSources`. Halaman cukup
 * membaca `{ data, failedSources, pending, error, reload }` — pola sama dengan
 * useUnifiedSearch. Data fase-1 langsung dirender (bukan null-sampai-penuh);
 * saat merge background masuk, daftar chapter reconcile otomatis.
 */
export function useSeriesData(handle: string) {
  const [data, setData] = useState<SeriesData | null>(null)
  /** Sumber lain yang belum tercermin (masih di-merge di background). */
  const [pending, setPending] = useState<string[]>([])
  /**
   * Sumber yang gagal dilaporkan server untuk halaman ini. Server sudah lama
   * mengirimnya; sebelumnya dibuang sehingga user tidak tahu daftar chapter
   * yang ia lihat lebih tipis dari seharusnya.
   */
  const [failedSources, setFailedSources] = useState<string[]>([])
  /** Naikkan untuk memicu muat ulang (tombol "Coba lagi" di SourceStatus). */
  const [reloadKey, setReloadKey] = useState(0)
  const [error, setError] = useState<string | null>(null)

  const { recent } = useProgress()

  // Sticky B+C — server coba sumber terakhir-dibaca untuk judul ini dulu
  // (kalau ada di riwayat), baru fallback primary. Ref supaya effect tidak
  // re-fetch setiap kali riwayat bertambah.
  const lastSourceRef = useRef<string | undefined>(undefined)
  lastSourceRef.current = recent.find((r) => String(r.seriesId) === handle)?.source ?? undefined

  useEffect(() => {
    if (!handle) return
    let cancelled = false
    const ctrl = new AbortController()
    const timers: ReturnType<typeof setTimeout>[] = []

    const run = (attempt: number) => {
      unifiedApi
        .series(handle, ctrl.signal, lastSourceRef.current)
        .then((r) => {
          if (cancelled) return
          setData({
            manga: r.manga,
            chapters: r.chapters ?? [],
            representative_source: r.representative_source ?? null,
          })
          setFailedSources(r.failed_sources ?? [])
          const next = r.pending ?? []
          setPending(next)
          if (next.length > 0 && attempt < MAX_PHASE2_ATTEMPTS) {
            timers.push(
              setTimeout(() => {
                if (!cancelled) run(attempt + 1)
              }, RETRY_DELAY_MS),
            )
          } else if (next.length === 0) {
            setPending([])
          }
        })
        .catch((e: Error) => {
          if (!cancelled && e.name !== 'AbortError') setError(e.message)
        })
    }

    setData(null)
    setError(null)
    setPending([])
    run(0)

    return () => {
      cancelled = true
      ctrl.abort()
      timers.forEach(clearTimeout)
    }
  }, [handle, reloadKey])

  const reload = useCallback(() => setReloadKey((k) => k + 1), [])

  return { data, pending, failedSources, error, reload }
}
