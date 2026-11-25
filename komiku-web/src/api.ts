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
  SimilarResponse,
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

export function accountHeaders(base?: Record<string, string>): Record<string, string> | undefined {
  const u = getUser()
  if (!u) return base
  return { ...(base ?? {}), 'X-Komik-User': u }
}

/** Error dengan HTTP status terlampir — dipakai circuit breaker & friendlyError. */
function withStatus(detail: string, status: number): Error & { status: number } {
  return Object.assign(new Error(detail), { status })
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
    throw withStatus(detail, res.status)
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
    throw withStatus(detail, res.status)
  }
  const text = await res.text()
  if (!text) return {} as T
  try {
    return JSON.parse(text) as T
  } catch {
    // Body terpotong (proxy 504 setengah jalan, buffer habis) → SyntaxError
    // telanjang menyesatkan UI; lempar pesan jelas berbahasa Indonesia.
    throw new Error('Respons server tidak valid (bukan JSON).')
  }
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
 * Query string filter tipe/status/genre + sumber/urut + min_ch (kontrak
 * search-ux.md). Kosong kalau tidak ada filter yang aktif — supaya request
 * tanpa filter tetap bentuk lama.
 */
function filterQuery(f?: {
  tipe?: string | null
  status?: string | null
  genre?: string | null
  source?: string | null
  sort?: string | null
  min_ch?: number | null
}): string {
  let qs = ''
  if (f?.tipe) qs += `&tipe=${encodeURIComponent(f.tipe)}`
  if (f?.status) qs += `&status=${encodeURIComponent(f.status)}`
  if (f?.genre) qs += `&genre=${encodeURIComponent(f.genre)}`
  if (f?.source) qs += `&source=${encodeURIComponent(f.source)}`
  if (f?.sort) qs += `&sort=${encodeURIComponent(f.sort)}`
  // 0 / null = "Semua" — jangan kirim param supaya cache server tetap kunci lama.
  if (f?.min_ch != null && f.min_ch > 0) qs += `&min_ch=${encodeURIComponent(String(f.min_ch))}`
  return qs
}

/** Filter feed/katalog/pencarian terpadu — dikirim sebagai query string. */
export interface UnifiedFilter {
  tipe?: string | null
  status?: string | null
  genre?: string | null
  /** Sumber (komiku/mangaku/shinigami/kiryuu/komikindo); kosong = semua. */
  source?: string | null
  /** Urutan (''=terbaru, rating, trending); kosong = default server. */
  sort?: string | null
  /** Minimal jumlah chapter; hanya dikirim kalau > 0. */
  min_ch?: number | null
}

export const unifiedApi = {
  /** Ukuran halaman standar lintas sumber (search/catalogue/popular/latest). */
  search: (
    q: string,
    page = 1,
    signal?: AbortSignal,
    filter?: UnifiedFilter,
  ) =>
    get<UnifiedListResult>(
      `/unified/search?q=${encodeURIComponent(q)}&page=${page}&limit=20${filterQuery(filter)}`,
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
    filter?: UnifiedFilter,
  ) =>
    get<UnifiedListResult>(
      `/unified/catalogue?page=${page}&limit=20${filterQuery(filter)}`,
      signal,
    ),
  popular: (page = 1, signal?: AbortSignal, filter?: UnifiedFilter) =>
    get<UnifiedListResult>(
      `/unified/popular?page=${page}&limit=20${filterQuery(filter)}`,
      signal,
    ),
  latest: (page = 1, signal?: AbortSignal, filter?: UnifiedFilter) =>
    get<UnifiedListResult>(
      `/unified/latest?page=${page}&limit=20${filterQuery(filter)}`,
      signal,
    ),
  genres: (signal?: AbortSignal) =>
    get<{ items: UnifiedGenre[] }>('/unified/genres', signal),
  /**
   * Kesehatan 5 sumber. Server membalas {total,healthy,sources[]}.
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
  similar: (handle: string, signal?: AbortSignal) =>
    get<SimilarResponse>(`/unified/series/${encodeHandle(handle)}/similar`, signal),
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

/** Regex entity HTML yang sering bocor dari judul hasil scraping sumber. */
const HTML_ENTITY = /&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos|nbsp|ndash|mdash|hellip|rsquo|lsquo|rdquo|ldquo|trade|copy|reg|times|divide|middot|bull|laquo|raquo|sbquo|bdquo|prime|Prime|euro|pound|yen|cent|deg|plusmn|frac12|frac14|frac34|sup1|sup2|sup3|micro|para|sect|uml|macr|cedil|tilde|szlig|aelig|AElig|oelig|Oelig|scaron|Scaron|yuml|Yuml|circ|acute|grave|ock|Ock);/gi
const NAMED_ENTITY: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  ndash: '–', mdash: '—', hellip: '…', rsquo: '’', lsquo: '‘',
  rdquo: '”', ldquo: '“', trade: '™', copy: '©', reg: '®',
  times: '×', divide: '÷', middot: '·', bull: '•', laquo: '«', raquo: '»',
  sbquo: '‚', bdquo: '„', prime: '′', Prime: '″', euro: '€', pound: '£',
  yen: '¥', cent: '¢', deg: '°', plusmn: '±', frac12: '½', frac14: '¼',
  frac34: '¾', sup1: '¹', sup2: '²', sup3: '³', micro: 'µ', para: '¶',
  sect: '§', uml: '¨', macr: '¯', cedil: '¸', tilde: '˜', szlig: 'ß',
  aelig: 'æ', AElig: 'Æ', oelig: 'œ', Oelig: 'Œ', scaron: 'š', Scaron: 'Š',
  yuml: 'ÿ', Yuml: 'Ÿ', circ: 'ˆ', acute: '´', grave: '`', ock: 'œ', Ock: 'Œ',
}

