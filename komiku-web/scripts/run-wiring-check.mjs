/**
 * Fixture server + runner untuk unified-wiring-check saat komiku-server
 * (8788) mati/lexistill aktif. Menyajikan dist/ + kontrak /api/unified/*
 * plus /api/homepage & /api/series & /api/chapter legacy, lalu menjalankan
 * check wiring di proses yang sama (port acak, tanpa proses background).
 *
 * Jalankan dari root repo:
 *   node scripts/run-wiring-check.mjs
 */
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.join(HERE, '..')
const DIST = path.join(ROOT, 'dist')

// --- fixture: bentuk kontrak persis komiku-server/src/unified.rs ------------
const MANGA = (source, native_id, title, extra = {}) => ({
  source,
  native_id,
  handle: `${source}:${native_id}`,
  title,
  // title_key = judul ter-normalisasi (mirip normalisasi server); judul SAMA
  // dari sumber berbeda menghasilkan key yang sama → favorit/sejarah rak
  // lintas-sumber nyambung.
  title_key: title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, ''),
  cover_url: `https://image2.komiku.to/${source}/${native_id}/cover.jpg`,
  author: 'Oda Eiichiro',
  status: 'Ongoing',
  manga_type: 'Manga',
  rating: '9.2',
  last_chapter: '1195',
  updated_at: 1760000000000,
  url: `https://v7.kiryuu.to/manga/${native_id}/`,
  ...extra,
})

const ITEMS = [
  MANGA('komiku', '6426', 'One Piece'),
  MANGA('kiryuu', 'solo-leveling', 'Solo Leveling', {
    cover_url: 'https://v2.yuucdn.net/wp-content/uploads/S/Solo/1.jpg',
    rating: '-',
    manga_type: 'Manhwa',
  }),
  MANGA('shinigami', 'abc123', 'Berserk', {
    cover_url: 'https://assets.shngm.id/berserk/cover.webp',
    status: 'Hiatus',
  }),
  MANGA('mangaku', '99', 'Vinland Saga', {
    cover_url: 'https://cdnkuma.my.id/vinland/cover.jpg',
  }),
  MANGA('kiryuu', 'aaa', 'Tate no Yuusha', {
    cover_url: 'https://cdn.jsdelivr.net/gh/x/y/cover.jpg',
  }),
]

// chapter list terbaru-dulu, dengan nomor desimal + non-numerik
const CHAPTERS = [
  { number: '3', title: 'Chapter 3', native_id: 'c3', updated_at: 1760000000000 },
  { number: '2.5', title: 'Chapter 2.5', native_id: 'c25', updated_at: 1759000000000 },
  { number: '1', title: '', native_id: 'c1', updated_at: 1758000000000 },
]
const CHAPTER_LIST = CHAPTERS.map(String).length && CHAPTERS.map((c) => String(c.number))
const CH_IMAGES = (h, n) => [
  `https://image2.komiku.to/${h}/${n}/001.jpg`,
  `https://v2.yuucdn.net/${h}/${n}/002.jpg`,
  `https://assets.shngm.id/${h}/${n}/003.jpg`,
]

// --- state rak: unduhan PDF, eviction, settings (kontrak rak-buku.md) -------
const DEFAULT_LIMIT = 2 * 1024 * 1024 * 1024 // 2 GB
const downloads = [] // {id, handle, number, title, series_title, filename, size_bytes, ...}
const evictions = [] // {series_title, chapter_title, size_bytes, evicted_at}
let limitBytes = DEFAULT_LIMIT
let downloadSeq = 0

const PdfBytes = Buffer.from('%PDF-1.4 fixture pdf (bukan PDF asli)\n%%EOF\n', 'utf8')

function totals() {
  return downloads.reduce((a, d) => a + d.size_bytes, 0)
}

/** Baca body JSON sebuah request (dipakai POST/PUT fixture). */
function readJsonBody(req) {
  return new Promise((resolve) => {
    let raw = ''
    req.on('data', (c) => {
      raw += c
    })
    req.on('end', () => {
      try {
        resolve(raw ? JSON.parse(raw) : {})
      } catch {
        resolve({})
      }
    })
  })
}

