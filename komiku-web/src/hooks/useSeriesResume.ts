import { useMemo } from 'react'
import { marathonHref } from '../readerSource'
import {
  resolveResumeTarget,
  type ResumeTarget,
} from '../progressResume'
import { useMarathonMemory } from './useMarathonMemory'
import { useProgress } from './useProgress'
import type { ProgressEntry } from './useProgress'
import type { MarathonPosition } from '../marathonMemory'

export interface SeriesResume {
  /** Entri riwayat "lanjut baca" untuk series ini (mungkin tak ada). */
  resume: ProgressEntry | undefined
  /** Sesi maraton tersimpan untuk series ini (mungkin tak ada). */
  marathonPos: MarathonPosition | null
  /** Kunci chapter resume (`sumber:native_id:nomor` / id angka). null kalau tak sah. */
  resumeKey: string | null
  /** URL reader untuk resume; null kalau tanpa resume sah untuk series ini. */
  resumeHref: string | null
  /** URL maraton untuk sesi tersimpan; null kalau tanpa sesi. */
  marathonHref: string | null
  /**
   * Spec §1: satu target kanonik yang dipakai Beranda/Rak/detail. Berisi
   * chapter (string), mode, page, pageId, offsetRatio, dan sourceChanged.
   */
  target: ResumeTarget | null
  /** URL final ke reader ATAU maraton sesuai `target.mode`. */
  continueHref: string | null
}

/**
 * Logika "lanjut baca" + maraton untuk halaman series (dulu diulang di
 * Series/SeriesUnified/ContinueReading/Home-FAB). Mengambil seriesId/handle,
 * mengembalikan target link reader-resume + tombol maraton.
 *
 * `isValidResume` opsional menolak resume milik series lain (unified: kunci
 * chapter harus diawali "handle:"). Default: resume apa pun untuk series ini
 * dianggap sah.
 */
export function useSeriesResume(
  seriesId: string,
  isValidResume?: (chapterId: string) => boolean,
): SeriesResume {
  const { recent } = useProgress()
  const marathonMemory = useMarathonMemory()
  const resume = recent.find((r) => String(r.seriesId) === String(seriesId))
  const rawKey = resume ? String(resume.chapterId) : null
  const resumeKey = rawKey && (isValidResume?.(rawKey) ?? true) ? rawKey : null
  const marathonPos = seriesId ? marathonMemory.forHandle(String(seriesId)) : null
  const target = useMemo(
    () => resolveResumeTarget(resume, marathonPos, isValidResume),
    [resume, marathonPos, isValidResume],
  )
  // `resumeHref` dan `continueHref` SAMA-sama memakai target kanonik: Semua
  // entry point lama (Series/SeriesUnified yang memakai resumeHref) otomatis
  // dapat chapter/mode/page yang sama dengan Beranda/Rak tanpa diedit.
  const href = target ? target.href : null
  return {
    resume,
    marathonPos,
    resumeKey,
    resumeHref: href,
    marathonHref: marathonPos ? marathonHref(marathonPos.chapterKey) : null,
    target,
    continueHref: href,
  }
}
