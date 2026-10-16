/**
 * notifStore — sinkronisasi favorit (rakStore) ke server notifikasi.
 *
 * ATURAN PALING PENTING — URUTAN HYDRATE-SEBELUM-PUSH (spec §5):
 *
 *   Server menyimpan favorit PER-AKUN dan `PUT /api/notif/favorites` bersifat
 *   REPLACE-ALL: apa pun yang tidak ada di kiriman akan dihapus server.
 *
 *   Kalau kita push sebelum hydrate, membuka app di laptop yang rak-nya masih
 *   lama akan mengirim rak lama itu → favorit di HP terhapus. Jadi saat PULL:
 *
 *     1. getUser() === null        → no-op (app tetap jalan lokal, tanpa sync)
 *     2. GET /api/notif/favorites  → snapshot server
 *     3. rakStore.replaceFavorites(server, { silent: true })   ← JANGAN emit
 *     4. lastSentHash = hash(payload hasil hydrate)            ← cegah push balik
 *     5. baru izinkan push
 *
 *   `replaceFavorites({ silent: true })` wajib silent: kalau ia memancarkan
 *   `rak-change`, langkah 3 akan memicu push tepat setelah pull dan membuang
 *   favorit server yang baru diadopsi.
 *
 * ARAH SINKRONISASI (satu aturan untuk favorit DAN progress, spec §5):
 *
 *   created === true   → PUSH  (akun BARU: adopsi rak device ini ke server)
 *   created !== true   → PULL  (akun lama, boot, ganti akun: server menang)
 *
 *   `created === true` sengaja TIDAK pull: server akun baru kosong, jadi pull
 *   akan mengosongkan rak lokal device yang baru saja didaftarkan.
 *
 * Semua error DI-telan (console.warn saja): endpoint /api/notif/* yang belum
 * ada (404) tidak boleh memblokir UI atau membuat error-loop.
 */

import { listFavorites, replaceFavorites } from './rakStore'
import { onAccountChange, getUser, type AccountEvent } from './account'
import { notifApi, type NotifFavorite } from './api'

const DEBOUNCE_MS = 2000

/** hash ringan (djb2) dari string — cukup untuk deteksi "sama / beda". */
function hash(s: string): string {
  let h = 5381
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0
  return String(h)
}

/** Daftar favorit lokal → bentuk ringkas yang dikirim ke server. */
function collect(): NotifFavorite[] {
  return listFavorites().map((f) => ({
    title_key: f.title_key,
    title: f.title,
    cover_url: f.cover_url,
    handle: f.handle,
    source: f.source,
  }))
}

let lastSentHash: string | null = null
let timer: ReturnType<typeof setTimeout> | null = null
let started = false
/** false sampai hydrate selesai — selama false, push DILARANG. */
let hydrated = false
let offAccount: (() => void) | null = null

function schedule(): void {
  if (!hydrated) return // hydrate belum selesai → jangan pernah push
  if (timer) clearTimeout(timer)
  timer = setTimeout(() => {
    timer = null
    void flush()
  }, DEBOUNCE_MS)
}

async function flush(): Promise<void> {
  if (!hydrated) return
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

/**
 * PULL: adopsi rak server ke lokal tanpa memicu push balik, lalu izinkan push.
 * Kalau gagal (404 / jaringan mati), push DITAHAN — push tanpa hydrate sukses
 * bisa menghapus favorit server.
 */
async function hydrate(): Promise<void> {
  try {
    const { favorites } = await notifApi.getFavorites()
    replaceFavorites(
      favorites.map((f) => ({
        title_key: f.title_key,
        title: f.title,
        cover_url: f.cover_url,
        handle: f.handle,
        source: f.source,
      })),
      { silent: true },
    )
    // snapshot inilah keadaan server sekarang — set hash-nya supaya flush
    // pertama tidak mengirim balik apa yang baru kita terima.
    lastSentHash = hash(JSON.stringify(collect()))
    hydrated = true
  } catch (err) {
    hydrated = false
    console.warn('notifStore: gagal hydrate favorit — push ditahan', err)
  }
}

/** Reaksi satu event akun: pilih arah, jangan pernah salah arah. */
async function onAccount(e: AccountEvent): Promise<void> {
  if (e.username === null) {
    // keluar: tidak ada scope server. Push dilarang sampai ada akun lagi.
    hydrated = false
    lastSentHash = null
    return
  }
  if (e.created === true) {
    // akun BARU → PUSH rak lokal ke server (adopsi rak device). Server masih
    // kosong; hydrate/pull justru akan mengosongkan rak lokal.
    hydrated = true
    lastSentHash = null
    schedule()
    return
  }
  // akun lama / boot / ganti akun → PULL (server menang).
  hydrated = false
  lastSentHash = null
  await hydrate()
}

/**
 * Mulai mendengarkan: hydrate dulu, baru push pada setiap 'rak-change'.
 * Aman dipanggil berulang (React StrictMode, HMR) — hanya pasang sekali.
 * Kembalikan fungsi stop (untuk test/teardown).
 */
export function startFavoritesSync(): () => void {
  if (typeof window === 'undefined') return () => {}
  if (started) return () => {}
  started = true

  window.addEventListener('rak-change', schedule)

  // ganti akun / daftar: arah ditentukan `created` (lihat onAccount).
  offAccount = onAccountChange((e) => {
    void onAccount(e)
  })

  // boot: PULL akun yang sedang aktif (created = null).
  void onAccount({ username: getUser(), created: null })

  return () => {
    window.removeEventListener('rak-change', schedule)
    if (offAccount) {
      offAccount()
      offAccount = null
    }
    if (timer) clearTimeout(timer)
    timer = null
    started = false
    hydrated = false
    lastSentHash = null
  }
}