/**
 * Decode entity HTML (numeric & nama umum) tanpa dependency baru. Sumber
 * scraping kadang mengirim `&#8211;` dsb. apa adanya; kalau dipasangkan
 * langsung ke teks React, browser menampilkannya literal — ini merusak judul
 * di kartu cari/home. Non-entity dibiarkan apa adanya.
 */
export function decodeEntities(input: string | null | undefined): string {
  if (!input) return ''
  return input.replace(HTML_ENTITY, (match, code: string) => {
    let value: string | undefined
    if (code[0] === '#') {
      const hex = code[1]?.toLowerCase() === 'x'
      const n = Number.parseInt(code.slice(hex ? 2 : 1), hex ? 16 : 10)
      if (Number.isFinite(n) && n > 0 && n <= 0x10ffff) {
        try { value = String.fromCodePoint(n) } catch { value = undefined }
      }
    } else {
      value = NAMED_ENTITY[code]
    }
    return value ?? match
  })
}

/**
 * MangaOut (unified) → bentuk kartu `Manga` yang sudah dipakai komponen
 * existing (Row/MangaCard). Dirata di sini supaya TIDAK ada komponen duplikat:
 * user melihat UI yang sama untuk 5 sumber, hanya beda badge.
 */
/** Host yang dikenal menolak hotlink cover dari browser dan tidak di-proxy.
 *  komikindo.ch kini dilayani same-origin lewat proxy `/img` (dengan DoH pinning
 *  + fallback Photon di backend), sehingga aman dipakai untuk Hero Carousel,
 *  kartu katalog, dan halaman series.
 */
const DEAD_COVER_HOSTS = new Set<string>()

/** Cover null kalau berasal dari host yang hotlink-nya gagal di browser. */
export function usableCoverUrl(url: string | null | undefined): string | null {
  if (!url) return null
  try {
    const u = new URL(url, typeof window === 'undefined' ? undefined : window.location.href)
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return null
    return DEAD_COVER_HOSTS.has(u.hostname.toLowerCase()) ? null : url
  } catch {
    // URL relatif tanpa base (test/node) masih boleh dipakai <img>.
    return url
  }
}

const DATE_ID = new Intl.DateTimeFormat('id-ID')

export function toMangaCard(m: MangaOut): Manga {
  const cover = usableCoverUrl(m.cover_url)
  return {
    id: m.handle,
    title: decodeEntities(m.title),
    // server kirim rating sebagai string; "-" berarti tanpa skor
    score: m.rating && m.rating !== '-' ? m.rating : null,
    author: m.author ? decodeEntities(m.author) : null,
    thumbnail: cover,
    cover,
    // updated_at epoch millis → tanggal pendek lokal (samakan dengan kartu komiku)
    update_date: m.updated_at ? DATE_ID.format(new Date(m.updated_at)) : null,
    tipe: m.manga_type ? [m.manga_type] : m.status ? [m.status] : null,
    status: m.status ? [m.status] : null,
    other: m.last_chapter ? [m.last_chapter] : [],
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
