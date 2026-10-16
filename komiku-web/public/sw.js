/* eslint-disable */
// Service worker komiku-web — percepat shell + metadata API.
//
// Keputusan Q21/Q11 (plan komiku-ringan-homeserver): gambar di-hotlink
// LANGSUNG dari CDN, jadi tidak ada cache gambar di sini dan cache offline
// in-app dibuang. Yang tersisa hanya percepatan shell same-origin & metadata
// API.
//
// Strategi per jenis request:
// - /api/notif/..  : network-first — badge unread HARUS segar.
// - /api lain      : stale-while-revalidate (daftar halaman langsung tampil,
//                    data segar menyusul di belakang layar).
// - aset same-origin (js/css/font) : cache-first + update di background.
// - navigasi       : network-first, fallback index.html yang di-precache.
// - gambar CDN + sisanya: lewat jaringan biasa (hotlink, tanpa cache SW).

const SHELL = 'komiku-shell-v2'
const API = 'komiku-api-v2'

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
            .filter((k) => ![SHELL, API].includes(k))
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

  // 1) state notifikasi → network-first: badge unread HARUS segar.
  // Cache hanya fallback saat offline (SWR membuat badge basi sampai poll 60s).
  if (url.pathname.startsWith('/api/notif/')) {
    e.respondWith(networkFirst(req, API))
    return
  }

  // 2) API metadata → stale-while-revalidate
  if (url.pathname.startsWith('/api/')) {
    e.respondWith(staleWhileRevalidate(req, API))
    return
  }

  // 3) aset same-origin (js/css/font) → cache-first + bg update
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

  // 4) gambar CDN + sisanya: lewat jaringan biasa (hotlink; tanpa cache SW)
})

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
