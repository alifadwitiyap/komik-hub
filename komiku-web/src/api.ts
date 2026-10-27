import type {
  CategoryGroup,
  Chapter,
  ChapterResponse,
  DownloadPdfResult,
  DownloadsResponse,
  Homepage,
  Manga,
  MangaOut,
  SearchResult,
  SeriesDetail,
  SourceHealth,
  UnifiedChapter,
  UnifiedGenre,
  UnifiedListResult,
  UnifiedSeries,
} from './types'

const BASE = '/api'

/**
 * Header akun. Semua request menyisipkan `X-Komik-User` kalau user sudah
 * masuk; server membalas 401 kalau header ini hilang di endpoint ber-scope
 * akun. Import statis (bukan dynamic) supaya tidak ada await di jalur panas.
 */
import { getUser } from './account'

function accountHeaders(base?: Record<string, string>): Record<string, string> | undefined {
  const u = getUser()
  if (!u) return base
  return { ...(base ?? {}), 'X-Komik-User': u }
}

async function get<T>(path: string, signal?: AbortSignal): Promise<T> {
  const res = await fetch(`${BASE}${path}`, { signal, headers: accountHeaders() })
  if (!res.ok) {
    // server mengirim { error, hint } — tampilkan itu, bukan stack mentah
    let detail = `HTTP ${res.status}`
    try {
      const body = (await res.json()) as { error?: string; hint?: string }
      if (body.error) detail = body.error
      if (body.hint) detail += ` — ${body.hint}`
    } catch {
      /* body bukan JSON */
    }
    throw new Error(detail)
  }
  return (await res.json()) as T
}

/** PUT/POST/DELETE dengan body JSON opsional. 4xx tetap dilempar sebagai Error. */
async function send<T>(
  method: string,
  path: string,
  body?: unknown,
  signal?: AbortSignal,
): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method,
    signal,
    headers: accountHeaders(
      body === undefined ? undefined : { 'content-type': 'application/json' },
    ),
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  if (!res.ok) {
    let detail = `HTTP ${res.status}`
    try {
      const b = (await res.json()) as { error?: string; hint?: string }
      if (b.error) detail = b.error
      if (b.hint) detail += ` — ${b.hint}`
    } catch {
      /* body bukan JSON */
    }
    throw new Error(detail)
  }
  const text = await res.text()
  return (text ? JSON.parse(text) : {}) as T
}

/**
 * Handle unified 'sumber:native_id' mungkin mengandung karakter ':' — React
 * Router membawanya apa adanya di path segment (tidak perlu escape), tapi saat
 * dikirim ke API kita encode supaya aman terhadap query/trailing slash.
 */
export function encodeHandle(handle: string): string {
  return encodeURIComponent(handle)
}

/**
 * Query string filter tipe/status (kontrak search-ux.md). Kosong kalau tidak
 * ada filter yang aktif — supaya request tanpa filter tetap bentuk lama yang
 * sudah terbukti, dan `genre` TIDAK PERNAH ikut terkirim (server menolaknya).
 */
function filterQuery(f?: {
  tipe?: string | null
  status?: string | null
  genre?: string | null
}): string {
  let qs = ''
  if (f?.tipe) qs += `&tipe=${encodeURIComponent(f.tipe)}`
  if (f?.status) qs += `&status=${encodeURIComponent(f.status)}`
  if (f?.genre) qs += `&genre=${encodeURIComponent(f.genre)}`
  return qs
}

