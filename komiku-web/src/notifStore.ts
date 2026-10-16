/**
 * notifStore — sinkronisasi favorit (rakStore) ke server notifikasi.
 *
 * Setiap favorit berubah (window event 'rak-change') DAN sekali saat app
 * load, daftar favorit LENGKAP dikirim via PUT /api/notif/favorites,
 * di-debounce 2 detik supaya spam (mis. toggle hati beruntun) tidak
 * membanjiri server. PUT dilewati kalau daftar yang terserialisasi sama
 * dengan kiriman terakhir (bandingkan hash string). Semua error DI-telan
 * (console.warn saja) — UI tidak boleh diblokir atau error-loop kalau
 * endpoint /api/notif/* belum ada di server (404).
 */

import { listFavorites } from './rakStore'
import { notifApi, type NotifFavorite } from './api'

const DEBOUNCE_MS = 2000

/** hash ringan (djb2) dari string — cukup untuk deteksi "sama / beda". */
function hash(s: string): string {
  let h = 5381
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0
  return String(h)
}

let lastSentHash: string | null = null
let timer: ReturnType<typeof setTimeout> | null = null
let started = false

/** Daftar favorit → bentuk ringkas yang dikirim ke server. */
function collect(): NotifFavorite[] {
  return listFavorites().map((f) => ({
    title_key: f.title_key,
    title: f.title,
    cover_url: f.cover_url,
    handle: f.handle,
    source: f.source,
  }))
}

async function flush(): Promise<void> {
  const favorites = collect()
  const serialized = JSON.stringify(favorites)
  const currentHash = hash(serialized)
  if (currentHash === lastSentHash) return // tidak berubah sejak kiriman terakhir
  try {
    await notifApi.putFavorites(favorites)
    lastSentHash = currentHash
  } catch (err) {
    // server belum punya endpoint / jelek — jangan retry-loop, coba lagi
    // pada perubahan favorit berikutnya atau app load berikutnya.
    console.warn('notifStore: gagal sinkron favorit', err)
  }
}

function schedule(): void {
  if (timer) clearTimeout(timer)
  timer = setTimeout(() => {
    timer = null
    void flush()
  }, DEBOUNCE_MS)
}

/**
 * Mulai mendengarkan: sekali saat app load + setiap 'rak-change'.
 * Aman dipanggil berulang (React StrictMode, HMR) — hanya pasang listener sekali.
 * Kembalikan fungsi stop (untuk test/teardown).
 */
export function startFavoritesSync(): () => void {
  if (typeof window === 'undefined') return () => {}
  if (started) return () => {}
  started = true
  window.addEventListener('rak-change', schedule)
  schedule() // app load: kirim snapshot favorit yang sudah ada
  return () => {
    window.removeEventListener('rak-change', schedule)
    if (timer) clearTimeout(timer)
    timer = null
    started = false
  }
}
