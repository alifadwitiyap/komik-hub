/**
 * marathonMemory.ts — posisi baca MODE MARATON.
 *
 * Kenapa modul sendiri, bukan menumpang `useProgress`:
 *
 *   Reader biasa menyimpan SATU posisi per series (chapter + halaman + offset).
 *   Maraton menyimpan HAL YANG BERBEDA: posisi di dalam RANTAI beberapa chapter
 *   (blok ke-N), plus berapa blok yang sudah termuat saat sesi ditinggalkan.
 *   Kalau keduanya memakai entri progress yang sama, tiap scroll maraton akan
 *   menimpa posisi reader biasa untuk series itu (dan sebaliknya) — pembaca
 *   yang berganti-ganti mode akan kehilangan posisinya dua kali.
 *
 *   Jadi: kunci localStorage TERPISAH, per-akun, dan TIDAK ikut blob progress
 *   server. Maraton adalah posisi rantai di device ini; progress tetap jadi
 *   sumber riwayat "Lanjut membaca".
 *
 * Bentuk data (v1):
 *   {
 *     chapterKey : kunci chapter BLOK PERTAMA rantai ("komiku:1284:121")
 *     activeKey  : kunci chapter blok yang SEDANG dibaca
 *     pageId     : URL gambar halaman yang sedang ditatap (identitas halaman)
 *     offsetRatio: 0..1 kedalaman posisi mata di dalam halaman itu
 *     blocks     : jumlah blok yang termuat saat posisi disimpan (>= 1)
 *     chapterIdx : indeks blok baca aktif (0-based)
 *     at         : waktu simpan (ms) — dipakai TTL & pemilihan terbaru
 *   }
 *
 * `chapterKey` = identitas SESI (dari mana maraton dimulai), `activeKey` =
 * di mana pembaca berhenti. Keduanya dibutuhkan: rantai dibangun ulang mulai
 * `chapterKey`, lalu berhenti saat mencapai `activeKey`.
 *
 * Modul ini SENGAJA murni (tanpa React, tanpa DOM) supaya round-trip posisi
 * bisa diuji lewat skrip node — sama seperti `pageMemory.ts`.
 */

const KEY = 'komiku.web.marathon.v1'
/** Batas umur posisi maraton: sama dengan anchor reader (90 hari). */
export const MARATHON_TTL_MS = 90 * 24 * 60 * 60 * 1000
/** Batas jumlah series yang disimpan (paling baru menang). */
const MAX = 24

export interface MarathonPosition {
  /** kunci chapter blok PERTAMA rantai — identitas sesi maraton */
  chapterKey: string
  /**
   * Identitas SERIES dalam bentuk yang dipakai reader: handle unified
   * ("komiku:1284") atau id manga numerik sebagai string di flow komiku lama
   * ("6427"). Dipakai untuk mencari sesi dari halaman series / "Lanjut
   * membaca" — di flow lama tidak ada handle, jadi `handleOf` saja tidak cukup.
   */
  seriesKey?: string
  /** kunci chapter blok yang SEDANG dibaca (tempat pembaca berhenti) */
  activeKey: string
  /** URL gambar halaman yang sedang ditatap (sudah lewat imgUrl) */
  pageId: string
  /** 0..1 — kedalaman posisi mata di dalam halaman `pageId` */
  offsetRatio: number
  /** jumlah blok yang termuat saat posisi ini disimpan (>= 1) */
  blocks: number
  /** indeks blok baca aktif di dalam rantai (0-based) */
  chapterIdx: number
  at: number
}

/**
 * Handle series dari sebuah kunci chapter.
 *   "komiku:1284:121" → "komiku:1284"
 *   "6427"            → null (flow komiku lama tak punya handle)
 */
export function handleOf(chapterKey: string): string | null {
  const i = chapterKey.lastIndexOf(':')
  return i > 0 ? chapterKey.slice(0, i) : null
}

/**
 * Kunci penyimpanan per-akun. Sengaja menerima username sebagai argumen
 * (bukan memanggil `getUser()` di dalam) supaya modul tetap murni dan bisa
 * diuji tanpa localStorage akun.
 */
export function marathonStoreKey(username: string | null): string {
  return username ? `${KEY}:${username}` : KEY
}

function clampInt(n: number, min: number, max: number): number {
  const v = Math.round(Number.isFinite(n) ? n : min)
  return v < min ? min : v > max ? max : v
}

