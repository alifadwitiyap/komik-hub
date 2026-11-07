/**
 * Target frontier fill-ahead reader.
 *
 * Diekstrak murni (tanpa DOM) supaya kontrak "chapter terus merender sampai
 * selesai" bisa diuji tanpa jsdom. Lihat fillAhead.test.ts.
 *
 * P1: frontier WAJIB naik seiring jumlah tick walau pembaca tidak menggulir.
 * Scroll tetap boleh mempercepat (loncat jauh), tapi bukan satu-satunya
 * pemicu — kalau hanya `scrollProgress`, chapter mandek setelah burst awal.
 * Slow-link / mode hemat maju lebih pelan (1 halaman/tick vs ≈1,5 normal)
 * supaya tidak mencuri bandwidth dari halaman yang sedang dibaca.
 */

export interface FillFrontierArgs {
  /** nilai bgFillIdx saat ini */
  prev: number
  /** berapa kali tick 250ms sudah berlalu sejak chapter dimuat */
  ticks: number
  pageCount: number
  /** true = koneksi lambat / mode hemat */
  slow?: boolean
  /** 0..1, posisi scroll relatif terhadap tinggi dokumen */
  scrollProgress?: number
}

export function nextFillFrontier(a: FillFrontierArgs): number {
  const upper = Math.max(0, a.pageCount - 1)
  const lead = a.slow ? 6 : 10
  // Komponen waktu: monoton, tidak pernah turun, dan tidak bergantung scroll.
  // Normal ≈1,5 halaman/tick, slow/hemat 1 halaman/tick. Ini cuma target
  // MOUNT; fetch sungguhan tetap dibatasi imgQueue (CAP_NORMAL=2), jadi tidak
  // ada thundering herd. 250ms/tick → seluruh chapter tertarget dlm ~7,5s.
  const byTime = a.slow ? a.ticks : a.ticks + Math.floor(a.ticks / 2)
  // Komponen scroll: boleh mempercepat saat pembaca melompat jauh.
  const byScroll = Math.floor((a.scrollProgress ?? 0) * a.pageCount)
  const target = lead + byTime + byScroll
  return Math.min(upper, Math.max(a.prev, target))
}
