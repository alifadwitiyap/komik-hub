import type { ProgressEntry } from './hooks/useProgress'
import type { MarathonPosition } from './marathonMemory'
import { clamp01 } from './pageMemory'
import {
  marathonHref,
  readerHref,
  toChapterId,
  type ReadingMode,
} from './readerSource'

/**
 * Kontrak restore (spec §1 P0): satu objek target yang dipakai Beranda, Rak,
 * detail, Reader, dan ReaderMarathon. Semua field chapter adalah STRING persis
 * — `toChapterId` tidak pernah mengubah "0" jadi "00.1" atau sebaliknya.
 *
 * `page` 0-based, `pageId` URL gambar (identity halaman), `offsetRatio` 0..1
 * posisi relatif di dalam gambar. `sourceChanged` true bila location aktif
 * berbeda sumber dengan progres tersimpan dan pemetaan halaman tidak tersedia
 * → pemanggil HARUS membuka awal chapter (page 0) dan menjelaskan ke pengguna.
 */
export interface ResumeTarget {
  chapterId: string
  mode: ReadingMode
  page: number
  pageId: string | null
  offsetRatio: number
  source: string | null
  sourceChanged: boolean
  /** URL final (reader atau maraton) sesuai `mode`. */
  href: string
  /** false bila data lama hanya punya nomor chapter → mulai awal chapter. */
  hasExactPage: boolean
}

/** Entri progres lama: nomor chapter saja, tanpa pageId/anchor presisi. */
export function isLegacyProgress(entry: ProgressEntry | null | undefined): boolean {
  if (!entry) return false
  if (!entry.pageId && !entry.offsetRatio && entry.progress <= 0) return true
  return entry.page === 0 && !entry.pageId
}

/** Sumber dari key unified `sumber:id:...`; null untuk flow legacy. */
export function sourceOfChapterKey(chapterId: string | null | undefined): string | null {
  if (!chapterId) return null
  const head = toChapterId(chapterId).split(':', 1)[0]
  return head || null
}

/**
 * Tampilan chapter + sumber yang sama persis di Beranda/Rak/detail.
 * `chapterLabel` memakai `chapterName` tersimpan (bisa "Chapter 811 Fix"),
 * sedangkan `chapterId` tetap dipertahankan apa adanya untuk link/href.
 */
export function resumeLabel(target: Pick<ResumeTarget, 'chapterId' | 'source'> & { chapterName?: string | null }): string {
  const chapter = target.chapterName?.trim() || `Chapter ${target.chapterId.split(':').pop() ?? target.chapterId}`
  const source = target.source?.trim()
  return source ? `${chapter} · ${source}` : chapter
}

/** Kata "dari SUMBER" untuk menjelaskan progres lintas sumber di CTA. */
export function resumeSourceNotice(target: Pick<ResumeTarget, 'source' | 'sourceChanged'>): string | null {
  if (!target.sourceChanged || !target.source?.trim()) return null
  return `dari ${target.source.trim()}`
}

/**
 * Pilih satu target dari progres tersimpan + sesi maraton.
 * Aturan prioritas: mode terakhir yang disimpan (`entry.mode`) menang; entri
 * lama tanpa mode memakai keberadaan `MarathonPosition` sebagai fallback.
 * `isValidResume` (opsional) menolak chapter yang bukan milik series tujuan.
 * Jangan pakai validator yang membatasi sumber: aturan lintas-sumber ada di
 * `sourceChanged` + label, bukan dengan membuang progres tersimpan.
 */
export function resolveResumeTarget(
  entry: ProgressEntry | null | undefined,
  marathonPos: MarathonPosition | null | undefined,
  isValidResume?: (chapterId: string) => boolean,
  location?: { chapterId?: string | null; source?: string | null; handle?: string | null } | null,
): ResumeTarget | null {
  if (!entry) return null
  const chapterId = toChapterId(entry.chapterId)
  if (!chapterId || (isValidResume && !isValidResume(chapterId))) return null

  // Spec §6: data lama bernomor saja → mulai dari awal chapter itu.
  const legacy = isLegacyProgress(entry)
  const mode: ReadingMode = entry.mode === 'marathon' || (!entry.mode && marathonPos)
    ? 'marathon'
    : 'normal'
  const page = legacy ? 0 : Math.max(0, Math.floor(Number(entry.page) || 0))
  const offsetRatio = legacy ? 0 : clamp01(Number(entry.offsetRatio) || 0)

  // Spec §7: pindah sumber → coba petakan halaman setara (pageId persis di
  // location), kalau tidak ada → page 0 + sourceChanged=true.
  const locSource = location?.source ?? null
  const savedSource = entry.source ?? null
  const normalizedLoc = locSource ? String(locSource).trim() : null
  const normalizedSaved = savedSource ? String(savedSource).trim() : null
  const sourceChanged = !!normalizedLoc && !!normalizedSaved && normalizedLoc !== normalizedSaved
  const sameLocation = !location || !location.chapterId || toChapterId(location.chapterId) === chapterId
  const finalPage = sourceChanged || !sameLocation ? 0 : page
  const finalOffset = sourceChanged || !sameLocation ? 0 : offsetRatio

  return {
    chapterId,
    mode,
    page: finalPage,
    // pageId dipertahankan walau sourceChanged: `canRestorePage` yang memutus
    // apakah URL gambar itu masih ada di sumber baru (pemetaan setara).
    pageId: legacy ? null : entry.pageId ?? null,
    offsetRatio: finalOffset,
    source: savedSource,
    sourceChanged,
    href: mode === 'marathon' ? marathonHref(chapterId) : readerHref(chapterId),
    hasExactPage: !legacy,
  }
}

/**
 * Callable restore untuk Reader/ReaderMarathon: cek apakah `target.pageId`
 * benar-benar ada di daftar URL gambar lokasi saat ini. Mengembalikan index
 * halaman bila bisa dipulihkan persis, null bila harus mulai dari `target.page`
 * (atau 0 bila `sourceChanged`).
 *
 * `canRestorePage` = true bila chapter cocok DAN halaman bisa dipetakan:
 * pageId persis ada di daftar gambar lokasi (pemetaan lintas sumber berhasil),
 * atau — untuk data lama tanpa pageId — nomor halaman masih valid.
 *
 * Kontrak untuk pemanggil: bila false, buka `target.page` (0 bila
 * `sourceChanged`) dan tampilkan penjelasan pergantian sumber bila
 * `target.sourceChanged`. Jangan tunggu gambar load untuk menandai selesai.
 */
export function canRestorePage(
  target: ResumeTarget | null | undefined,
  location: { chapterId?: string | null; source?: string | null } | null | undefined,
  imageUrls: readonly string[],
): boolean {
  if (!target || !location) return false
  if (toChapterId(location.chapterId) !== target.chapterId) return false
  if (target.pageId) return imageUrls.includes(target.pageId)
  if (target.sourceChanged) return false
  return target.page >= 0 && target.page < imageUrls.length
}
