import { useCallback, useEffect, useRef, useState } from 'react'
import { unifiedApi } from '../api'
import type { MangaOut, UnifiedChapterOut } from '../types'
import { useProgress } from './useProgress'

export interface SeriesData {
  manga: MangaOut
  chapters: UnifiedChapterOut[]
  representative_source: string | null
}

/**
 * Muat detail manga unified (route /manga/:handle) + daftar chapter-nya.
 *
 * Menutup fetch + abort saat unmount/ganti handle + muat ulang manual
 * (tombol "Coba lagi" di SourceStatus) + `failedSources`. Halaman cukup
 * membaca `{ data, failedSources, error, reload }` — pola sama dengan
 * useUnifiedSearch.
 */
export function useSeriesData(handle: string) {
  const [data, setData] = useState<SeriesData | null>(null)
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
    const ctrl = new AbortController()
    setData(null)
    setError(null)
    unifiedApi
      .series(handle, ctrl.signal, lastSourceRef.current)
      .then((r) => {
        setData({
          manga: r.manga,
          chapters: r.chapters ?? [],
          representative_source: r.representative_source ?? null,
        })
        setFailedSources(r.failed_sources ?? [])
      })
      .catch((e: Error) => e.name !== 'AbortError' && setError(e.message))
    return () => ctrl.abort()
  }, [handle, reloadKey])

  const reload = useCallback(() => setReloadKey((k) => k + 1), [])

  return { data, failedSources, error, reload }
}