function chapterOf(h, n) {
  const i = CHAPTER_LIST.indexOf(n)
  // kontrak v2: prev/next = objek {number, source, handle}. Di fixture,
  // chapter setelah nomor 1 di-host kiryuu (fallback lintas-sumber) supaya
  // navigasi reader benar-benar melewati handle lain.
  const ref = (num, owner) =>
    num == null
      ? null
      : {
          number: num,
          source: owner,
          handle: `${owner}:${owner === 'komiku' ? '6426' : 'solo-leveling'}`,
        }
  // pemetaan: '1' & '2.5' di komiku, '3' di kiryuu
  const hostOf = (num) => (num === '3' ? 'kiryuu' : 'komiku')
  const prevNum = i >= 0 && i + 1 < CHAPTER_LIST.length ? CHAPTER_LIST[i + 1] : null
  const nextNum = i > 0 ? CHAPTER_LIST[i - 1] : null
  // kontrak rak: series pemilik chapter (title_key + snapshot sampul)
  const owner = ITEMS.find((m) => m.handle === h)
  return {
    title: n === '1' ? '' : `Chapter ${n}`,
    number: n,
    source: h.split(':')[0],
    images: CH_IMAGES(h, n),
    prev: prevNum == null ? null : ref(prevNum, hostOf(prevNum)),
    next: nextNum == null ? null : ref(nextNum, hostOf(nextNum)),
    title_key: owner ? owner.title_key : '',
    handle: h,
    cover_url: owner ? owner.cover_url : null,
  }
}

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x.invalid')
  const json = (o, code = 200) => {
    res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify(o))
  }
  const p = decodeURIComponent(u.pathname)

  if (p.startsWith('/img')) {
    const t = u.searchParams.get('u') || ''
    const hosts = /^https:\/\/(img\.komiku\.org|thumbnail\.komiku\.org|image2\.komiku\.to|image3\.komiku\.to|assets\.shngm\.id|storage\.shngm\.id|cdnkuma\.my\.id|cdn\.jsdelivr\.net|v2\.yuucdn\.net|v7\.kiryuu\.to)\//.test(t)
    if (!hosts) return json({ error: 'host gambar tidak diizinkan' }, 403)
    res.writeHead(200, { 'content-type': 'image/jpeg' })
    return res.end(Buffer.from('fixture'))
  }
  if (p === '/api/unified/search') {
    const q = (u.searchParams.get('q') || '').toLowerCase()
    const hits = ITEMS.filter((i) => i.title.toLowerCase().includes(q))
    // harborkan "one" → One Piece (komiku) supaya selalu ada hasil; yang
    // non-komiku muncul lewat kata kunci lain (solo/berserk/vinland).
    return json({
      items: hits.length > 0 ? hits : [ITEMS[0]],
      failed_sources: ['mangaku'],
    })
  }
  if (p === '/api/unified/latest' || p === '/api/unified/popular')
    return json({ items: ITEMS, failed_sources: [] })
  if (p === '/api/unified/genres')
    return json({ items: [{ slug: 'action', name: 'Action', sources: ['komiku', 'kiryuu'] }] })
  const sm = /^\/api\/unified\/series\/(.+)$/.exec(p)
  if (sm) {
    const h = sm[1]
    const m = ITEMS.find((i) => i.handle === h)
    if (!m) return json({ error: 'manga tidak ditemukan' }, 404)
    return json({ manga: m, chapters: CHAPTERS, source: h.split(':')[0], failed_sources: [], from_cache: false })
  }
  const cm = /^\/api\/unified\/chapter\/(.+)\/([^/]+)$/.exec(p)
  if (cm) {
    const h = cm[1]
    if (!ITEMS.some((i) => i.handle === h)) return json({ error: 'manga tidak ditemukan' }, 404)
    if (!CHAPTER_LIST.includes(cm[2])) return json({ error: 'chapter tidak ditemukan' }, 404)
    return json(chapterOf(h, cm[2]))
  }

  // --- rak/PDF: kontrak D:/project/komik/.omh/plans/rak-buku.md ------------
  if (p === '/api/unified/download-pdf' && req.method === 'POST') {
    const body = await readJsonBody(req)
    const m = ITEMS.find((i) => i.handle === body.handle)
    if (!m) return json({ error: 'manga tidak ditemukan' }, 404)
    if (!CHAPTER_LIST.includes(String(body.number))) {
      return json({ error: 'chapter tidak ditemukan' }, 404)
    }
    const size = 100 * 1024 // 100 KB per chapter (fixture)
    // eviction sederhana: buang LRU (downloaded_at terlama) sampai muat
    while (downloads.length > 0 && totals() + size > limitBytes) {
      const victim = downloads.shift()
      evictions.push({
        series_title: victim.series_title,
        chapter_title: victim.title,
        size_bytes: victim.size_bytes,
        evicted_at: Date.now(),
      })
    }
    if (totals() + size > limitBytes) {
      return json({ error: 'batas penyimpanan tidak cukup' }, 400)
    }
    const id = `dl-${++downloadSeq}`
    const item = {
      id,
      handle: m.handle,
      number: String(body.number),
      title: `Chapter ${body.number}`,
      series_title: m.title,
      filename: `${m.title_key}-${body.number}.pdf`,
      size_bytes: size,
      downloaded_at: Date.now(),
      last_opened_at: null,
    }
    downloads.push(item)
    return json({
      id: item.id,
      filename: item.filename,
      title: item.title,
      series_title: item.series_title,
      size_bytes: item.size_bytes,
    })
  }
  if (p === '/api/unified/downloads' && req.method === 'GET') {
    return json({ items: downloads, total_bytes: totals(), limit_bytes: limitBytes })
  }
  const dm = /^\/api\/unified\/downloads\/([^/]+)$/.exec(p)
  if (dm) {
    const found = downloads.find((d) => d.id === dm[1])
    if (req.method === 'DELETE') {
      if (!found) return json({ error: 'unduhan tidak ditemukan' }, 404)
      downloads.splice(downloads.indexOf(found), 1)
      return json({ deleted: true })
    }
    if (!found) return json({ error: 'unduhan tidak ditemukan' }, 404)
    // GET file: SEKALIGUS update last_opened_at (LRU)
    found.last_opened_at = Date.now()
    res.writeHead(200, {
      'content-type': 'application/pdf',
      'content-disposition': `attachment; filename="${found.filename}"`,
    })
    return res.end(PdfBytes)
  }
  if (p === '/api/unified/evictions' && req.method === 'GET') {
    return json({ items: evictions })
  }
  if (p === '/api/unified/evictions/dismiss' && req.method === 'POST') {
    evictions.length = 0
    return json({ ok: true })
  }
  if (p === '/api/unified/settings/downloads') {
    if (req.method === 'PUT') {
      const body = await readJsonBody(req)
      const n = Number(body.limit_bytes)
      if (!Number.isFinite(n) || n < 0) return json({ error: 'limit_bytes tidak valid' }, 400)
      limitBytes = n
      return json({ limit_bytes: limitBytes })
    }
    return json({ limit_bytes: limitBytes })
  }
  // --- flow Komiku existing (harus tetap hijau) ----------------------------
  if (p === '/api/homepage')
    return json({
      success: true,
      populer: {
        title: 'Populer',
        data: [{ id: 6426, title: 'One Piece', thumbnail: 'https://img.komiku.org/a.jpg', tipe: ['Manga'], status: ['Ongoing'], score: '9' }],
      },
    })
  if (p.startsWith('/api/series/'))
    return json({
      series: {
        id: Number(p.split('/').pop()),
        title: 'One Piece',
        author: 'Oda',
        synopsis: 'Petualangan bajak laut.',
        genre: [{ name: 'Action', id: '1' }],
        statusmanga: [{ name: 'Ongoing', id: '1' }],
        tipe: [{ name: 'Manga', id: '1' }],
      },
      chapters: [
        { name: 'Chapter 2', id: 1002, date: '1 hari lalu' },
        { name: 'Chapter 1', id: 1001, date: '2 hari lalu' },
      ],
      related: [],
    })
  if (p.startsWith('/api/chapter/'))
    return json({
      chapter: {
        id: Number(p.split('/').pop()),
        name: 'Chapter 1',
        number: 1,
        previous: null,
        next: { id: 1002, name: 'Chapter 2' },
      },
      images: ['https://img.komiku.org/1/001.jpg'],
      series: { id: 6426, title: 'One Piece' },
    })
  if (p === '/api/search') return json({ page: 1, count: 1, manga: ITEMS.map(toLegacy) })

  // SPA fallback (untuk render HTML)
  let file = path.join(DIST, p === '/' ? 'index.html' : p)
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) file = path.join(DIST, 'index.html')
  const ext = path.extname(file)
  const mime = ext === '.html' ? 'text/html' : ext === '.js' ? 'text/javascript' : ext === '.css' ? 'text/css' : 'application/octet-stream'
  res.writeHead(200, { 'content-type': mime })
  return fs.createReadStream(file).pipe(res)
})

