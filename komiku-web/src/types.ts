/** Tipe data sesuai bentuk JSON yang dikeluarkan `komiku-server` (Rust). */

/** Baris daftar (kartu beranda, hasil pencarian): tipe/status sudah diratakan
 *  menjadi array string agar UI tidak perlu tahu bentuk mentahnya. */
export interface Manga {
  /** id numerik komiku, atau handle 'sumber:native_id' untuk kartu unified. */
  id: number | string
  title: string
  title_alt?: string | null
  score?: string | null
  author?: string | null
  update_date?: string | null
  total_views?: string | null
  thumbnail?: string | null
  cover?: string | null
  tipe?: string[] | null
  status?: string[] | null
  other?: string[] | null
  /** Kartu berasal dari sumber non-komiku → kartu menautkan route handle. */
  handle?: string | null
  /** Nama sumber (komiku/kiryuu/…) — dipakai badge sumber di kartu. */
  source?: string | null
  /** Judul ter-normalisasi (identitas lintas-sumber) — hanya kartu unified. */
  title_key?: string | null
}

// ---------------------------------------------------------------------------
// Unified multi-source (kontrak /api/unified/*) — lien server paralel.
// Handle bentuk 'sumber:native_id' (mis. 'komiku:1234', 'kiryuu:abc').
// ---------------------------------------------------------------------------

/** Satu manga dari sumber mana pun, diratakan supaya UI tidak beda bentuk. */
export interface MangaOut {
  source: string
  native_id: string
  /** 'sumber:native_id' — dipakai untuk route /manga/:handle & /baca/:handle/:n */
  handle: string
  title: string
  cover_url: string | null
  author: string | null
  status: string | null
  manga_type: string | null
  /** string sesuai server (bisa "-" atau "9.1") */
  rating: string | null
  last_chapter: string | null
  /** epoch millis (server kirim Option<i64>) */
  updated_at: number | null
  url: string | null
  /** judul ter-normalisasi (server) — kunci favorit/sejarah LINTAS-SUMBER */
  title_key: string
}

/** search / popular / latest / catalogue punya bentuk identik. */
export interface UnifiedListResult {
  items: MangaOut[]
  /** sumber yang gagal di-scrape pada panggilan ini */
  failed_sources: string[]
  /** hasil dilayani dari cache server (bukan scrape baru) */
  from_cache?: boolean
}

export interface UnifiedGenre {
  slug: string
  name: string
  sources: string[]
}

/** Baris daftar chapter di respons series.
 *  CATATAN: `number` sesuai server adalah STRING (bisa "1195", "1.5",
 *  "extra-9"), jadi jangan dipaksa number di web. */
export interface UnifiedChapterOut {
  number: string
  title: string
  native_id: string
  updated_at: number | null
}

export interface UnifiedSeries {
  manga: MangaOut
  /** urut sesuai server; diurutkan terbaru → terlama oleh UI */
  chapters: UnifiedChapterOut[]
  source: string
  failed_sources: string[]
}

/** Pointer prev/next lintas-sumber — handle sudah 'sumber:native_id'. */
export interface ChapterNav {
  number: string
  source: string
  handle: string
}

/** Halaman chapter — kontrak /api/unified/chapter/{handle}/{number} v2.
 *  `prev`/`next` = objek navigasi (bisa lintas sumber) atau null.
 *  `switched_from` ada kalau sumber di-fallback (nilai = sumber asal).
 *  `note` = pesan ramah untuk ditampilkan 1 baris di reader. */
export interface UnifiedChapter {
  title: string
  number: string
  source: string
  images: string[]
  prev: ChapterNav | null
  next: ChapterNav | null
  switched_from?: string
  note?: string
  /** judul ter-normalisasi series pemilik chapter ini */
  title_key: string
  handle: string
  cover_url: string | null
}

