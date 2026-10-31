import { useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import { useProgress, type ProgressEntry } from './useProgress'
import { useMarathonMemory } from './useMarathonMemory'
import { marathonHref, readerHref } from '../readerSource'

/**
 * useModeSwitch.ts — perpindahan mode reader ↔ marathon (K5).
 *
 * Memusatkan side-effect "tulis posisi ke store yang benar, lalu navigate"
 * yang sebelumnya berdiri inline di 4 tempat (toggle Reader, toggle Marathon,
 * menu onChange di keduanya). Hook ini tahu store & href mana yang benar per
 * arah; pemanggil cukup menyuplai payload posisi (yang butuh state/DOM lokal
 * komponen).
 *
 *   - `gotoMarathon(seed?)`   : Reader → Marathon. `seed` = bibit sesi
 *     maraton (posisi baca reader). Tanpa seed → hanya navigate (menu).
 *   - `gotoReader(prog?)`     : Marathon → Reader. `prog` = entri progress
 *     (posisi baca marathon, terukur dari DOM). Tanpa prog → hanya navigate.
 *
 * `targetBlock` (opsional, hanya sisi Marathon) menentukan chapter tujuan saat
 * keluar ke reader: blok AKTIF (`curBlock`), bukan blok pertama rantai.
 */

export interface MarathonSeed {
  chapterKey: string
  seriesKey: string
  activeKey: string
  pageId: string
  offsetRatio: number
  blocks: number
  chapterIdx: number
}

export function useModeSwitch(
  chapterId: string,
  targetBlock?: { chapterId: string } | null,
) {
  const navigate = useNavigate()
  const { save } = useProgress()
  const { save: saveMarathon } = useMarathonMemory()

  const gotoMarathon = useCallback(
    (seed?: MarathonSeed) => {
      if (seed) saveMarathon(seed)
      navigate(marathonHref(chapterId))
    },
    [chapterId, saveMarathon, navigate],
  )

  const gotoReader = useCallback(
    (prog?: Omit<ProgressEntry, 'at'>, chapterIdOverride?: string) => {
      if (prog) save(prog)
      navigate(readerHref(chapterIdOverride ?? targetBlock?.chapterId ?? chapterId))
    },
    [chapterId, targetBlock, save, navigate],
  )

  return { gotoMarathon, gotoReader }
}
