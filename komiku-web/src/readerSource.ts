import { api, unifiedApi } from './api'
import type {
  Chapter,
  ChapterResponse,
  ChapterNav,
  Manga,
  MangaOut,
  UnifiedChapter,
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
 *
 * `mode` menentukan tujuan: `reader` (default) membuka reader satu chapter,
 * `marathon` membuka mode maraton di chapter yang sama. Maraton dipakai kalau
 * sesi terakhir pembaca untuk series itu memang maraton — kalau tidak, orang
 * yang sedang maraton dilempar ke reader biasa dan rantainya putus.
 */
export function resumeHref(
  entry: { handle: string; last_chapter: string } | null | undefined,
  mode: 'reader' | 'marathon' = 'reader',
): string | null {
  if (!entry || !entry.handle || !entry.last_chapter) return null
  const key = `${entry.handle}:${entry.last_chapter}`
  return mode === 'marathon' ? marathonHref(key) : readerHref(key)
}

/**
 * URL "lanjut" untuk sebuah kunci chapter yang sudah diketahui (dipakai halaman
 * series, yang punya kunci chapter persis dari progress). Sama seperti
 * `resumeHref`, `mode` menentukan reader atau maraton.
 */
export function chapterResumeHref(
  key: string | null | undefined,
  mode: 'reader' | 'marathon' = 'reader',
): string | null {
  if (!key) return null
  return mode === 'marathon' ? marathonHref(key) : readerHref(key)
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
    image_sizes?: [number, number][] | null
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
    image_sizes: u.image_sizes ?? null,
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

/**
 * Respons chapter unified + `series_title`. Field ini dikirim server (lihat
 * `u_chapter` di unified.rs) tapi belum ada di tipe `UnifiedChapter`, jadi
 * dideklarasikan lokal di sini supaya perubahan tetap satu file.
 */
type ChapterWithSeriesTitle = UnifiedChapter & { series_title?: string | null }

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
 * Snapshot series MINIMAL dari respons chapter — dipakai saat `/unified/series`
 * belum (atau tidak pernah) tiba. Judul & title_key sudah ikut di respons
 * chapter, jadi toolbar dan riwayat rak tetap benar tanpa request kedua;
 * `cover_url` satu-satunya yang belum ada (menyusul lewat cache).
 */
function liteFromChapter(ch: ChapterWithSeriesTitle, handle: string): SeriesLite {
  const title = (ch.series_title ?? '').trim()
  return {
    // handle mentah ('komiku:123') jangan sampai jadi judul kalau server
    // mengirim series_title kosong — itu perilaku lama saat series gagal.
    title: title || handle,
    title_key: ch.title_key ?? '',
    // Server saat ini belum mengirim cover_url di respons chapter (hanya di
    // /unified/series), tapi tipenya sudah ada — pakai kalau nanti tersedia.
    cover_url: ch.cover_url ?? null,
  }
}

/**
 * Request `/unified/series` yang sedang jalan, per handle. Snapshot series
 * dimuat di BELAKANG render (lihat `loadChapter`), jadi beberapa chapter yang
 * dibuka berurutan / di-prefetch bisa meminta handle yang sama bersamaan —
 * peta ini menyatukannya jadi satu request.
 */
const liteInflight = new Map<string, Promise<SeriesLite | null>>()

/**
 * Muat snapshot series di latar belakang lalu simpan ke `liteCache`.
 * Tidak pernah melempar (gagal = `null`) dan sengaja TIDAK memakai
 * `AbortSignal` pemanggil: hasilnya masuk cache tingkat modul yang hidup
 * lebih lama dari satu pemanggilan, jadi membatalkannya saat user pindah
 * chapter hanya membuang kerja yang tetap berguna untuk chapter berikutnya.
 */
function backgroundSeriesLite(handle: string): Promise<SeriesLite | null> {
  const running = liteInflight.get(handle)
  if (running) return running
  const job = unifiedApi
    .series(handle)
    .then((s: UnifiedSeries) => {
      const lite = liteOfSeries(s)
      rememberSeriesLite(handle, lite)
      return lite
    })
    // judul gagal: chapter tetap harus tampil (jangan gagalkan baca)
    .catch(() => null)
    .finally(() => liteInflight.delete(handle))
  liteInflight.set(handle, job)
  return job
}

/**
 * Muat chapter dari flow yang tepat.
 *
 * Snapshot series TIDAK lagi ada di jalur kritis. Dulu keduanya di-`await`
 * bersamaan (`Promise.all([chapter, series])`), padahal `/unified/series`
 * membawa ~82 KB dan cold 1,5–2 s — jauh lebih lambat dari chapter — sehingga
 * halaman pertama tertunda tanpa manfaat: judul, `title_key`, dan handle sudah
 * ikut di respons chapter. Sekarang chapter di-`await` sendirian, series
 * menyusul di latar belakang dan mengisi cache untuk chapter berikutnya.
 *
 * Konsekuensi yang diterima: `cover_url` belum ada pada render pertama (hanya
 * dipakai sampul riwayat rak); nilai itu terisi begitu request series selesai
 * atau saat halaman series dibuka lebih dulu (SeriesUnified mengisi cache).
 */
export async function loadChapter(
  key: string,
  signal?: AbortSignal,
): Promise<ChapterResponse> {
  const u = parseUnifiedKey(key)
  if (!u) return api.chapter(key, signal)
  // Mulai lebih dulu supaya berjalan PARALEL dengan chapter (bukan sesudahnya),
  // lalu jangan ditunggu.
  if (!liteCache.get(u.handle)?.title) void backgroundSeriesLite(u.handle)
  const ch = (await unifiedApi.chapter(
    u.handle,
    u.number,
    signal,
  )) as ChapterWithSeriesTitle
  // Cache dulu (diisi halaman series / chapter sebelumnya); kalau kosong,
  // susun dari respons chapter supaya toolbar tak menampilkan handle mentah.
  // `title_key` chapter menang atas cache yang kosong: entri cache bisa dibuat
  // `rememberSeriesTitle` tanpa title_key, dan title_key kosong membuat rak
  // serta mark "sudah dibaca" tidak pernah tercatat (gagal senyap).
  const cached = liteCache.get(u.handle)
  const lite: SeriesLite = cached
    ? { ...cached, title_key: cached.title_key || (ch.title_key ?? '') }
    : liteFromChapter(ch, u.handle)
  return fromUnified(ch, u.handle, lite)
}