function toLegacy(m) {
  return { id: Number(m.native_id) || 1, title: m.title, thumbnail: m.cover_url }
}

server.listen(0, '127.0.0.1', () => {
  const port = server.address().port
  // URL fixture server ditulis ke file karena Vite `define` men-static-kan
  // process.env saat bundling (env runtime tidak terbawa ke bundle).
  fs.writeFileSync(path.join(ROOT, '.checkbase'), `http://127.0.0.1:${port}`)
  // PENTING: spawn ASYNC — spawnSync mem-blok event loop induk, jadi server
  // fixture di proses ini tidak akan pernah sempat menjawab request child.
  run()
    .catch((e) => {
      console.error(e)
      process.exitCode = 1
    })
    .finally(() => server.close())
})

/** Bundle lalu jalankan check; menunggu child selesai tanpa mem-blok loop. */
function run() {
  return new Promise((resolve, reject) => {
    const built = spawn(
      process.execPath,
      [path.join(ROOT, 'scripts/vite-run-check.mjs'), 'scripts/unified-wiring-check.ts', path.join(ROOT, '.checktmp')],
      { cwd: ROOT, stdio: 'inherit' },
    )
    built.on('exit', (code) => {
      if (code !== 0) {
        reject(new Error(`bundling gagal (exit ${code})`))
        return
      }
      const child = spawn(process.execPath, [path.join(ROOT, '.checktmp/check.mjs')], { stdio: 'inherit' })
      child.on('exit', (c) => {
        fs.rmSync(path.join(ROOT, '.checkbase'), { force: true })
        if (c !== 0) {
          reject(new Error(`check gagal (exit ${c})`))
          return
        }
        resolve()
      })
    })
  })
}
