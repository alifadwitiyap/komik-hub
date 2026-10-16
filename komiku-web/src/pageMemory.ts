/**
 * Catatan: modul ini SENGAJA mandiri (tanpa React, tanpa dependency) supaya
 * logika inti posisi baca bisa diuji lewat satu skrip node.
 *
 * Bentuk anchor baca:  { chapterId, pageId, offsetRatio }
 *   pageId      = URL gambar absolut (dilewatkan imgUrl) — identitas halaman
 *                 yang persis dipakai <img src>, jadi stabil tanpa index.
 *   offsetRatio = 0..1, seberapa jauh TENGAH VIEWPORT menembus halaman itu.
 *                 (0 = pembaca baru masuk dari atas halaman, 1 = lewat
 *                 tengah viewport sampai bawah halaman; di luar rentang
 *                 terjadi saat antara dua halaman lalu di-clamp.)
 *
 * Anti layout-shift: tinggi 1 halaman baru diketahui SETELAH gambar decode.
 * Itu sama dengan yang membuat posisi tersimpan bergeser saat dibuka lagi.
 * Karena itu rasio aspek asli tiap gambar (width/height dari natural size)
 * dicatat ke localStorage dan dipakai lagi sebagai width/height eksplisit
 * pada <img> — browser bisa mengalokasikan tinggi sebelum gambar muat.
 */

const ASPECT_KEY = 'komiku.web.page-aspect.v1'
/** berapa lama anchor disimpan (entri lama dibuang otomatis) */
export const ANCHOR_TTL_MS = 90 * 24 * 60 * 60 * 1000

export interface ReadingAnchor {
  chapterId: string | number
  /** URL gambar absolut (sudah lewat imgUrl) dari halaman yang dibaca */
  pageId: string
  /** 0..1 — kedalaman posisi mata di dalam halaman itu */
  offsetRatio: number
  /** waktu simpan (ms) — dipakai TTL & debug */
  at: number
}

export function clamp01(n: number): number {
  return n < 0 ? 0 : n > 1 ? 1 : n
}

function loadAspects(): Map<string, number> {
  try {
    const raw = localStorage.getItem(ASPECT_KEY)
    if (!raw) return new Map()
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return new Map()
    const out = new Map<string, number>()
    for (const pair of parsed) {
      if (
        Array.isArray(pair) &&
        typeof pair[0] === 'string' &&
        typeof pair[1] === 'number' &&
        pair[1] > 0
      ) {
        out.set(pair[0], pair[1])
      }
    }
    return out
  } catch {
    return new Map()
  }
}

let aspectCache: Map<string, number> | null = null

/** Rasio aspek tersimpan untuk sebuah URL (h/w), atau null kalau belum ada. */
export function aspectOf(pageId: string): number | null {
  if (aspectCache === null) aspectCache = loadAspects()
  return aspectCache.get(pageId) ?? null
}

let aspectFlush: ReturnType<typeof setTimeout> | null = null

/** Simpan rasio aspek sebuah halaman. Simpan di-debounce (banyak halaman muat). */
export function rememberAspect(pageId: string, w: number, h: number): void {
  if (!pageId || !(w > 0) || !(h > 0)) return
  if (aspectCache === null) aspectCache = loadAspects()
  aspectCache.set(pageId, w / h)
  if (aspectFlush) return
  aspectFlush = setTimeout(() => {
    aspectFlush = null
    try {
      // sisakan 2000 entri terbaru — cukup beberapa ratus chapter terakhir
      localStorage.setItem(ASPECT_KEY, JSON.stringify([...aspectCache!.entries()].slice(-2000)))
    } catch {
      /* storage penuh / mode privat — rasio tidak ganggu membaca */
    }
  }, 400)
}

/** Halaman mana yang sedang ditatap + seberapa dalam posisi mata di sana. */
export function anchorFrom(
  chapterId: string | number,
  pageIds: readonly string[],
  scrollY: number,
  viewportH: number,
  pageTops: readonly number[],
  pageHeights: readonly number[],
): ReadingAnchor | null {
  if (pageIds.length === 0 || !(viewportH > 0)) return null
  if (pageTops.length !== pageIds.length || pageHeights.length !== pageIds.length) return null
  const mid = scrollY + viewportH / 2
  let idx = 0
  let best = Number.POSITIVE_INFINITY
  for (let i = 0; i < pageTops.length; i++) {
    const d = Math.abs(pageTops[i] + pageHeights[i] / 2 - mid)
    if (d < best) {
      best = d
      idx = i
    }
  }
  const ratio = (mid - pageTops[idx]) / pageHeights[idx]
  return {
    chapterId,
    pageId: pageIds[idx],
    offsetRatio: Math.round(clamp01(ratio) * 1000) / 1000,
    at: Date.now(),
  }
}

/** Posisi scroll piksel yang membuat `offsetRatio` kembali di tengah viewport. */
export function scrollYForAnchor(
  offsetRatio: number,
  top: number,
  height: number,
  viewportH: number,
): number {
  return top + height * clamp01(offsetRatio) - viewportH / 2
}

/** Anchor masih layak dipakai (punya halaman + tidak kedaluwarsa). */
export function usableAnchor(
  entry: ReadingAnchor | null | undefined,
  now: number = Date.now(),
): ReadingAnchor | null {
  if (!entry || !entry.pageId) return null
  if (typeof entry.offsetRatio !== 'number' || !Number.isFinite(entry.offsetRatio)) return null
  if (typeof entry.chapterId !== 'string' && typeof entry.chapterId !== 'number') return null
  if (now - entry.at > ANCHOR_TTL_MS) return null
  return entry
}