export const unifiedApi = {
  search: (
    q: string,
    page = 1,
    signal?: AbortSignal,
    filter?: { tipe?: string | null; status?: string | null; genre?: string | null },
  ) =>
    get<UnifiedListResult>(
      `/unified/search?q=${encodeURIComponent(q)}&page=${page}${filterQuery(filter)}`,
      signal,
    ),
  /**
   * Katalog gabungan (semua item, bukan feed populer). Dipakai halaman Cari
   * mode eksplorasi HANYA saat filter tipe/status/genre aktif — tanpa filter
   * feed tetap `popular` (kontrak plan search-ux.md).
   */
  catalogue: (
    page = 1,
    signal?: AbortSignal,
    filter?: { tipe?: string | null; status?: string | null; genre?: string | null },
  ) =>
    get<UnifiedListResult>(
      `/unified/catalogue?page=${page}${filterQuery(filter)}`,
      signal,
    ),
  popular: (page = 1, signal?: AbortSignal) =>
    get<UnifiedListResult>(`/unified/popular?page=${page}`, signal),
  latest: (page = 1, signal?: AbortSignal) =>
    get<UnifiedListResult>(`/unified/latest?page=${page}`, signal),
  genres: (signal?: AbortSignal) =>
    get<{ items: UnifiedGenre[] }>('/unified/genres', signal),
  /**
   * Kesehatan 4 sumber. Server membalas {total,healthy,sources[]}.
   * Server memakai stale-while-revalidate (cache 30s): respons normal
   * dilayani seketika (mungkin stale ≤30s). `force` = paksa probe inline
   * (tombol "periksa ulang" → hasil segar sekarang, bukan stale).
   */
  health: (signal?: AbortSignal, force = false) =>
    get<SourceHealth>(`/unified/health${force ? '?force=1' : ''}`, signal),
  series: (handle: string, signal?: AbortSignal, lastSource?: string) =>
    get<UnifiedSeries>(
      `/unified/series/${encodeHandle(handle)}${lastSource ? `?last_source=${encodeURIComponent(lastSource)}` : ''}`,
      signal,
    ),
  // `number` = nomor chapter (string: "1195", "1.5") sesuai kontrak server
  chapter: (handle: string, number: string, signal?: AbortSignal) =>
    get<UnifiedChapter>(
      `/unified/chapter/${encodeHandle(handle)}/${encodeURIComponent(number)}`,
      signal,
    ),
  // ---------------------------------------------------------------- rak/PDF
  // Semua endpoint di bawah = kontrak D:/project/komik/.omh/plans/rak-buku.md
  /** Generate PDF server-side. body {handle, number}. */
  downloadPdf: (handle: string, number: string, signal?: AbortSignal) =>
    send<DownloadPdfResult>('POST', '/unified/download-pdf', { handle, number }, signal),
  /** Daftar unduhan + total_bytes (buffer TTL 24 jam, tanpa limit byte). */
  downloads: (signal?: AbortSignal) =>
    get<DownloadsResponse>('/unified/downloads', signal),
  /**
   * URL file PDF (respons attachment; auto-unduh ke perangkat).
   *
   * `filename` opsional dikirim sebagai `?fn=` — server mengabaikannya, tapi
   * service worker memakainya untuk menulis ulang `Content-Disposition`
   * dengan RFC 5987 (`filename*=UTF-8''…`). Server saat ini mengirim nama
   * UTF-8 mentah di header, yang di-decode Latin-1 oleh sebagian browser →
   * "Iâ€™ll…". Nama dari JSON tetap dipakai untuk atribut `download`.
   */
  downloadFileUrl: (id: string, filename?: string) =>
    `${BASE}/unified/downloads/${encodeURIComponent(id)}${
      filename ? `?fn=${encodeURIComponent(filename)}` : ''
    }`,
  deleteDownload: (id: string, signal?: AbortSignal) =>
    send<{ deleted: boolean }>(
      'DELETE',
      `/unified/downloads/${encodeURIComponent(id)}`,
      undefined,
      signal,
    ),
}

// ---------------------------------------------------------------- notifikasi
// Kontrak favorit-update notifier. Endpoint server (lane paralel):
//   PUT  /api/notif/favorites  body {"favorites":[{title_key,title,cover_url,handle,source}]}
//   GET  /api/notif/list       -> {items,unread,last_check_at}
//   POST /api/notif/read       body {"ids":[…]} | {"all":true}
//   POST /api/notif/dismiss    body {"id":…}
// Kalau server belum meng-integrasikan endpoint ini (404), UI menampilkan
// state kosong — pemanggil menangani error sebagai "tidak ada notifikasi".

/** Satu baris notifikasi: chapter baru untuk series yang di-favoritkan. */
export interface NotifItem {
  id: string
  title_key: string
  title: string
  /** handle series 'sumber:native_id' — tujuan navigasi baris. */
  handle: string
  /** nomor chapter (string: "1195", "1.5") */
  chapter: string
  /** sumber yang punya chapter baru ("komiku", "kiryuu", …) */
  sources: string[]
  /** epoch millis chapter terbit */
  at: number
  read: boolean
}

export interface NotifListResponse {
  items: NotifItem[]
  unread: number
  last_check_at: number | null
}

/** Satu favorit yang dikirim ke server (snapshot dari rakStore). */
export interface NotifFavorite {
  title_key: string
  title: string
  cover_url: string | null
  handle: string
  source: string
}

export const notifApi = {
  list: (signal?: AbortSignal) => get<NotifListResponse>('/notif/list', signal),
  /**
   * Favorit milik akun aktif — dipakai untuk HYDRATE rak sebelum push pertama.
   * Wajib dipanggil sebelum `putFavorites` boleh jalan (lihat notifStore).
   */
  getFavorites: (signal?: AbortSignal) =>
    get<{ favorites: NotifFavorite[] }>('/notif/favorites', signal),
  putFavorites: (favorites: NotifFavorite[], signal?: AbortSignal) =>
    send<{ ok: boolean }>('PUT', '/notif/favorites', { favorites }, signal),
  markRead: (body: { ids: string[] } | { all: true }, signal?: AbortSignal) =>
    send<{ ok: boolean }>('POST', '/notif/read', body, signal),
  dismiss: (id: string, signal?: AbortSignal) =>
    send<{ ok: boolean }>('POST', '/notif/dismiss', { id }, signal),
}

