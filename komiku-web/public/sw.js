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
//                     dengan batas byte + jumlah entri supaya disk tidak penuh.
// - /api/unified/downloads* : SELALU bypass (PDF besar + state per-akun).
//                     Bila ada ?fn=, Content-Disposition ditulis ulang RFC 5987
//                     (nama file UTF-8 tidak lagi mojibake) — tetap tanpa cache.
// - /api/notif/..   : network-first — badge unread HARUS segar.
// - /api lain       : stale-while-revalidate (daftar langsung tampil, segar
//                     menyusul di belakang layar).
// - aset same-origin (js/css/font) : cache-first + update di background.
// - navigasi        : network-first, fallback index.html yang di-precache.
// - request ber-header X-Komik-User : SELALU ke jaringan (state per-akun).

const SHELL = 'komiku-shell-v2'
// v3: buang cache API lama yang mungkin masih menyimpan PDF /api/unified/downloads.
const API = 'komiku-api-v3'
// v4: strategi batas gambar berubah (byte + entri), cache v3 lama dibuang.
const IMG = 'komiku-img-v4'

/**
 * Batas cache gambar.
 *
 * BATCH_MAX = 30 chapter × ~40 halaman × 3 lebar proxy ≈ 3.600 entri. Batas
 * lama 400 entri hanya menampung ~2 chapter, jadi batch 30 chapter dilaporkan
 * "sukses" padahal sebagian besar langsung tergusur. Batas sekarang:
 *   - 6.000 entri (jaring pengaman jumlah),
 *   - 300 MB byte (batas sebenarnya; respons proxy punya Content-Length).
 * Kalau `cache.put` tetap gagal (kuota browser penuh), respons ditandai
 * `X-Komiku-Cached: 0` → klien menghitung halaman itu GAGAL, bukan sukses.
 */
const IMG_MAX_ENTRIES = 6000
const IMG_MAX_BYTES = 300 * 1024 * 1024

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
  const url = new URL(req.url)
  const isDownload = url.pathname.startsWith('/api/unified/downloads')

  // 0) UNDUHAN (PDF + daftar) → JANGAN PERNAH masuk cache SW.
  //    Respons PDF bisa puluhan MB dan daftar/download adalah state per-akun;
  //    cache key = URL (bukan header) → bisa bocor antar-akun dan menahan
  //    file selamanya. DELETE tetap diteruskan ke jaringan, tapi entri cache
  //    lama dibersihkan.
  if (isDownload) {
    if (req.method === 'DELETE') e.waitUntil(purgeDownloadCache())
    // GET dengan ?fn= → hanya tulis ulang header nama file (RFC 5987), tidak
    // di-cache. Tanpa ?fn= biarkan browser mengambil langsung dari jaringan.
    if (req.method === 'GET' && url.searchParams.get('fn')) {
      e.respondWith(proxyDownloadWithFilename(req, url.searchParams.get('fn')))
    }
    return
  }

  if (req.method !== 'GET') return

  // 1) STATE PER-AKUN → JANGAN PERNAH lewat cache SW.
  //    Cache `API` di bawah ini dipakai BERSAMA semua akun (cache key = URL,
  //    bukan header), jadi respons `/api/progress`, `/api/read`,
  //    `/api/notif/favorites` milik akun A bisa dilayani ke akun B. Itu bocor
  //    state antar-orang. Request yang bawa header `X-Komik-User` DAN
  //    menyentuh state per-akun → selalu ke jaringan.
  //    Konten PUBLIK (chapter/series metadata, gambar) TETAP di-cache walau
  //    ada header — metadata chapter perlu cache supaya baca offline tetap
  //    jalan saat login, dan tidak mengandung state akun.
  const PRIVATE_PREFIXES = ['/api/notif/', '/api/progress', '/api/read', '/api/user/']
  if (req.headers.get('X-Komik-User')) {
    const p = url.pathname
    const isPrivate = PRIVATE_PREFIXES.some((pre) => p.startsWith(pre))
    if (isPrivate) return
  }

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

