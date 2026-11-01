import { readerHref, marathonHref } from '../readerSource'
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
  return {
    resume,
    marathonPos,
    resumeKey,
    resumeHref: resumeKey ? readerHref(resumeKey) : null,
    marathonHref: marathonPos ? marathonHref(marathonPos.chapterKey) : null,
  }
}
