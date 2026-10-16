import { api, unifiedApi } from './api'
import type {
  Chapter,
  ChapterResponse,
  ChapterNav,
  Manga,
  MangaOut,
  UnifiedSeries,
} from './types'

/**
 * Jembatan dua flow baca tanpa menduplikasi komponen Reader.
 *
 * Kunci chapter ("chapter key"):
 *   - komiku lama : id numerik apa adanya, mis. "6427"
 *   - unified     : "sumber:native_id:nomor", mis. "komiku:1234:57"
 *
 * Nomor chapter adalah STRING (bisa "1195", "1.5", "extra-9") — jadi pemisahan
 * pakai ":" (tidak mungkin ada di nomor) dan bagian akhir tidak pernah
 * diparse jadi number. Semua yang berbasis kunci (progress, anchor posisi,
 * offline manifest) memakai bentuk yang sama, jadi riwayat baca campuran dua
 * flow tetap nyambung.
 */

/**
 * Data series per handle — diisi sekali, dipakai lintas chapter maraton
 * DAN oleh rak (title_key untuk favorit/sejarah LINTAS-SUMBER).
 */
export interface SeriesLite {
  title: string
  title_key: string
  cover_url: string | null
}

const liteCache = new Map<string, SeriesLite>()

/** Simpan snapshot series per handle (judul + title_key + sampul). */
export function rememberSeriesLite(handle: string, lite: SeriesLite): void {
  if (handle && lite.title) liteCache.set(handle, lite)
}

/** Judul manga per handle — kompatibilitas (SeriesUnified memakainya). */
export function rememberSeriesTitle(handle: string, title: string): void {
  if (!handle || !title) return
  const existing = liteCache.get(handle)
  liteCache.set(handle, {
    title,
    title_key: existing?.title_key ?? '',
    cover_url: existing?.cover_url ?? null,
  })
}

/** "sumber:native_id:nomor" → { handle, number }. null kalau kunci komiku lama. */
export function parseUnifiedKey(
  key: string,
): { handle: string; number: string } | null {
  const i = key.lastIndexOf(':')
  if (i <= 0) return null
  return { handle: key.slice(0, i), number: key.slice(i + 1) }
}

/** Bangun kunci chapter unified. */
export function unifiedKey(handle: string, number: string): string {
  return `${handle}:${number}`
}

/** Gabung param route (bentuk lama atau handle+nomer) jadi satu kunci. */
export function chapterKeyOf(
  chapterId: string | undefined,
  handle: string | undefined,
  number: string | undefined,
): string {
  if (handle && number) return unifiedKey(handle, number)
  return chapterId ?? ''
}

/** URL halaman baca untuk sebuah kunci chapter. */
export function readerHref(key: string): string {
  const u = parseUnifiedKey(key)
  return u ? `/baca/${u.handle}/${u.number}` : `/baca/${key}`
}

/** URL halaman maraton untuk sebuah kunci chapter. */
export function marathonHref(key: string): string {
  const u = parseUnifiedKey(key)
  return u ? `/maraton/${u.handle}/${u.number}` : `/maraton/${key}`
}

/** URL halaman detail manga: handle unified atau id komiku lama. */
export function seriesHref(seriesId: string | number | null | undefined): string | null {
  if (seriesId == null || seriesId === '') return null
  return `/manga/${seriesId}`
}

/**
 * URL untuk FAB "Lanjut baca" dari entri sejarah rak. Null kalau rak kosong
 * (atau entri tak lengkap) → FAB disembunyikan. Dipisah dari komponen supaya
 * aturan "kosong → sembunyi" bisa diuji tanpa render.
 */
export function resumeHref(
  entry: { handle: string; last_chapter: string } | null | undefined,
): string | null {
  if (!entry || !entry.handle || !entry.last_chapter) return null
  return readerHref(`${entry.handle}:${entry.last_chapter}`)
}

function chapterEntry(handle: string, number: string): Chapter {
  return {
    id: unifiedKey(handle, number),
    name: `Chapter ${number}`,
    number,
    handle,
    source: handle.split(':')[0],
  }
}

/**
 * Adaptor respons unified → bentuk `ChapterResponse` yang sudah dipakai
 * Reader/ReaderMarathon. Membuat adapter (bukan komponen reader duplikat)
 * berarti SEMUA fitur reader — anchor posisi, maraton, sheet download,
 * preferensi, prefetch SW — otomatis jalan untuk sumber non-komiku.
 *
 * `lite` = snapshot series dari panggilan /unified/series yang SUDAH dilakukan
 * loadChapter (hemat request) — membawa title_key untuk rak.
 */
function fromUnified(
  u: {
    title: string
    number: string
    images: string[]
    prev: ChapterNav | null
    next: ChapterNav | null
    source: string
    switched_from?: string
    note?: string
  },
  handle: string,
  lite: SeriesLite | null,
): ChapterResponse {
  const series: Manga = {
    // seriesId memakai handle yang diminta (route asal) → riwayat "lanjut baca"
    // nyambung ke halaman series per sumber, bukan numpuk di satu id komiku.
    id: handle,
    title: lite?.title ?? handle,
    // sumber yang MELAYANI halaman ini (bisa beda dari handle saat fallback)
    source: u.source,
    cover: lite?.cover_url ?? null,
  }
  const nav = (n: ChapterNav | null): Chapter | null =>
    n == null ? null : chapterEntry(n.handle, n.number)
  return {
    chapter: {
      id: unifiedKey(handle, u.number),
      name: u.title || `Chapter ${u.number}`,
      number: u.number,
      source: u.source,
      handle,
      previous: nav(u.prev),
      next: nav(u.next),
    },
    images: u.images ?? [],
    series,
    source: u.source,
    switched_from: u.switched_from ?? null,
    note: u.note ?? null,
    // rak (favorit/sejarah) lintas-sumber: title_key dari server
    title_key: lite?.title_key || undefined,
    series_handle: handle,
    series_cover: lite?.cover_url ?? null,
  }
}

/** Snapshot series dari respons unified (judul + title_key + sampul). */
export function liteOfSeries(s: UnifiedSeries): SeriesLite {
  const m = s.manga as MangaOut
  return {
    title: m.title,
    title_key: m.title_key ?? '',
    cover_url: m.cover_url ?? null,
  }
}

/**
 * Muat chapter dari flow yang tepat. Judul/title_key manga hanya di-fetch
 * sekali per handle (paralel, lalu dicache) supaya toolbar + riwayat tetap
 * informatif tanpa menambah latency berarti untuk chapter berikutnya.
 */
export async function loadChapter(
  key: string,
  signal?: AbortSignal,
): Promise<ChapterResponse> {
  const u = parseUnifiedKey(key)
  if (!u) return api.chapter(key, signal)
  const cached = liteCache.get(u.handle)
  const liteJob: Promise<SeriesLite | null> = cached?.title
    ? Promise.resolve(cached)
    : unifiedApi
        .series(u.handle, signal)
        .then((s: UnifiedSeries) => {
          const lite = liteOfSeries(s)
          rememberSeriesLite(u.handle, lite)
          return lite
        })
        // judul gagal: chapter tetap harus tampil (jangan gagalkan baca)
        .catch(() => null)
  const [ch, lite] = await Promise.all([
    unifiedApi.chapter(u.handle, u.number, signal),
    liteJob,
  ])
  return fromUnified(ch, u.handle, lite)
}
