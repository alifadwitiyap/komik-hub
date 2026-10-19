import { useEffect, useState } from 'react'
import { api, unifiedApi } from '../api'
import { parseUnifiedKey } from '../readerSource'
import type { Chapter } from '../types'

/**
 * Daftar chapter yang bisa dipilih dari dalam reader.
 *
 * Dua flow, satu bentuk output:
 *   - unified : kunci chapter "handle:number" (mis. "komiku:1284:121")
 *   - legacy  : kunci chapter = id numerik komiku (mis. "6427")
 * `key` dipakai langsung oleh readerHref()/marathonHref() sehingga sheet
 * tidak pernah perlu tahu bentuk URL per flow.
 */
export interface PickableChapter {
  /** kunci chapter — feed ke readerHref()/marathonHref() */
  key: string
  /** nomor chapter (string: "1195", "1.5", "extra-9") */
  number: string
  /** judul chapter */
  title: string
}

export interface PickableChaptersState {
  chapters: PickableChapter[]
  loading: boolean
  error: string | null
}

export interface PickableChaptersInput {
  /** sheet sedang dibuka? (false = jangan fetch) */
  enabled: boolean
  /** kunci chapter yang sedang dibaca — juga penentu flow */
  chapterKey: string | null
  /** id manga legacy (angka) — dipakai kalau flow unified tidak terdeteksi */
  legacySeriesId: number | null
}

/**
 * Ambil daftar chapter sebuah series.
 *
 * `chapterKey` menentukan flow: kalau bisa di-parse sebagai unified
 * (mengandung ':') → endpoint unified `/api/unified/series/{handle}`;
 * kalau tidak → flow legacy komiku `/api/series/{id}` (butuh id manga).
 *
 * Fetch baru jalan saat `enabled` true (sheet dibuka) — daftar chapter
 * tidak perlu ikut terunduh tiap kali chapter dibuka.
 */
export function usePickableChapters({
  enabled,
  chapterKey,
  legacySeriesId,
}: PickableChaptersInput): PickableChaptersState {
  const [chapters, setChapters] = useState<PickableChapter[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!enabled || !chapterKey) {
      setChapters([])
      setLoading(false)
      setError(null)
      return
    }
    const ctrl = new AbortController()
    const unified = parseUnifiedKey(chapterKey)

    setLoading(true)
    setError(null)

    const job = unified
      ? unifiedApi.series(unified.handle, ctrl.signal).then((r) =>
          (r.chapters ?? []).map((c) => ({
            key: `${unified.handle}:${c.number}`,
            number: c.number,
            title: c.title || `Chapter ${c.number}`,
          })),
        )
      : legacySeriesId != null
        ? api.series(legacySeriesId, ctrl.signal).then((r) =>
            (r.chapters ?? []).map((c) => ({
              key: String(c.id),
              number: legacyNumber(c),
              title: c.name,
            })),
          )
        : Promise.resolve([] as PickableChapter[])

    job
      .then((list) => setChapters(sortAscending(list)))
      .catch((e: Error) => {
        if (e.name === 'AbortError') return
        setError(e.message)
        setChapters([])
      })
      .finally(() => setLoading(false))

    return () => ctrl.abort()
  }, [enabled, chapterKey, legacySeriesId])

  return { chapters, loading, error }
}

/** Nomor chapter legacy: field `number` kalau ada, else parse dari nama. */
function legacyNumber(c: Chapter): string {
  if (c.number != null && String(c.number).trim() !== '') return String(c.number).trim()
  const m = /chapter\s*([0-9]+(?:[._][0-9]+)?)/i.exec(c.name ?? '')
  return m ? m[1] : ''
}

/** Urutan baca: nomor kecil → besar. Non-numerik jatuh ke urutan teks. */
function sortAscending(list: PickableChapter[]): PickableChapter[] {
  return [...list].sort((a, b) => {
    const na = Number(a.number)
    const nb = Number(b.number)
    if (Number.isFinite(na) && Number.isFinite(nb) && na !== nb) return na - nb
    return a.number.localeCompare(b.number, undefined, { numeric: true })
  })
}
