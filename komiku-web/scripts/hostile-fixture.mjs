/**
 * Fixture server HOSTILE untuk QA adversarial komiku-web (multi-source).
 * Tidak mengubah file produksi; hanya skrip verifikasi (diizinkan task).
 *
 * Menyajikan:
 *   - dist/ (bundle hasil `npm run build`) + SPA fallback,
 *   - /api/unified/* dengan judul BERBAHAYA (XSS payload), handle aneh,
 *     cover_url dari host liar / data-URI,
 *   - mode broken: semua /api/unified/* gagal (500 HTML) supaya fallback
 *     Search.tsx → /api/search legacy terbukti end-to-end,
 *   - /api/search legacy (judul khas "LEGACY ...") + /api/homepage lama.
 *
 * Pakai:
 *   node scripts/hostile-fixture.mjs [port] [--broken]
 * atau impor startHostileServer() dari runner lain.
 */
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.join(HERE, '..')
const DIST = path.join(ROOT, 'dist')

/** PNG 1x1 valid supaya <img> di browser benar-benar "load". */
const PNG_1PX = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
)

/** subset markup yang TIDAK boleh muncul sebagai tag nyata di HTML hasil render. */
export const XSS_PAYLOADS = [
  '<script>alert(1)</script>',
  '\' onerror=\'alert(2)\' x=\'',
  '<img src=x onerror=alert(3)>',
  '</title><script>alert(4)</script>',
  '졸업한 만화 💥🔥',
  'x'.repeat(500),
]

/** handle yang berasal dari API (bukan user) — boleh mengandung apa saja. */
export const ODD_HANDLES = [
  'komiku:6426', // normal unified
  'kiryuu:solo-leveling', // native_id non-numerik
  'a b:9', // spasi
  'pct%20id:1', // persen
  'x:y:z', // lebih dari satu ':'
  'dotdot:../1', // traversal-ish native_id
  'slash://evil', // tanda //
]

/** URL gambar yang harus/bukan harus lewat proxy /img (lihat src/imgUrl.ts). */
export const IMG_FIXTURE = {
  komiku: ['https://img.komiku.org/a.jpg', 'https://image2.komiku.to/b.png'],
  other: [
    'https://cdnkuma.my.id/c.jpg',
    'https://v2.yuucdn.net/d.jpg',
    'https://assets.shngm.id/e.webp',
    'https://cdn.jsdelivr.net/gh/a/b.png',
    'https://storage.shngm.id/f.jpg',
  ],
  jahat: [
    'https://evil.example.com/1.jpg',
    'http://127.0.0.1:1/2.jpg',
    'data:image/svg+xml;base64,PHN2Zy8+',
    'javascript:alert(1)',
    '//evil.example.com/3.jpg',
    '/img?u=https%3A%2F%2Fimg.komiku.org%2Fa%2F1.jpg', // sudah proxy
  ],
}

const manga = (source, native_id, title, extra = {}) => ({
  source,
  native_id,
  handle: `${source}:${native_id}`,
  title,
  // title_key ter-normalisasi (server) — judul sama lintas sumber = key sama
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
  url: 'https://v7.kiryuu.to/manga/x/',
  ...extra,
})

const ITEMS = [
  manga('komiku', '6426', XSS_PAYLOADS[0]),
  manga('kiryuu', 'solo-leveling', XSS_PAYLOADS[1], {
    cover_url: XSS_PAYLOADS[4], // emoji-string sebagai URL sampul (bukan URL valid)
    url: 'javascript:alert(5)',
  }),
  manga('shinigami', 'abc123', XSS_PAYLOADS[2]),
  manga('mangaku', '99', XSS_PAYLOADS[3], { cover_url: IMG_FIXTURE.jahat[0] }),
  manga('kiryuu', 'aaa', XSS_PAYLOADS[5], {
    cover_url: IMG_FIXTURE.other[0],
    url: `https://v7.kiryuu.to/${XSS_PAYLOADS[0]}/`,
  }),
]

const CHAPTERS = [
  { number: '3', title: XSS_PAYLOADS[0], native_id: 'c3', updated_at: 1760000000000 },
  { number: '2.5', title: XSS_PAYLOADS[1], native_id: 'c25', updated_at: 1759000000000 },
  { number: '1', title: '', native_id: 'c1', updated_at: 1758000000000 },
]

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

