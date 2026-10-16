/**
 * Rak Buku — localStorage store lintas-sumber via title_key.
 * Key localStorage: 'komik-rak-v1'
 * title_key dari server (MangaOut.title_key) — JANGAN reimplement normalisasi di JS.
 */

const KEY = 'komik-rak-v1'
const HISTORY_MAX = 200

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

function load(): RakData {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return { favorites: {}, history: {} }
    const parsed = JSON.parse(raw) as Partial<RakData>
    return {
      favorites: parsed.favorites ?? {},
      history: parsed.history ?? {},
    }
  } catch {
    return { favorites: {}, history: {} }
  }
}

function save(data: RakData): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(data))
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

export function listFavorites(): FavoriteEntry[] {
  const data = load()
  return Object.values(data.favorites).sort((a, b) => b.loved_at - a.loved_at)
}
