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
 * Elemen interaktif apa pun (tombol/tautan) — dipakai hook fullscreen untuk
 * membatalkan niat "tap = layar penuh" begitu user menyentuh kontrol.
 */
export const INTERACTIVE_SELECTOR =
  'button, a[href], [role="button"], input, select, textarea, [data-reader-control]'

/**
 * Penanda tombol layar penuh manual (ReaderFullscreenButton).
 *
 * Dikecualikan dari aturan "sentuh kontrol apa pun -> batalkan niat
 * fullscreen": menyentuh tombol ini berarti MEMAKAI niat itu, bukan
 * membatalkannya. Kalau niat dimatikan saat pointerdown, tombolnya ikut
 * di-unmount (pointer-events:none + inert) sebelum event click sampai —
 * tap-nya hilang total dan tombol terasa mati.
 */
export const FS_TOGGLE_ATTR = 'data-fs-toggle'

export function isInteractiveTarget(target: EventTarget | null): boolean {
  const el = target as Element | null
  if (!el || typeof el.closest !== 'function') return false
  return !!el.closest(INTERACTIVE_SELECTOR)
}

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