export function createHostileServer({ distDir = DIST, broken = false } = {}) {
  return http.createServer(async (req, res) => {
    const u = new URL(req.url, 'http://x.invalid')
    const json = (o, code = 200) => {
      res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify(o))
    }
    const p = decodeURIComponent(u.pathname)
    const q = u.searchParams.get('q') ?? ''

    // proxy /img palsu: hanya host yang sama dengan allowlist imgUrl.ts
    if (p.startsWith('/img')) {
      const t = u.searchParams.get('u') || ''
      const allowed =
        /^(https?:)?\/\/(img\.komiku\.org|thumbnail\.komiku\.org|image2\.komiku\.to|image3\.komiku\.to|assets\.shngm\.id|storage\.shngm\.id|cdnkuma\.my\.id|cdn\.jsdelivr\.net|v2\.yuucdn\.net|v7\.kiryuu\.to)\//.test(
          t,
        )
      if (!allowed) return json({ error: 'host gambar tidak diizinkan' }, 403)
      res.writeHead(200, { 'content-type': 'image/png' })
      return res.end(PNG_1PX)
    }

    // --- mode broken: seluruh unified mati (untuk uji fallback Search) -----
    if (broken && p.startsWith('/api/unified/')) {
      res.writeHead(500, { 'content-type': 'text/html; charset=utf-8' })
      return res.end('<html><body>upstream unified mati total</body></html>')
    }

    // --- kontrak unified (isi JAHAT) -------------------------------------
    if (p === '/api/unified/search') {
      // q khusus = paksa gagal tanpa mode flag (Search.tsx mengirim q apa saja)
      if (q === 'failmode') {
        res.writeHead(500, { 'content-type': 'text/html; charset=utf-8' })
        return res.end('<html><body>upstream mati total</body></html>')
      }
      if (q === 'notfoundmode')
        return json({ error: 'route belum dikompilasi', hint: 'jalankan server unified' }, 501)
      return json({ items: ITEMS, failed_sources: ['mangaku', 'kiryuu'] })
    }
    if (p === '/api/unified/latest' || p === '/api/unified/popular')
      return json({ items: ITEMS, failed_sources: ['mangaku'] })
    if (p === '/api/unified/genres')
      return json({ items: [{ slug: 'action', name: 'Action', sources: ['komiku'] }] })
    const sm = /^\/api\/unified\/series\/(.+)$/.exec(p)
    if (sm) {
      const h = sm[1]
      const found = ITEMS.find((i) => i.handle === h)
      if (!found) return json({ error: 'manga tidak ditemukan' }, 404)
      return json({
        manga: { ...found, title: `<b>${found.title}</b>` },
        chapters: CHAPTERS,
        source: h.split(':')[0],
        failed_sources: [],
      })
    }
    const cm = /^\/api\/unified\/chapter\/(.+)\/([^/]+)$/.exec(p)
    if (cm) {
      const h = cm[1]
      if (!ITEMS.some((i) => i.handle === h)) return json({ error: 'tidak ada' }, 404)
      return json({
        title: XSS_PAYLOADS[0],
        number: cm[2],
        source: h.split(':')[0],
        images: [...IMG_FIXTURE.other, ...IMG_FIXTURE.jahat, ''],
        prev: { number: '1', source: 'komiku', handle: 'komiku:6426' },
        next: { number: '3', source: 'kiryuu', handle: 'kiryuu:solo-leveling' },
        // rak: series pemilik chapter (digunakan reader untuk riwayat)
        title_key: 'hostile-series',
        handle: h,
        cover_url: IMG_FIXTURE.other[0],
      })
    }

    // --- rak/PDF (kontrak rak-buku.md; isi JAHAT) --------------------------
    if (p === '/api/unified/download-pdf' && req.method === 'POST') {
      const body = await readJsonBody(req)
      if (body.handle === 'komiku:6426' && body.number === 'failmode') {
        res.writeHead(500, { 'content-type': 'text/html; charset=utf-8' })
        return res.end('<html>pdf generator meledak</html>')
      }
      const m = ITEMS.find((i) => i.handle === body.handle)
      if (!m) return json({ error: 'manga tidak ditemukan' }, 404)
      return json({
        id: 'dl-hostile-1',
        filename: `${XSS_PAYLOADS[0]}.pdf`,
        title: XSS_PAYLOADS[0],
        series_title: `<b>${m.title}</b>`,
        size_bytes: 100 * 1024,
      })
    }
    if (p === '/api/unified/downloads' && req.method === 'GET') {
      return json({
        items: [
          {
            id: 'dl-hostile-1',
            handle: 'komiku:6426',
            number: '3',
            title: XSS_PAYLOADS[0],
            series_title: `<b>${XSS_PAYLOADS[1]}</b>`,
            filename: 'x.pdf',
            size_bytes: 100 * 1024,
            downloaded_at: 1760000000000,
            last_opened_at: null,
          },
        ],
        total_bytes: 100 * 1024,
        limit_bytes: 2 * 1024 * 1024 * 1024,
      })
    }
    const dm = /^\/api\/unified\/downloads\/([^/]+)$/.exec(p)
    if (dm) {
      if (req.method === 'DELETE') return json({ deleted: true })
      res.writeHead(200, {
        'content-type': 'application/pdf',
        'content-disposition': `attachment; filename="x.pdf"`,
      })
      return res.end(Buffer.from('%PDF-1.4 hostile\n%%EOF\n', 'utf8'))
    }
    if (p === '/api/unified/evictions' && req.method === 'GET') {
      return json({
        items: [
          {
            series_title: `<b>${XSS_PAYLOADS[1]}</b>`,
            chapter_title: XSS_PAYLOADS[2],
            size_bytes: 5 * 1024 * 1024,
            evicted_at: 1760000000000,
          },
        ],
      })
    }
    if (p === '/api/unified/evictions/dismiss' && req.method === 'POST') {
      return json({ ok: true })
    }
    if (p === '/api/unified/settings/downloads') {
      if (req.method === 'PUT') {
        const body = await readJsonBody(req)
        return json({ limit_bytes: Number(body.limit_bytes) || 0 })
      }
      return json({ limit_bytes: 2 * 1024 * 1024 * 1024 })
    }

    // --- flow Komiku lama (fallback Search) ------------------------------
    if (p === '/api/homepage')
      return json({
        success: true,
        populer: {
          title: 'Populer',
          data: [
            {
              id: 6426,
              title: 'One Piece',
              thumbnail: 'https://img.komiku.org/a.jpg',
              tipe: ['Manga'],
              status: ['Ongoing'],
            },
          ],
        },
      })
    if (p.startsWith('/api/series/'))
      return json({
        series: { id: 6426, title: 'One Piece', synopsis: 'x' },
        chapters: [
          { name: 'Chapter 2', id: 1002 },
          { name: 'Chapter 1', id: 1001 },
        ],
        related: [],
      })
    if (p.startsWith('/api/chapter/'))
      return json({
        chapter: { id: 1001, name: 'Chapter 1', previous: null, next: { id: 1002, name: 'C2' } },
        images: ['https://img.komiku.org/1/001.jpg'],
        series: { id: 6426, title: 'One Piece' },
      })
    if (p === '/api/search')
      return json({
        page: 1,
        count: 1,
        manga: [
          {
            id: 6426,
            title: `LEGACY ${q || 'search'} · One Piece`,
            thumbnail: 'https://img.komiku.org/a.jpg',
            tipe: ['Manga'],
          },
        ],
      })

    // --- SPA -------------------------------------------------------------
    const candidate = path.join(distDir, p)
    const file =
      !fs.existsSync(candidate) || !fs.statSync(candidate).isFile()
        ? path.join(distDir, 'index.html')
        : candidate
    const ext = path.extname(file)
    const mime =
      ext === '.html'
        ? 'text/html'
        : ext === '.js'
          ? 'text/javascript'
          : ext === '.css'
            ? 'text/css'
            : 'application/octet-stream'
    res.writeHead(200, { 'content-type': mime })
    fs.createReadStream(file).pipe(res)
  })
}

export function startHostileServer(port = 0, opts = {}) {
  const server = createHostileServer(opts)
  return new Promise((resolve) => {
    server.listen(port, '127.0.0.1', () => {
      const p = server.address().port
      resolve({ server, base: `http://127.0.0.1:${p}` })
    })
  })
}

// CLI: node scripts/hostile-fixture.mjs [port] [--broken]
if (process.argv[1]?.endsWith('hostile-fixture.mjs')) {
  const port = Number(process.argv.find((a) => /^\d+$/.test(a)) ?? 8899)
  const broken = process.argv.includes('--broken')
  startHostileServer(port, { broken }).then(({ base }) => {
    console.log(`hostile fixture (${broken ? 'BROKEN unified' : 'normal'}) → ${base}`)
  })
}
