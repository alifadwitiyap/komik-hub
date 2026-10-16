import { useCallback, useEffect, useState } from 'react'

export interface ProgressEntry {
  seriesId: number | string
  seriesTitle: string | null
  chapterId: number | string
  chapterName: string
  page: number
  /** 0..1 — posiasi halaman terakhir yang terbaca */
  progress: number
  /**
   * Lane A — posisi baca presisi: id halaman (URL gambar dari API) yang
   * sedang ditatap pembaca. Opsional; entri lama hanya punya `page`.
   */
  pageId?: string
  /**
   * Lane B — unified: sumber yang melayani chapter ini + handle sumbernya.
   * Dipakai series page mengirim `last_source` supaya server coba sumber
   * yang sama dulu, dan dipakai reader untuk RESET posisi pindah sumber.
   */
  source?: string | null
  handle?: string | null
  /**
   * Lane A — 0..1: seberapa jauh "posisi mata" (tengah viewport) menembus
   * halaman `pageId`. Digunakan memulihkan posisi baca ke piksel, bukan
   * cuma ke atas halaman.
   */
  offsetRatio?: number
  at: number
}

const KEY = 'komiku.web.progress.v1'
const MAX = 24

function read(): ProgressEntry[] {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return []
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    // kompatibilitas: buang entri legacy berkunci judul ("t:<judul>") yang
    // bikin duplikat di riwayat — series sekarang selalu pakai id numerik.
    return (parsed as ProgressEntry[]).filter((e) => !String(e.seriesId).startsWith('t:'))
  } catch {
    return []
  }
}

function write(entries: ProgressEntry[]) {
  try {
    localStorage.setItem(KEY, JSON.stringify(entries))
  } catch {
    /* storage penuh / mode privat — progres tidak ganggu membaca */
  }
}

/**
 * Riwayat "lanjut baca" per manga. Satu entri per manga (yang terbaru menang),
 * supaya daftar tidak banjir chapter dari serial yang sama.
 */
export function useProgress() {
  const [entries, setEntries] = useState<ProgressEntry[]>(read)

  useEffect(() => {
    const onStorage = (e: StorageEvent) => e.key === KEY && setEntries(read())
    window.addEventListener('storage', onStorage)
    return () => window.removeEventListener('storage', onStorage)
  }, [])

  const save = useCallback((entry: Omit<ProgressEntry, 'at'>) => {
    setEntries((prev) => {
      const next = [
        { ...entry, at: Date.now() },
        ...prev.filter((p) => String(p.seriesId) !== String(entry.seriesId)),
      ].slice(0, MAX)
      write(next)
      return next
    })
  }, [])

  const clear = useCallback(() => {
    setEntries([])
    write([])
  }, [])

  return { recent: entries, save, clear }
}

/** Entri untuk satu manga (dipakai tombol "Lanjut"). */
export function findProgress(
  entries: ProgressEntry[],
  seriesId: number | string | undefined,
): ProgressEntry | undefined {
  if (seriesId === undefined) return undefined
  return entries.find((e) => String(e.seriesId) === String(seriesId))
}