/** Normalisasi + validasi satu entri. null kalau tidak layak dipakai. */
export function usablePosition(
  entry: MarathonPosition | null | undefined,
  now: number = Date.now(),
): MarathonPosition | null {
  if (!entry) return null
  if (typeof entry.chapterKey !== 'string' || entry.chapterKey === '') return null
  if (typeof entry.pageId !== 'string' || entry.pageId === '') return null
  if (typeof entry.offsetRatio !== 'number' || !Number.isFinite(entry.offsetRatio)) return null
  if (typeof entry.at !== 'number' || !Number.isFinite(entry.at)) return null
  if (now - entry.at > MARATHON_TTL_MS) return null
  return {
    chapterKey: entry.chapterKey,
    seriesKey:
      typeof entry.seriesKey === 'string' && entry.seriesKey !== ''
        ? entry.seriesKey
        : (handleOf(entry.chapterKey) ?? undefined),
    // entri cacat/sesi lama tanpa activeKey: jatuh ke blok pertama, bukan
    // dibuang — posisi halaman tetap berguna.
    activeKey:
      typeof entry.activeKey === 'string' && entry.activeKey !== ''
        ? entry.activeKey
        : entry.chapterKey,
    pageId: entry.pageId,
    offsetRatio: Math.min(1, Math.max(0, entry.offsetRatio)),
    // rantai minimal 1 blok; nilai aneh (0/NaN) diperbaiki, bukan dibuang —
    // posisi halaman tetap berguna walau jumlah blok tak tercatat benar.
    blocks: clampInt(entry.blocks ?? 1, 1, 200),
    chapterIdx: clampInt(entry.chapterIdx ?? 0, 0, 199),
    at: entry.at,
  }
}

/**
 * Posisi untuk satu sesi maraton (dikenali dari `chapterKey` blok pertama).
 * Entri paling baru menang kalau ada duplikat.
 */
export function findPosition(
  entries: readonly MarathonPosition[],
  chapterKey: string,
): MarathonPosition | null {
  let best: MarathonPosition | null = null
  for (const e of entries) {
    if (!e || e.chapterKey !== chapterKey) continue
    if (!best || e.at > best.at) best = e
  }
  return usablePosition(best)
}

/**
 * Sisipkan/ganti satu posisi, urutkan terbaru-dulu, potong `MAX`.
 * Murni: mengembalikan daftar baru, tidak menyentuh storage.
 */
export function upsertPosition(
  entries: readonly MarathonPosition[],
  entry: MarathonPosition,
): MarathonPosition[] {
  const next = [entry, ...entries.filter((e) => e.chapterKey !== entry.chapterKey)]
  return next.sort((a, b) => b.at - a.at).slice(0, MAX)
}

/** Hapus posisi satu sesi (dipakai "Mulai dari awal"). */
export function removePosition(
  entries: readonly MarathonPosition[],
  chapterKey: string,
): MarathonPosition[] {
  return entries.filter((e) => e.chapterKey !== chapterKey)
}

/** Identitas series dari satu posisi: `seriesKey` kalau ada, else dari handle. */
export function seriesKeyOf(entry: MarathonPosition): string | null {
  if (typeof entry.seriesKey === 'string' && entry.seriesKey !== '') return entry.seriesKey
  return handleOf(entry.chapterKey)
}

/**
 * Sesi maraton terbaru milik sebuah series — dipakai "Lanjut membaca", yang
 * hanya tahu identitas series (handle unified atau id numerik flow lama),
 * bukan kunci chapter awalnya.
 */
export function latestForHandle(
  entries: readonly MarathonPosition[],
  seriesKey: string | null | undefined,
): MarathonPosition | null {
  if (!seriesKey) return null
  let best: MarathonPosition | null = null
  for (const e of entries) {
    if (!e || seriesKeyOf(e) !== seriesKey) continue
    if (!best || e.at > best.at) best = e
  }
  return usablePosition(best)
}

/** Hapus SEMUA sesi maraton milik satu series ("Mulai dari awal"). */
export function removeHandle(
  entries: readonly MarathonPosition[],
  seriesKey: string | null | undefined,
): MarathonPosition[] {
  if (!seriesKey) return [...entries]
  return entries.filter((e) => seriesKeyOf(e) !== seriesKey)
}

/** Parse blob JSON dari storage. Toleran terhadap data rusak/versi lain. */
export function parsePositions(raw: string | null): MarathonPosition[] {
  if (!raw) return []
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return (parsed as MarathonPosition[])
      .map((e) => usablePosition(e))
      .filter((e): e is MarathonPosition => e !== null)
      .sort((a, b) => b.at - a.at)
      .slice(0, MAX)
  } catch {
    return []
  }
}

/** Serialisasi daftar posisi untuk disimpan. */
export function serializePositions(entries: readonly MarathonPosition[]): string {
  return JSON.stringify(entries.slice(0, MAX))
}
