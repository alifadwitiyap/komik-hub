/* eslint-disable */
// Service worker komiku-web — percepat shell, metadata API, DAN gambar halaman.
//
// Sejarah singkat: Q21 dulu melepas proxy `/img` (gambar di-hotlink langsung
// ke CDN) sehingga cache gambar di sini dibuang — respons lintas-origin opaque
// tidak bisa disajikan penuh/tepercaya. Proxy `/img` kini HIDUP LAGI dan
// gambarnya SAME-ORIGIN, jadi justru di sinilah letak menang besarnya:
// halaman yang pernah dibaca tersimpan penuh di perangkat → scroll balik,
// buka ulang chapter, dan baca offline jadi instan (0 byte).
//
// Strategi per jenis request:
// - /img?u=..&w=..  : cache-first (nama = URL CDN + lebar, isinya immutable),
//                     dengan batas jumlah entri supaya disk tidak penuh.
// - /api/notif/..   : network-first — badge unread HARUS segar.
// - /api lain       : stale-while-revalidate (daftar langsung tampil, segar
//                     menyusul di belakang layar).
// - aset same-origin (js/css/font) : cache-first + update di background.
// - navigasi        : network-first, fallback index.html yang di-precache.
// - request ber-header X-Komik-User : SELALU ke jaringan (state per-akun).

const SHELL = 'komiku-shell-v2'
const API = 'komiku-api-v2'
const IMG = 'komiku-img-v3'

/** Batas entri cache gambar. 400 halaman ≈ 40-60 MB — cukup untuk beberapa
 *  chapter, jauh di bawah kuota storage browser pada umumnya. */
const IMG_MAX_ENTRIES = 400

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(SHELL).then((c) => c.addAll(['/', '/index.html', '/offline.html'])),
  )
  self.skipWaiting()
})

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((k) => ![SHELL, API, IMG].includes(k))
            .map((k) => caches.delete(k)),
        ),
      )
      .then(() => self.clients.claim()),
  )
})

self.addEventListener('fetch', (e) => {
  const req = e.request
  if (req.method !== 'GET') return
  const url = new URL(req.url)

  // 0) STATE PER-AKUN → JANGAN PERNAH lewat cache SW.
  //    Cache `API` di bawah ini dipakai BERSAMA semua akun (cache key = URL,
  //    bukan header), jadi respons `/api/progress`, `/api/read`,
  //    `/api/notif/favorites`, `/api/unified/downloads` milik akun A bisa
  //    dilayani ke akun B. Itu bocor state antar-orang. Request yang bawa
  //    header `X-Komik-User` karena itu scoped akun → selalu ke jaringan.
  if (req.headers.get('X-Komik-User')) return

  // 1) GAMBAR halaman (proxy same-origin) → cache-first.
  //    URL-nya memuat URL CDN + lebar, dan isi CDN per chapter tidak pernah
  //    berubah → tidak perlu revalidasi. Ini yang membuat baca ulang/offline
  //    gratis byte-nya.
  if (url.pathname === '/img') {
    e.respondWith(cacheFirstImage(req))
    return
  }

  // 2) state notifikasi → network-first: badge unread HARUS segar.
  // Cache hanya fallback saat offline (SWR membuat badge basi sampai poll 60s).
  if (url.pathname.startsWith('/api/notif/')) {
    e.respondWith(networkFirst(req, API))
    return
  }

  // 3) API metadata → stale-while-revalidate
  if (url.pathname.startsWith('/api/')) {
    e.respondWith(staleWhileRevalidate(req, API))
    return
  }

  // 4) aset same-origin (js/css/font) → cache-first + bg update
  if (url.origin === self.location.origin) {
    if (req.mode === 'navigate') {
      e.respondWith(
        fetch(req).catch(() =>
          caches.match('/index.html').then((r) => r || caches.match('/')),
        ),
      )
      return
    }
    e.respondWith(cacheFirst(req, SHELL))
    return
  }

  // 5) lintas-origin + sisanya: lewat jaringan biasa
})

/** cache-first untuk gambar, dengan pemangkasan entri terlama. */
async function cacheFirstImage(req) {
  const cache = await caches.open(IMG)
  const hit = await cache.match(req)
  if (hit) return hit
  try {
    const res = await fetch(req)
    // Hanya simpan respons sukses yang benar-benar gambar; 403/502 jangan
    // di-cache, kalau tidak kegagalan sesaat jadi permanen di perangkat.
    if (res.ok && (res.headers.get('content-type') || '').startsWith('image/')) {
      cache.put(req, res.clone())
      trimCache(cache, IMG_MAX_ENTRIES)
    }
    return res
  } catch {
    return new Response('', { status: 504, statusText: 'offline' })
  }
}

async function trimCache(cache, maxEntries) {
  const keys = await cache.keys()
  if (keys.length <= maxEntries) return
  // urutan keys = urutan penyisipan → hapus yang paling lama
  for (const k of keys.slice(0, keys.length - maxEntries)) {
    await cache.delete(k)
  }
}

async function cacheFirst(req, cacheName) {
  const cache = await caches.open(cacheName)
  const hit = await cache.match(req, { ignoreSearch: false })
  if (hit) {
    // aset shell immutable (nama file ber-hash): tak perlu revalidasi
    return hit
  }
  try {
    const res = await fetch(req)
    if (res.ok) cache.put(req, res.clone())
    return res
  } catch {
    // offline & belum pernah di-cache: balas 504 dengan JSON yang bisa dibaca UI
    return new Response(JSON.stringify({ error: 'offline' }), {
      status: 504,
      headers: { 'content-type': 'application/json' },
    })
  }
}

async function staleWhileRevalidate(req, cacheName) {
  const cache = await caches.open(cacheName)
  const hit = await cache.match(req)
  const network = fetch(req)
    .then((res) => {
      if (res.ok) cache.put(req, res.clone())
      return res
    })
    .catch(() => null)
  if (hit) return hit
  const res = await network
  return (
    res ||
    new Response(JSON.stringify({ error: 'offline' }), {
      status: 504,
      headers: { 'content-type': 'application/json' },
    })
  )
}

// network-first: selalu coba jaringan; cache hanya dipakai saat offline.
// Untuk state yang harus segar (notifikasi) — BUKAN untuk konten baca.
async function networkFirst(req, cacheName) {
  const cache = await caches.open(cacheName)
  try {
    const res = await fetch(req)
    if (res.ok) cache.put(req, res.clone())
    return res
  } catch {
    const hit = await cache.match(req)
    return (
      hit ||
      new Response(JSON.stringify({ error: 'offline' }), {
        status: 504,
        headers: { 'content-type': 'application/json' },
      })
    )
  }
}
