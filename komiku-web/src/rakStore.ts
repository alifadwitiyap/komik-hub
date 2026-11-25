import { getUser } from './account'

/**
 * Rak Buku — localStorage store lintas-sumber via title_key.
 * Key localStorage: 'komik-rak-v1' / 'komik-rak-v1:<username>' (per-akun).
 * title_key dari server (MangaOut.title_key) — JANGAN reimplement normalisasi di JS.
 */

const KEY = 'komik-rak-v1'
const HISTORY_MAX = 200

/** Key localStorage per-akun: akun beda dapat rak terpisah. */
function rakKey(): string {
  const u = getUser()
  return u ? `${KEY}:${u}` : KEY
}

export interface RakManga {
  title: string
  cover_url: string | null
  handle: string
  source: string
}

export interface FavoriteEntry extends RakManga {
  title_key: string
  loved_at: number
}

export interface HistoryEntry extends RakManga {
  title_key: string
  last_chapter: string
  updated_at: number
}

interface RakData {
  favorites: Record<string, FavoriteEntry>
  history: Record<string, HistoryEntry>
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v)
}

function cleanFavorite(v: unknown): FavoriteEntry | null {
  if (!isPlainObject(v)) return null
  if (typeof v.title_key !== 'string' || v.title_key.trim() === '') return null
  if (typeof v.title !== 'string' || v.title.trim() === '') return null
  if (typeof v.handle !== 'string' || !v.handle.includes(':')) return null
  if (typeof v.source !== 'string') return null
  if (!Number.isFinite(v.loved_at)) return null
  return {
    title_key: v.title_key,
    title: v.title,
    cover_url: typeof v.cover_url === 'string' ? v.cover_url : null,
    handle: v.handle,
    source: v.source,
    loved_at: v.loved_at as number,
  }
}

function cleanHistory(v: unknown): HistoryEntry | null {
  if (!isPlainObject(v)) return null
  if (typeof v.title_key !== 'string' || v.title_key.trim() === '') return null
  if (typeof v.title !== 'string' || v.title.trim() === '') return null
  if (typeof v.handle !== 'string' || !v.handle.includes(':')) return null
  if (typeof v.source !== 'string') return null
  if (!Number.isFinite(v.updated_at)) return null
  // last_chapter: string apa adanya; number → coerce; lainnya → drop
  let last_chapter: string
  if (typeof v.last_chapter === 'string') last_chapter = v.last_chapter
  else if (typeof v.last_chapter === 'number' && Number.isFinite(v.last_chapter)) last_chapter = String(v.last_chapter)
  else return null
  return {
    title_key: v.title_key,
    title: v.title,
    cover_url: typeof v.cover_url === 'string' ? v.cover_url : null,
    handle: v.handle,
    source: v.source,
    last_chapter,
    updated_at: v.updated_at as number,
  }
}

function cleanRecord<T>(v: unknown, clean: (x: unknown) => T | null): Record<string, T> {
  const out: Record<string, T> = {}
  if (!isPlainObject(v)) return out
  for (const [k, x] of Object.entries(v)) {
    const e = clean(x)
    if (e) out[k] = e
  }
  return out
}

let parsedCache: { key: string; raw: string; data: RakData } | null = null

function cloneRakData(data: RakData): RakData {
  return {
    favorites: { ...data.favorites },
    history: { ...data.history },
  }
}

function load(): RakData {
  try {
    const key = rakKey()
    const raw = localStorage.getItem(key)
    if (!raw) {
      parsedCache = null
      return { favorites: {}, history: {} }
    }
    if (parsedCache && parsedCache.key === key && parsedCache.raw === raw) {
      return cloneRakData(parsedCache.data)
    }
    const parsed: unknown = JSON.parse(raw)
    if (!isPlainObject(parsed)) return { favorites: {}, history: {} }
    const data: RakData = {
      favorites: cleanRecord(parsed.favorites, cleanFavorite),
      history: cleanRecord(parsed.history, cleanHistory),
    }
    parsedCache = { key, raw, data }
    return cloneRakData(data)
  } catch {
    return { favorites: {}, history: {} }
  }
}

function save(data: RakData): void {
  try {
    const key = rakKey()
    const raw = JSON.stringify(data)
    localStorage.setItem(key, raw)
    parsedCache = { key, raw, data: cloneRakData(data) }
  } catch {
    /* storage penuh / mode privat */
  }
}

