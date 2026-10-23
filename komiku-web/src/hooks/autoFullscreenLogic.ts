/**
 * Logika murni auto-fullscreen (dipisah agar bisa diuji tanpa React/DOM).
 *
 * Desain 2 lapis (hasil grill):
 * - Lapis 1 (deteksi intent): flick scroll-turun cepat dideteksi lewat
 *   kecepatan wheel (px/ms) dalam jendela waktu pendek. Ini hanya MENANDAI
 *   niat (`pending`) — TIDAK langsung memanggil requestFullscreen.
 * - Lapis 2 (eksekusi): requestFullscreen() hanya dipanggil sinkron DI
 *   DALAM event user-gesture asli (tap/klik), karena browser menolak call
 *   dari event scroll/wheel (transient activation). Dengan begitu fullscreen
 *   konsisten (tidak lagi "kadang masuk kadang engga").
 */
/** jendela waktu deteksi flick (ms) */
export const FLICK_WINDOW_MS = 150
/** kecepatan minimum untuk dianggap flick (px per ms) */
export const FLICK_VELOCITY_PX_PER_MS = 0.6
/** jumlah minimal event wheel dalam jendela untuk validasi flick */
export const FLICK_MIN_EVENTS = 3
/** masa berlaku niat (`pending`) sebelum hangus (ms) */
export const PENDING_TTL_MS = 2000
/** ambang scroll-naik untuk keluar fullscreen / membatalkan pending (px) */
export const EXIT_SCROLL_THRESHOLD_PX = 20

export interface FlickSample {
  t: number
  dy: number
}

/**
 * Deteksi flick scroll-turun dari jendela sampel wheel terbaru.
 * Pakai kecepatan (total dy / durasi), bukan jarak kumulatif — supaya scroll
 * pelan saat membaca tidak memicu, tapi flick cepat memicu.
 */
export function detectFlick(samples: FlickSample[], now: number): boolean {
  const recent = samples.filter((s) => now - s.t <= FLICK_WINDOW_MS)
  if (recent.length < FLICK_MIN_EVENTS) return false
  let total = 0
  for (const s of recent) total += s.dy
  if (total <= 0) return false
  const dt = now - recent[0].t
  if (dt <= 0) return false
  return total / dt > FLICK_VELOCITY_PX_PER_MS
}

/** Potong sampel yang sudah lebih tua dari jendela flick. */
export function pruneFlickSamples(samples: FlickSample[], now: number): FlickSample[] {
  return samples.filter((s) => now - s.t <= FLICK_WINDOW_MS)
}
