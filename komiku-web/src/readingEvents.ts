import type { ChapterResponse } from './types'
import { chapterNumberOf, markChapterRead } from './readMarks'
import * as rakStore from './rakStore'

/**
 * readingEvents.ts — koordinator "chapter dibuka" (K2).
 *
 * Memusatkan satu definisi apa artinya membuka sebuah chapter: menandai
 * "sudah dibaca" (per akun) + mencatat ke riwayat rak (lintas-sumber via
 * title_key). Sebelumnya kedua efek samping itu tersebar & divergen:
 * Reader menulisnya saat fetch resolve, ReaderMarathon menulis mark saat
 * blok baca berganti dan rak di dalam efek progress.
 *
 * `rakMangaOf` (snapshot rak) dipindah ke sini dari Reader.tsx supaya
 * catatan sejarah rak identik dari mana pun chapter dibuka. Reader tetap
 * re-export `rakMangaOf` untuk kompatibilitas (HeartButton + wiring-check).
 */

/** Snapshot series untuk rak — satu definisi (dulu di Reader.tsx). */
export function rakMangaOf(
  d: ChapterResponse,
  titleKey: string,
): rakStore.RakManga & { title_key: string } {
  return {
    title_key: titleKey,
    title: d.series?.title ?? d.chapter.name,
    cover_url: d.series_cover ?? d.series?.cover ?? null,
    handle: d.series_handle ?? '',
    source: d.source ?? d.series?.source ?? '',
  }
}

export interface ChapterOpen {
  /** title_key seri — syarat mark & rak */
  titleKey?: string | null
  /** nomor chapter untuk mark "sudah dibaca" */
  number?: string | null
  /**
   * Nomor yang dicatat ke riwayat rak. Default = `number`. Reader memakai
   * `chapter.number` mentah (skip kalau null); Marathon memakai `number` dengan
   * fallback chapterId.
   */
  historyNumber?: string | null
  /** judul seri/chapter untuk snapshot rak */
  title?: string
  /** sampul untuk snapshot rak */
  coverUrl?: string | null
  /** sumber untuk snapshot rak */
  source?: string
  /** handle seri — syarat rak */
  handle?: string
}

export interface DidOpenChapterOptions {
  /** hanya tandai baca, tanpa catat rak (Marathon: efek blok baca aktif) */
  markOnly?: boolean
  /** hanya catat rak, tanpa tandai baca (Marathon: efek progress) */
  rakOnly?: boolean
}

/**
 * Koordinator "chapter dibuka". Dipanggil oleh Reader (penuh) dan
 * ReaderMarathon (sebagian via `markOnly`/`rakOnly`, karena dua event-nya
 * memang terpisah: blok aktif vs progress bawah).
 */
export function didOpenChapter(d: ChapterOpen, opts?: DidOpenChapterOptions): void {
  const { markOnly = false, rakOnly = false } = opts ?? {}
  if (!rakOnly) markChapterRead(d.titleKey, d.number)
  if (markOnly) return

  const historyNumber = d.historyNumber ?? d.number
  if (d.titleKey && d.handle && historyNumber) {
    rakStore.recordRead(
      {
        title_key: d.titleKey,
        title: d.title ?? '',
        cover_url: d.coverUrl ?? null,
        handle: d.handle,
        source: d.source ?? '',
      },
      historyNumber,
    )
  }
}

// Re-export kegunaan internal (chapterNumberOf dipakai oleh Reader).
export { chapterNumberOf }
