/* eslint-disable */
// Service worker komiku-web — baca komik walau internet jelek.
//
// Strategi per jenis request:
// - /img?u=...      : cache-first. Gambar immutable (path CDN per chapter tak
//                     pernah berubah) → sekali unduh, tersedia selamanya, juga
//                     saat offline.
// - /api/chapter/.. : stale-while-revalidate. Daftar halaman langsung tampil
//                     dari cache (menuai chaining offline), data segar diperbarui
//                     di belakang layar.
// - /api lain + shell same-origin : cache-first dengan update di background,
//                     fallback ke index.html yang di-precache (SPA jalan offline).
// - navigasi        : network-first, fallback cache.

const SHELL = 'komiku-shell-v2'
const IMG = 'komiku-img-v2'
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
            .filter((k) => ![SHELL, IMG, API].includes(k))
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

  // 1) gambar komik → cache-first (immutable)
  if (url.pathname === '/img') {
    e.respondWith(cacheFirst(req, IMG))
    return
  }

  // 1b) state notifikasi → network-first: badge unread HARUS segar.
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

  // 4) sisanya (CDN lama/hotlink) lewat jaringan biasa
})

async function cacheFirst(req, cacheName) {
  const cache = await caches.open(cacheName)
  const hit = await cache.match(req, { ignoreSearch: false })
  if (hit) {
    // gambar immutable: tak perlu revalidasi sama sekali
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

// pesan dari halaman: hangatkan cache (prefetch) / unduh offline
self.addEventListener('message', (e) => {
  // CACHE_CHAPTER dilayani handler terpisah di bawah — jangan diproses dua kali
  if (e.data && e.data.type === 'CACHE_CHAPTER') return
  const urls = e.data && e.data.urls
  if (!Array.isArray(urls) || urls.length === 0) return
  e.waitUntil(
    (async () => {
      const cache = await caches.open(IMG)
      for (const u of urls) {
        try {
          const req = new Request(u)
          if (!(await cache.match(req, { ignoreSearch: false }))) {
            const res = await fetch(req)
            if (res.ok) await cache.put(req, res)
          }
        } catch {
          /* salah satu URL gagal: lanjutkan yang lain */
        }
      }
    })(),
  )
})

// pesan {type:'CACHE_CHAPTER', urls:[...]}: simpan seluruh chapter ke
// komiku-img-v2 (skip yang sudah ada) sambil lapor progres ke halaman —
// CACHE_PROGRESS {done,total} per URL dan CACHE_DONE {ok} di akhir.
// catatan jujur: `done` hanya bertambah kalau URL benar-benar ada di cache
// (termasuk yang tadinya sudah), jadi UI bisa menampilkan "x/y tersimpan"
// tanpa mengklaim URL gagal sebagai sukses.
self.addEventListener('message', (e) => {
  if (!e.data || e.data.type !== 'CACHE_CHAPTER') return
  const urls = Array.isArray(e.data.urls) ? e.data.urls : []
  if (urls.length === 0) return
  e.waitUntil(
    (async () => {
      const total = urls.length
      const toClients = (msg) => {
        const src = e.source
        if (src && typeof src.postMessage === 'function') src.postMessage(msg)
        else
          self.clients.matchAll().then((cs) => cs.forEach((c) => c.postMessage(msg)))
      }
      const cache = await caches.open(IMG)
      let done = 0
      for (const u of urls) {
        try {
          const req = new Request(u)
          if (await cache.match(req, { ignoreSearch: false })) {
            done++
          } else {
            const res = await fetch(req)
            if (res.ok) {
              await cache.put(req, res)
              done++
            }
          }
        } catch {
          /* offline/putus: tidak dihitung sebagai tersimpan */
        }
        toClients({ type: 'CACHE_PROGRESS', done, total })
      }
      toClients({ type: 'CACHE_DONE', ok: done === total })
    })(),
  )
})