function emit(): void {
  // dijaga supaya modul bisa diimpor & diuji di node (tanpa DOM)
  if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function') {
    window.dispatchEvent(new CustomEvent('rak-change'))
  }
}

/**
 * Ganti SELURUH daftar favorit dengan snapshot dari server (hydrate).
 *
 * `silent: true` = JANGAN memancarkan `rak-change`. Ini bukan opsi kosmetik:
 * `notifStore` mendengarkan `rak-change` untuk push, jadi hydrate yang memancar
 * akan memicu push balik tepat setelah pull — membuang favorit server yang baru
 * saja kita adopsi (lihat spec §5, urutan hydrate-sebelum-push).
 *
 * Riwayat (`history`) TIDAK disentuh: server belum menyimpan riwayat baca, dan
 * snapshot favorit tidak boleh menghapus riwayat lokal device ini.
 */
export function replaceFavorites(
  entries: Array<RakManga & { title_key: string; loved_at?: number }>,
  opts?: { silent?: boolean },
): void {
  const data = load()
  const favorites: Record<string, FavoriteEntry> = {}
  for (const e of entries) {
    favorites[e.title_key] = {
      title_key: e.title_key,
      title: e.title,
      cover_url: e.cover_url,
      handle: e.handle,
      source: e.source,
      loved_at: e.loved_at ?? Date.now(),
    }
  }
  data.favorites = favorites
  save(data)
  if (!opts?.silent) emit()
}

export function toggleFavorite(manga: RakManga & { title_key: string }): void {
  const data = load()
  if (data.favorites[manga.title_key]) {
    delete data.favorites[manga.title_key]
  } else {
    data.favorites[manga.title_key] = {
      title_key: manga.title_key,
      title: manga.title,
      cover_url: manga.cover_url,
      handle: manga.handle,
      source: manga.source,
      loved_at: Date.now(),
    }
  }
  save(data)
  emit()
}

export function isFavorite(title_key: string): boolean {
  const data = load()
  return !!data.favorites[title_key]
}

export function recordRead(manga: RakManga & { title_key: string }, chapter_number: string): void {
  const data = load()
  data.history[manga.title_key] = {
    title_key: manga.title_key,
    title: manga.title,
    cover_url: manga.cover_url,
    handle: manga.handle,
    source: manga.source,
    last_chapter: chapter_number,
    updated_at: Date.now(),
  }
  // eviction: maks 200 entri, buang yang terlama
  const entries = Object.entries(data.history).sort((a, b) => b[1].updated_at - a[1].updated_at)
  if (entries.length > HISTORY_MAX) {
    data.history = Object.fromEntries(entries.slice(0, HISTORY_MAX))
  }
  save(data)
  emit()
}

export function listHistory(): HistoryEntry[] {
  const data = load()
  return Object.values(data.history).sort((a, b) => b.updated_at - a.updated_at)
}

export function removeHistory(title_key: string): void {
  const data = load()
  delete data.history[title_key]
  for (const [k, v] of Object.entries(data.history)) {
    if (v.title_key === title_key) delete data.history[k]
  }
  save(data)
  emit()
}

export function listFavorites(): FavoriteEntry[] {
  const data = load()
  return Object.values(data.favorites).sort((a, b) => b.loved_at - a.loved_at)
}

/** Status rak versi plan UX lanjutan. */
export type RakTab = 'semua' | 'sedang' | 'ingin' | 'selesai' | 'unduhan'

/** Alias URL lama tetap membuka panel yang sama (tautan lama tidak putus). */
const RAK_TAB_ALIASES: Record<string, RakTab> = {
  semua: 'semua',
  terbaru: 'semua',
  sedang: 'sedang',
  sejarah: 'sedang',
  ingin: 'ingin',
  favorit: 'ingin',
  selesai: 'selesai',
  unduhan: 'unduhan',
}

export function normalizeRakTab(raw: string | null | undefined): RakTab {
  return RAK_TAB_ALIASES[String(raw ?? '').trim().toLowerCase()] ?? 'semua'
}

/** Query kanonik — 'semua' memakai URL bersih (warisan ?tab=terbaru). */
export function rakTabQuery(tab: RakTab): Record<string, string> {
  return tab === 'semua' ? {} : { tab }
}