// ---------------------------------------------------------------- akun

export interface ClaimResult {
  ok: boolean
  username: string
  /** true = akun BARU dibuat → arah sinkronisasi PUSH. false = akun lama → PULL. */
  created: boolean
}

export const userApi = {
  /** Daftar sekaligus masuk. Satu-satunya cara membuat/masuk akun. */
  claim: (username: string, signal?: AbortSignal) =>
    send<ClaimResult>('POST', '/user/claim', { username }, signal),
  /** Probe akun aktif (401 kalau username belum terdaftar). */
  me: (signal?: AbortSignal) => get<{ username: string }>('/user/me', signal),
}

// ---------------------------------------------------------------- progress

/** Bentuk entri progress = `ProgressEntry` di hooks/useProgress.ts (opaque bagi server). */
export type ProgressEntryPayload = Record<string, unknown>

export const progressApi = {
  get: (signal?: AbortSignal) =>
    get<{ entries: ProgressEntryPayload[] }>('/progress', signal),
  put: (entries: ProgressEntryPayload[], signal?: AbortSignal) =>
    send<{ ok: boolean; count: number }>('PUT', '/progress', { entries }, signal),
}

// ---------------------------------------------------------------- read marks

/**
 * Mark "chapter sudah dibaca" per akun.
 *
 * Bentuk: `{ marks: { "<title_key>": { "<nomor chapter>": <at_ms> } } }`
 * `title_key` = identitas series lintas-sumber, nomor = string ("1195").
 *
 * Merge di server = UNION (monotonik) — push dari device lain tidak
 * menghapus mark yang sudah ada.
 */
export type ReadMarks = Record<string, Record<string, number>>

export const readApi = {
  /** Semua mark akun, atau hanya satu series (`?series=<title_key>`). */
  get: (series?: string, signal?: AbortSignal) =>
    get<{ marks: ReadMarks; count: number }>(
      series ? `/read?series=${encodeURIComponent(series)}` : '/read',
      signal,
    ),
  put: (marks: ReadMarks, signal?: AbortSignal) =>
    send<{ ok: boolean; count: number }>('PUT', '/read', { marks }, signal),
}

/**
 * MangaOut (unified) → bentuk kartu `Manga` yang sudah dipakai komponen
 * existing (Row/MangaCard). Dirata di sini supaya TIDAK ada komponen duplikat:
 * user melihat UI yang sama untuk 4 sumber, hanya beda badge.
 */
export function toMangaCard(m: MangaOut): Manga {
  return {
    id: m.handle,
    title: m.title,
    // server kirim rating sebagai string; "-" berarti tanpa skor
    score: m.rating && m.rating !== '-' ? m.rating : null,
    thumbnail: m.cover_url,
    cover: m.cover_url,
    // updated_at epoch millis → tanggal pendek lokal (samakan dengan kartu komiku)
    update_date: m.updated_at ? new Date(m.updated_at).toLocaleDateString('id-ID') : null,
    tipe: m.manga_type ? [m.manga_type] : m.status ? [m.status] : null,
    status: m.status ? [m.status] : null,
    other: [m.last_chapter, m.author].filter(Boolean) as string[],
    handle: m.handle,
    source: m.source,
    title_key: m.title_key,
  }
}

export const api = {
  homepage: (signal?: AbortSignal) => get<Homepage>('/homepage', signal),
  search: (q: string, page = 1, signal?: AbortSignal) =>
    get<SearchResult>(`/search?q=${encodeURIComponent(q)}&page=${page}`, signal),
  series: (id: number | string, signal?: AbortSignal) =>
    get<{ series: SeriesDetail; chapters: Chapter[]; related: Chapter[] }>(
      `/series/${id}`,
      signal,
    ),
  chapter: (id: number | string, signal?: AbortSignal) =>
    get<ChapterResponse>(`/chapter/${id}`, signal),
  categories: (signal?: AbortSignal) =>
    get<{ groups: CategoryGroup[] }>('/categories', signal),
}

/** Sampul: pakai `cover` (landscape) kalau ada, jatuh ke `thumbnail`. */
export function coverOf(
  m: Pick<Manga, 'cover' | 'thumbnail'> | null | undefined,
): string | null {
  if (!m) return null
  return m.cover || m.thumbnail || null
}

export function thumbOf(
  m: Pick<Manga, 'thumbnail' | 'cover'> | null | undefined,
): string | null {
  if (!m) return null
  return m.thumbnail || m.cover || null
}

export function tagsOf(m: Manga): string[] {
  return [...(m.tipe ?? []), ...(m.status ?? [])].filter(Boolean)
}
