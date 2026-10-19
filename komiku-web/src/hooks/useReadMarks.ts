import { useEffect, useState } from 'react'
import {
  isChapterRead,
  pullSeries,
  readCount,
  subscribeReadMarks,
} from '../readMarks'

/**
 * useReadMarks — state "sudah dibaca" untuk SATU series.
 *
 * `titleKey` = title_key series (lintas-sumber). Saat berubah, state mark
 * untuk series itu ditarik dari server (lazy per-series) supaya chapter yang
 * sudah dibaca di device lain ikut tampil abu.
 *
 * Mengembalikan:
 *   - `isRead(chapter)` → chapter itu sudah pernah dibuka?
 *   - `count`           → berapa chapter yang sudah dibaca di series ini
 *   - `refresh()`       → tarik ulang dari server (manual)
 */
export function useReadMarks(titleKey: string | null | undefined) {
  // Versi state — dinaikkan tiap mark berubah supaya komponen re-render.
  const [, bump] = useState(0)

  useEffect(() => subscribeReadMarks(() => bump((v) => v + 1)), [])

  useEffect(() => {
    if (!titleKey) return
    void pullSeries(titleKey)
  }, [titleKey])

  return {
    isRead: (chapter: string | null | undefined) => isChapterRead(titleKey, chapter),
    count: readCount(titleKey),
    refresh: () => (titleKey ? void pullSeries(titleKey) : undefined),
  }
}
