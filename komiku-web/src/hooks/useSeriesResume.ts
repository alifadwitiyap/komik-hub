import { useMemo } from 'react'
import { marathonHref } from '../readerSource'
import {
  resolveResumeTarget,
  resumeLabel,
  resumeSourceNotice,
  sourceOfChapterKey,
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
  /** "Chapter X · sumber" — label yang SAMA dipakai Home/Rak/detail. */
  label: string | null
  /** "dari sumber" bila halaman ini dibuka dari sumber lain. */
  sourceNotice: string | null
  /** true bila progres tersimpan berasal dari sumber lain dari halaman ini. */
  crossSource: boolean
}

/**
 * Logika "lanjut baca" + maraton untuk halaman series (dulu diulang di
 * Series/SeriesUnified/ContinueReading/Home-FAB). Progres adalah per identitas
 * series dengan kunci chapter string persis; `isValidResume` hanya menolak
 * series lain, tidak boleh menjatuhkan chapter dari sumber lain.
 *
 * `currentSource` opsional dipakai halaman unified untuk menandai bahwa CTA
 * sedang dibuka dari sumber lain (`crossSource`/`sourceNotice`) tanpa pernah
 * mengganti `href`/`chapterId` ke chapter lokal paling awal.
 */
export function useSeriesResume(
  seriesId: string,
  isValidResume?: (chapterId: string) => boolean,
  currentSource?: string | null,
): SeriesResume {
  const { recent } = useProgress()
  const marathonMemory = useMarathonMemory()
  const resume = recent.find((r) => String(r.seriesId) === String(seriesId))
  const rawKey = resume ? String(resume.chapterId) : null
  const source = resume?.source ?? sourceOfChapterKey(rawKey)
  const crossSource = !!currentSource && !!source && currentSource.trim() !== source.trim()
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
  const label = target
    ? resumeLabel({ chapterId: target.chapterId, source: target.source, chapterName: resume?.chapterName })
    : null
  return {
    resume,
    marathonPos,
    resumeKey,
    resumeHref: href,
    marathonHref: marathonPos ? marathonHref(marathonPos.chapterKey) : null,
    target,
    continueHref: href,
    label,
    sourceNotice: target ? resumeSourceNotice({ ...target, sourceChanged: target.sourceChanged || crossSource }) : null,
    crossSource: crossSource || !!target?.sourceChanged,
  }
}
