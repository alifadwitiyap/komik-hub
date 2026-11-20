/**
 * Kembali ke halaman series setelah login dari alur unduhan.
 *
 * Halaman /akun mengganti halaman series (unmount), jadi listener React di
 * komponen sudah mati saat `account-change` dipancarkan. Listener modul ini
 * tetap hidup dan membawa user balik ke URL lokal yang disimpan sebelum
 * navigasi; seleksi chapter dipulihkan oleh effect di halaman series.
 *
 * `Akun.tsx` sengaja tidak diubah (milik subagent lain) — tidak ada redirect
 * di sana.
 */

import { onAccountChange } from './account'

const PREFIX = 'komik:download-return:'

function backToSeries(): void {
  try {
    for (let i = 0; i < sessionStorage.length; i++) {
      const key = sessionStorage.key(i)
      if (!key || !key.startsWith(PREFIX)) continue
      const back = sessionStorage.getItem(key)
      if (!back) continue
      const url = new URL(back, window.location.origin)
      // Hanya path lokal di halaman detail; jangan percaya isi storage buta.
      if (url.origin !== window.location.origin || !url.pathname.startsWith('/manga/')) continue
      sessionStorage.removeItem(key)
      window.location.assign(url.pathname + url.search + url.hash)
      return
    }
  } catch {
    /* storage/URL tidak tersedia — biarkan user pindah manual */
  }
}

let registered = false

/** Daftarkan listener sekali per modul (idempoten). */
export function ensureDownloadReturn(): void {
  if (registered || typeof window === 'undefined') return
  registered = true
  onAccountChange(({ username }) => {
    if (username) backToSeries()
  })
}