/** cache-first untuk gambar, dengan pemangkasan byte/entri terlama. */
async function cacheFirstImage(req) {
  const cache = await caches.open(IMG)
  // ignoreVary: gambar same-origin immutable — varian mime (WebP/AVIF) tidak
  // relevan untuk cache SW; match cukup berdasar URL. Tanpa ini, `Vary:
  // Accept` dari server bikin miss saat offline (Accept <img> ≠ Accept fetch).
  const hit = await cache.match(req, { ignoreVary: true })
  if (hit) return markCached(hit, true)
  try {
    const res = await fetch(req)
    // Hanya simpan respons sukses yang benar-benar gambar; 403/502 jangan
    // di-cache, kalau tidak kegagalan sesaat jadi permanen di perangkat.
    if (!res.ok || !(res.headers.get('content-type') || '').startsWith('image/')) {
      return markCached(res, false)
    }
    let stored = true
    try {
      // AWAIT put: kegagalan kuota harus ketahuan sekarang, bukan ditelan.
      await cache.put(req, res.clone())
      if (imgBytes !== null) imgBytes += contentLength(res)
      await trimCache(cache)
      // trim bisa mengusir entri baru kalau anggaran < ukuran satu gambar;
      // pastikan klien tidak mengira byte-nya tersimpan.
      stored = (await cache.match(req, { ignoreVary: true })) !== undefined
    } catch {
      stored = false
    }
    return markCached(res, stored)
  } catch {
    return new Response('', { status: 504, statusText: 'offline' })
  }
}

/** Beri tanda jujur ke klien: 1 = byte benar-benar ada di Cache Storage. */
function markCached(res, cached) {
  const headers = new Headers(res.headers)
  headers.set('X-Komiku-Cached', cached ? '1' : '0')
  return new Response(res.body, {
    status: res.status,
    statusText: res.statusText,
    headers,
  })
}

function contentLength(res) {
  const n = Number(res && res.headers.get('content-length'))
  return Number.isFinite(n) && n > 0 ? n : 0
}

/** Estimasi byte cache gambar; null = belum diukur (diukur malas saat perlu). */
let imgBytes = null

async function measureImgBytes(cache) {
  let total = 0
  for (const key of await cache.keys()) {
    total += contentLength(await cache.match(key, { ignoreVary: true }))
  }
  imgBytes = total
  return total
}

/**
 * Pangkas cache gambar: batas BYTE diutamakan, jumlah entri hanya jaring
 * pengaman. Urutan keys = urutan penyisipan → yang paling lama dihapus dulu.
 * Pengukuran byte dilakukan malas (sekali per umur SW) supaya tidak memindai
 * ribuan entri pada setiap gambar.
 */
async function trimCache(cache) {
  const keys = await cache.keys()
  let total = imgBytes
  // Di bawah 400 entri byte belum mungkin jadi masalah; hindari scan mahal.
  if (total === null && keys.length > 400) total = await measureImgBytes(cache)
  if (keys.length <= IMG_MAX_ENTRIES && (total === null || total <= IMG_MAX_BYTES)) return
  if (total === null) total = await measureImgBytes(cache)

  let excess = Math.max(0, keys.length - IMG_MAX_ENTRIES)
  for (const key of keys) {
    if (excess <= 0 && total <= IMG_MAX_BYTES) break
    total -= contentLength(await cache.match(key, { ignoreVary: true }))
    await cache.delete(key)
    excess--
  }
  imgBytes = Math.max(0, total)
}

/** Hapus semua entri unduhan lama dari cache API (dipanggil saat DELETE). */
async function purgeDownloadCache() {
  const cache = await caches.open(API)
  const keys = await cache.keys()
  await Promise.all(
    keys
      .filter((k) => new URL(k.url).pathname.startsWith('/api/unified/downloads'))
      .map((k) => cache.delete(k)),
  )
}

/**
 * Ambil PDF dari jaringan lalu tulis ulang Content-Disposition memakai
 * RFC 5987 (`filename*=UTF-8''…`). Server mengirim nama UTF-8 mentah di
 * `filename="…"`; sebagian browser men-decode-nya sebagai Latin-1 sehingga
 * nama file jadi "Iâ€™ll…". Body di-stream, tidak ditahan di memori.
 */
async function proxyDownloadWithFilename(req, filename) {
  try {
    const res = await fetch(req)
    if (!res.ok) return res
    const headers = new Headers(res.headers)
    // Body dari fetch sudah didekode; header kompresi/panjang asli tidak
    // lagi valid setelah dibungkus ulang.
    headers.delete('content-encoding')
    headers.delete('content-length')
    headers.set('Content-Disposition', contentDisposition(filename))
    return new Response(res.body, {
      status: res.status,
      statusText: res.statusText,
      headers,
    })
  } catch {
    return new Response(JSON.stringify({ error: 'offline' }), {
      status: 504,
      headers: { 'content-type': 'application/json' },
    })
  }
}

/** `attachment` + fallback ASCII + nama UTF-8 RFC 5987. */
function contentDisposition(filename) {
  const name = String(filename || '').replace(/[\r\n]/g, ' ').trim() || 'chapter.pdf'
  const ascii = name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_')
  const encoded = encodeURIComponent(name).replace(
    /['()*]/g,
    (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase(),
  )
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`
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