/** Satu item unduhan (kontrak GET /api/unified/downloads). */
export interface DownloadItem {
  id: string
  handle: string
  number: string
  title: string
  series_title: string
  filename: string
  size_bytes: number
  downloaded_at: number | null
  last_opened_at: number | null
}

export interface DownloadsResponse {
  items: DownloadItem[]
  total_bytes: number
  limit_bytes: number
}

/** Catatan eviction otomatis (kontrak GET /api/unified/evictions). */
export interface EvictionItem {
  series_title: string
  chapter_title: string
  size_bytes: number
  evicted_at: number | null
}

export interface EvictionsResponse {
  items: EvictionItem[]
}

/** Satu baris GET /api/unified/health (kontrak lane server paralel — probe
 *  live per sumber, TIDAK di-cache server). */
export interface SourceHealthRow {
  source: string
  /** nama tampil dari server; BOLEH absen → UI turunkan dari `source`. */
  label?: string
  ok: boolean
  latency_ms?: number | null
  error?: string | null
}

export interface SourceHealth {
  total: number
  healthy: number
  /** epoch millis probe terakhir */
  checked_at_ms?: number | null
  sources: SourceHealthRow[]
}

export interface DownloadPdfResult {
  id: string
  filename: string
  title: string
  series_title: string
  size_bytes: number
}

export interface HomeSection {
  title: string
  more?: string | null
  data: Manga[]
}

export interface Homepage {
  success: boolean
  [key: string]: HomeSection | boolean
}

export interface SearchResult {
  page: number
  count: number
  manga: Manga[]
}

export interface Chapter {
  name: string
  id: number | string
  number?: string | number | null
  date?: string | null
  /** sumber melayani (unified flow) — chapter prev/next bisa lintas sumber */
  source?: string | null
  /** handle 'sumber:native_id' sumber yang melayani chapter ini */
  handle?: string | null
}

/** Detail manga: taksonomi masih berupa objek {name,id}, belum diratakan. */
export interface SeriesDetail {
  id: number | string
  title: string
  /** judul ter-normalisasi (server) — identitas rak favorit/sejarah.
   *  Ada di flow Komiku lama SEKARANG (server menyuntiknya, normalisasi
   *  tetap di Rust — jangan hitung ulang di JS). */
  title_key?: string | null
  title_alt?: string | null
  score?: string | null
  author?: string | null
  date?: string | null
  total_views?: string | null
  thumbnail?: string | null
  cover?: string | null
  previews?: string[]
  synopsis?: string | null
  summary?: string[] | null
  background?: string | null
  genre?: { name: string; id: string }[]
  genreutama?: { name: string; id: string }[]
  statusmanga?: { name: string; id: string }[]
  tipe?: { name: string; id: string }[]
  other?: { name: string; id: string }[]
}

export interface ChapterResponse {
  chapter: {
    id: number | string
    name: string
    number?: string | number | null
    date?: string | null
    views?: string | null
    previous: Chapter | null
    next: Chapter | null
    /** unified: sumber yang melayani chapter ini */
    source?: string
    /** unified: handle 'sumber:native_id' chapter ini */
    handle?: string
  }
  images: string[]
  series: Manga | null
  /** unified: sumber yang benar-benar melayani halaman ini */
  source?: string
  /** unified: sumber asal sebelum fallback (ada kalau terjadi perpindahan) */
  switched_from?: string | null
  /** unified: pesan pindah sumber dari server untuk ditampilkan di reader */
  note?: string | null
  /**
   * unified: judul ter-normalisasi series (dari server) — kunci rak
   * favorit/sejarah LINTAS-SUMBER. Hanya ada di flow unified; flow Komiku
   * lama (id angka) tidak memakainya.
   */
  title_key?: string
  /** unified: handle series ('sumber:native_id') pemilik chapter ini */
  series_handle?: string
  /** unified: sampul series untuk snapshot rak */
  series_cover?: string | null
}

export interface CategoryGroup {
  category: { id: string; name: string }
  items: { id: string; name: string }[]
}
