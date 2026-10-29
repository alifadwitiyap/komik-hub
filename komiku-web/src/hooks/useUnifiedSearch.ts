import { useCallback, useEffect, useRef, useState } from 'react'
import { toMangaCard, unifiedApi } from '../api'
import type { Manga } from '../types'

/**
 * Pencarian lintas sumber dengan protokol DUA FASE milik server.
 *
 * Server membalas fase 1 dalam ~3 s berisi sumber cepat + `pending` (sumber
 * yang belum selesai, biasanya `komiku` yang TTFB-nya 5-9 s). Task background
 * server lalu menyelesaikan sisanya dan menulis hasil GABUNGAN ke cache, jadi
 * panggilan ulang dengan kunci sama biasanya instan dan `pending` hilang.
 *
 * Modul ini menutup seluruh protokol itu. Halaman cukup membaca
 * `{ items, pending, loading, ... }` dan tidak perlu tahu ada fase.
 *
 * Kenapa tidak di halaman: tanpa ini, tiap pemakai harus menulis sendiri
 * "kalau pending tidak kosong, panggil ulang nanti" — dan kalau lupa, user
 * melihat daftar yang tampak lengkap padahal kurang satu sumber.
 */

/** Jeda sebelum mencoba fase 2. Server butuh ~5-9 s untuk komiku; 4 s pertama
 *  biasanya masih kosong, jadi kita beri ruang lalu coba lagi. */
const RETRY_DELAY_MS = 4000

/** Batas percobaan ulang. Tanpa batas, sumber yang mati permanen membuat
 *  request berulang selamanya di latar belakang. */
const MAX_PHASE2_ATTEMPTS = 2

export interface UnifiedSearchState {
  items: Manga[]
  /** Sumber yang belum selesai dilaporkan server. Kosong = hasil lengkap. */
  pending: string[]
  /** Jumlah sumber yang gagal pada panggilan terakhir. */
  failedSources: number
  /** Jumlah sumber yang digabung server (bukan hardcode di web). */
  sourcesTotal: number
  loading: boolean
  /** True selama fase 2 berjalan — hasil sudah tampil, tapi belum lengkap. */
  completing: boolean
  error: string | null
  /** Panggil ulang manual (dipakai tombol coba lagi). */
  refresh: () => void
}

export interface UnifiedSearchFilter {
  tipe?: string | null
  status?: string | null
  genre?: string | null
}

export function useUnifiedSearch(
  query: string,
  page: number,
  filter: UnifiedSearchFilter,
  enabled = true,
  /**
   * Jalur cadangan kalau unified mati total (route belum terkompilasi, 5xx,
   * jaringan). Pemanggil yang menentukan isinya karena hanya dia yang tahu
   * endpoint lama mana yang setara — dan hanya boleh dipakai saat TIDAK ada
   * filter, sebab `/api/search` lama tidak menerima tipe/status/genre.
   */
  fallback?: (signal: AbortSignal) => Promise<Manga[]>,
): UnifiedSearchState {
  const [items, setItems] = useState<Manga[]>([])
  const [pending, setPending] = useState<string[]>([])
  const [failedSources, setFailedSources] = useState(0)
  const [sourcesTotal, setSourcesTotal] = useState(0)
  const [loading, setLoading] = useState(enabled)
  const [completing, setCompleting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [nonce, setNonce] = useState(0)

  // Nilai filter dibaca lewat ref supaya perubahan objek filter (identitas baru
  // tiap render) tidak memicu request berulang.
  const filterRef = useRef(filter)
  filterRef.current = filter
  const fallbackRef = useRef(fallback)
  fallbackRef.current = fallback

  const refresh = useCallback(() => setNonce((n) => n + 1), [])

  useEffect(() => {
    if (!enabled) return

    let cancelled = false
    const timers: ReturnType<typeof setTimeout>[] = []
    const ctrls: AbortController[] = []

    const run = (attempt: number) => {
      const ctrl = new AbortController()
      ctrls.push(ctrl)
      const f = filterRef.current

      unifiedApi
        .search(query, page, ctrl.signal, {
          tipe: f.tipe,
          status: f.status,
          genre: f.genre,
        })
        .then((r) => {
          if (cancelled) return

          setItems(r.items.map(toMangaCard))
          setFailedSources(r.failed_sources?.length ?? 0)
          // Server mengirim sources_total; kalau absen (server lama), pakai
          // jumlah yang benar-benar dilaporkan, JANGAN hardcode 4.
          setSourcesTotal(
            r.sources_total ?? (r.sources_ok ?? 0) + (r.failed_sources?.length ?? 0),
          )
          setLoading(false)
          setError(null)

          const next = r.pending ?? []
          setPending(next)

          // Fase 2: hanya kalau masih ada sumber yang belum selesai.
          if (next.length > 0 && attempt < MAX_PHASE2_ATTEMPTS) {
            setCompleting(true)
            timers.push(
              setTimeout(() => {
                if (!cancelled) run(attempt + 1)
              }, RETRY_DELAY_MS),
            )
          } else {
            setCompleting(false)
          }
        })
        .catch((e: Error) => {
          if (cancelled || e.name === 'AbortError') return

          const fb = fallbackRef.current
          if (fb) {
            // Unified mati total — coba endpoint lama supaya pencarian tetap
            // berfungsi. `completing` dimatikan: tidak ada fase 2 di jalur ini.
            setCompleting(false)
            setPending([])
            fb(ctrl.signal)
              .then((legacy) => {
                if (!cancelled) {
                  setItems(legacy)
                  setError(null)
                }
              })
              .catch((e2: Error) => {
                if (!cancelled && e2.name !== 'AbortError') setError(e2.message)
              })
              .finally(() => {
                if (!cancelled) setLoading(false)
              })
            return
          }

          setLoading(false)
          setCompleting(false)
          setError(e.message || 'Gagal memuat hasil')
        })
    }

    setLoading(true)
    setCompleting(false)
    setError(null)
    setPending([])
    run(0)

    return () => {
      cancelled = true
      timers.forEach(clearTimeout)
      ctrls.forEach((c) => c.abort())
    }
  }, [query, page, enabled, nonce])

  return {
    items,
    pending,
    failedSources,
    sourcesTotal,
    loading,
    completing,
    error,
    refresh,
  }
}
