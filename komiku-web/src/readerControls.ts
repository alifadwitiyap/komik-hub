/**
 * Penanda & uji geometris KONTROL HALAMAN reader (tombol melingkar "Muat
 * ulang" / "Coba lagi" di dalam area baca).
 *
 * Kenapa ada di modul sendiri:
 * - Kontrol itu dirender lewat portal (lihat ComicImage) supaya berada di atas
 *   lapisan tap-tengah `fixed inset-0 z-10`. Kalau stacking berubah lagi
 *   (ancestor baru ber-`filter`/`transform`, kontrol baru yang lupa di-portal),
 *   tap pada kontrol akan jatuh ke lapisan tap dan — saat niat fullscreen
 *   ter-arm — malah masuk layar penuh (laporan user).
 * - Uji di sini TIDAK bergantung pada z-index sama sekali: cukup geometri.
 *   Dipakai Reader dan ReaderMarathon supaya aturannya satu.
 */

/** atribut wajib pada setiap kontrol yang hidup di atas area baca */
export const READER_CONTROL_ATTR = 'data-reader-control'

/**
 * Apakah titik tap (clientX/clientY) jatuh di atas kontrol halaman?
 *
 * `pad` = toleransi sentuh di sekeliling kotak kontrol. Jari di layar 390 px
 * jarang mendarat tepat di tengah; tap yang meleset 8–12 px tetap harus
 * dianggap "menekan tombol", bukan "mengetuk halaman".
 */
export function tapHitsReaderControl(x: number, y: number, pad = 12): boolean {
  const nodes = document.querySelectorAll<HTMLElement>(`[${READER_CONTROL_ATTR}]`)
  for (const el of nodes) {
    const r = el.getBoundingClientRect()
    if (r.width === 0 && r.height === 0) continue
    if (
      x >= r.left - pad &&
      x <= r.right + pad &&
      y >= r.top - pad &&
      y <= r.bottom + pad
    ) {
      return true
    }
  }
  return false
}
