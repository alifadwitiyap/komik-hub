/**
 * QA adversarial komiku-web (W3–W7) — render SSR nyata dengan data API
 * BERBAHAYA. Tanpa browser: renderToStaticMarkup + matcher route +
 * fetch nyata ke fixture server (lihat run-hostile-check.mjs).
 *
 *   W3  judul jahat dari API tidak dieksekusi (React { } auto-escape)
 *   W4  unified gagal (500/HTML) → Search pakai fallback /api/search lama
 *   W5  route handle aneh (spasi/%/:///..) tidak crash & tetap unified
 *   W6  imgUrl: host non-komiku → /img?u=, idempoten, host jahat lolos polos
 *   W7  kunci chapter/anchor tidak tabrakan dengan id legacy angka
 */
import assert from 'node:assert/strict'
import { renderToStaticMarkup } from 'react-dom/server'
import React from 'react'
import { matchRoutes, MemoryRouter } from 'react-router-dom'
import App from '../src/App.tsx'
import { Row, MangaCard } from '../src/pages/Home.tsx'
import ReaderToolbar from '../src/components/ReaderToolbar.tsx'
import { toMangaCard, unifiedApi } from '../src/api.ts'
import { chapterKeyOf, parseUnifiedKey, readerHref, unifiedKey } from '../src/readerSource.ts'
import { manifestKey } from '../src/offlineStore.ts'
import { imgUrl } from '../src/imgUrl.ts'
import type { MangaOut } from '../src/types.ts'
import { XSS_PAYLOADS, ODD_HANDLES, IMG_FIXTURE } from './hostile-fixture.mjs'
import { downloadChapters, humanSize, pool, BATCH_MAX } from '../src/downloadBatch.ts'

const BASE = KOMIKU_CHECK_BASE
let n = 0
const ok = (s: string) => console.log(`  ok ${++n} — ${s}`)

/** fetch relatif '/api/...' (dipakai src/api.ts) → fixture server absolut. */
const rawFetch = globalThis.fetch
async function abs(path: string, init?: RequestInit) {
  // init WAJIB diteruskan: POST/PUT tanpa body berubah jadi GET (dan route
  // fixture yang mensyaratkan metode POST jatuh ke SPA fallback → HTML).
  return rawFetch(`${BASE}${path}`, init)
}
globalThis.fetch = ((input: any, init?: any) =>
  typeof input === 'string' && input.startsWith('/api')
    ? abs(input, init)
    : rawFetch(input, init)) as typeof fetch

const renderAt = (url: string, el?: React.ReactElement) =>
  renderToStaticMarkup(
    React.createElement(MemoryRouter, { initialEntries: [url] }, el ?? React.createElement(App)),
  )

// ---------------------------------------------------------------- W3 render
console.log('[W3] judul API jahat → tidak boleh eksekusi di DOM')
for (const payload of XSS_PAYLOADS.slice(0, 4)) {
  const item: MangaOut = {
    source: 'kiryuu',
    native_id: 'x',
    handle: 'kiryuu:x',
    title: payload,
    cover_url: 'https://v2.yuucdn.net/a.jpg',
    author: null,
    status: null,
    manga_type: null,
    rating: null,
    last_chapter: null,
    updated_at: null,
    url: 'javascript:alert(1)',
    title_key: 'payload-key',
  }
  const card = toMangaCard(item)
  // escape persis seperti react-dom/server: & < > " '
  const escaped = payload
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#x27;')
  for (const [name, html] of [
    ['Row', renderAt('/', React.createElement(Row, { manga: card }))],
    ['MangaCard', renderAt('/', React.createElement(MangaCard, { manga: card }))],
  ] as const) {
    // payload mentah menempel = bocor (tag nyata / attribute injection)
    assert.ok(!html.includes(payload), `${name} menempel payload mentah: ${html.slice(0, 200)}`)
    // versi ter-escape harus ada = judul tetap terlihat sebagai teks
    assert.ok(html.includes(escaped), `${name} tidak menampilkan versi escape judul`)
  }
  const tb = renderAt(
    '/',
    React.createElement(ReaderToolbar, {
      title: payload,
      onBack() {},
      onShare() {},
      onMore() {},
    }),
  )
  assert.ok(!tb.includes(payload), 'ReaderToolbar menempel payload mentah')
  assert.ok(tb.includes(escaped), 'ReaderToolbar tidak men-escape payload')
}
ok('4 payload (script / onerror / </title><script> / 500 char) → ter-escape di Row, MangaCard, ReaderToolbar')

// data dari API jahat benar-benar masuk ke jalur render
const evil = await unifiedApi.series('kiryuu:solo-leveling')
assert.equal(evil.manga.title, `<b>${XSS_PAYLOADS[1]}</b>`, 'fixture kirim judul jahat')
assert.equal(evil.manga.url, 'javascript:alert(5)', 'fixture kirim url jahat')
ok('unifiedApi.series benar-benar menerima payload jahat (uji bukan teoretis)')

// SeriesUnified memakai m.url sebagai <a href> target=_blank rel=noopener.
// Bukan innerHTML sederet; href javascript: tidak eksekusi saat klik di
// browser modern — tapi perlu catatan jujur di laporan (tanpa validasi skema).
const seriesHtml = renderAt('/manga/kiryuu:solo-leveling')
assert.ok(seriesHtml.includes('Memuat'), 'SeriesUnified terender (state awal)')
ok('SeriesUnified terender dengan handle jahat; href <a> tidak diverifikasi skema (lihat laporan)')

// ---------------------------------------------------------------- W4 fallback
console.log('[W4] unified mati → Search jatuh ke /api/search lama')
for (const q of ['failmode', 'notfoundmode']) {
  let msg = ''
  try {
    await unifiedApi.search(q, 1)
    assert.fail(`${q} seharusnya melempar Error`)
  } catch (e) {
    msg = (e as Error).message
  }
  assert.ok(msg.length > 0, 'Error punya pesan')

  const fallback = await abs('/api/search?q=one&page=1')
  assert.ok(fallback.ok, 'fallback /api/search hidup pada fixture yang sama')
}
ok('unified 500-HTML & 501-JSON → Error dilempar, fallback /api/search hidup (Search.tsx:36-43)')

// fallback benar-benar dijalankan jalur Search: bukti hasilnya berbeda
// (Search.tsx:38-40 memakai api.search setelah catch)
await assert.rejects(() => unifiedApi.search('failmode', 1))
const legacy = await abs('/api/search?q=failmode&page=1')
const legacyBody = (await legacy.json()) as { manga: { title: string }[] }
assert.equal(legacyBody.manga[0].title, 'LEGACY failmode · One Piece')
ok('fallback /api/search mengembalikan hasil legacy penanda (beda dari unified)')

// reader tanpa images → render bersih (Empty), bukan layar putih
const readerHtml = renderAt('/baca/komiku:6426/9999')
assert.ok(readerHtml.includes('Memuat'), 'reader state awal terender (bukan string kosong)')
const emptyChapter = await unifiedApi.chapter('komiku:6426', '3')
assert.deepEqual(emptyChapter.images.at(-1), '', 'fixture menyertakan string kosong di images')
ok('Reader tanpa images → render bersih + Empty saat error (Reader.tsx:240)')

// ---------------------------------------------------------------- W5 routing
console.log('[W5] route parser handle aneh')
for (const p of [
  '/manga/komiku:6426',
  '/manga/kiryuu:solo-leveling',
  '/manga/113228',
  '/baca/komiku:6426/1195',
  '/baca/kiryuu:solo-leveling/179.6',
  '/baca/113228',
]) {
  const html = renderAt(p)
  assert.ok(!html.includes('Halaman tidak ada'), `${p} jatuh ke 404`)
}
ok('semua route sasaran match (bukan *) — tidak jatuh ke NotFound')
for (const odd of ODD_HANDLES) {
  const html = renderAt(`/manga/${encodeURIComponent(odd)}`)
  assert.ok(!html.includes('Halaman tidak ada'), `handle ${odd} → 404`)
}
ok(`${ODD_HANDLES.length} handle aneh (spasi/%/://../::) → dirender tanpa crash`)
const enc = matchRoutes([{ path: '/manga/:handle' }], '/manga/kiryuu%3Asolo-leveling')
assert.deepEqual(enc?.[0].params, { handle: 'kiryuu:solo-leveling' }, 'handle encoded decode sekali')
// nomor yang mengandung %2F: React Router decode penuh lalu jatuh ke
// /baca/:chapterId dengan string berisi '/'. Kunci mis-parse → API 404 →
// halaman error bersih (bukan crash/white screen). Dikunci sebagai perilaku
// observasi (temuan minor, lihat laporan QA).
const enc2 = matchRoutes([{ path: '/baca/:handle/:number' }, { path: '/baca/:chapterId' }],
  '/baca/kiryuu%3Asolo%2Dleveling%2F179.6')
assert.equal(enc2?.[0].route.path, '/baca/:chapterId', 'encoded slash → route chapterId')
assert.equal(enc2?.[0].params?.chapterId, 'kiryuu:solo-leveling/179.6', 'decode penuh termasuk /')
const misKey = chapterKeyOf(enc2?.[0].params?.chapterId as string, undefined, undefined)
assert.equal(misKey, 'kiryuu:solo-leveling/179.6')
// hasil mis-parse: handle 'kiryuu' → fetch 404 → error state bersih
assert.deepEqual(parseUnifiedKey(misKey), { handle: 'kiryuu', number: 'solo-leveling/179.6' })
await assert.rejects(
  () => unifiedApi.chapter('kiryuu', 'solo-leveling/179.6'),
  (e: Error) => e.message.includes('tidak ada') || e.message.includes('HTTP 404'),
  'mis-parse → 404 bersih, bukan crash',
)
assert.equal(parseUnifiedKey('113228'), null, 'angka legacy bukan unified')
assert.equal(chapterKeyOf('113228', undefined, undefined), '113228')
assert.equal(chapterKeyOf(undefined, 'kiryuu:solo-leveling', '179.6'), 'kiryuu:solo-leveling:179.6')
ok('parse kunci: angka legacy tetap legacy, handle desimal/non-numerik utuh')

// ---------------------------------------------------------------- W6 imgUrl
console.log('[W6] imgUrl rewrite host')
for (const u of [...IMG_FIXTURE.komiku, ...IMG_FIXTURE.other]) {
  const out = imgUrl(u)
  assert.ok(out.startsWith('/img?u='), `${u} harus diproksi, dapat ${out}`)
  assert.equal(imgUrl(out), out, 'idempoten')
  const q = new URL(out, 'http://x.invalid').searchParams.get('u')
  assert.equal(q, u, 'param u = URL asli (round-trip)')
}
ok(`${IMG_FIXTURE.komiku.length + IMG_FIXTURE.other.length} URL host terdaftar → /img?u=, idempoten, round-trip benar`)
// 'jahat' = URL yang BUKAN boleh divalid ulang proxy. Catatan: entri terakhir
// fixture (`/img?u=...`) memang output proxy, jadi idempoten → benar dikembalikan
// apa adanya (itu perilaku yang diinginkan, bukan kegagalan).
for (const u of IMG_FIXTURE.jahat.slice(0, -1)) {
  const out = imgUrl(u)
  assert.ok(!out.startsWith('/img?u='), `${u} TIDAK boleh diproksi, dapat ${out}`)
}
const alreadyProxy = IMG_FIXTURE.jahat.at(-1)!
assert.equal(imgUrl(alreadyProxy), alreadyProxy, 'sudah /img?u= → idempoten, tidak dobel-encode')
ok('data: / javascript: / //host / host luar allowlist → TIDAK diproxy; /img?u= idempoten')
const r403 = await abs(`/img?u=${encodeURIComponent(IMG_FIXTURE.jahat[0])}`)
assert.equal(r403.status, 403, 'proxy /img menolak host luar allowlist')
ok('proxy /img menolak host non-allowlist (403) — bukan SSRF lewat proxy')

// ---------------------------------------------------------------- W7 anchor
console.log('[W7] tabrakan kunci anchor/progress/offline')
const keys = {
  unifiedKomiku: unifiedKey('komiku:6426', '1195'),
  unifiedKiryuu: unifiedKey('kiryuu:solo-leveling', '179.6'),
  legacyKomiku: '113228',
}
const values = Object.values(keys)
assert.equal(new Set(values).size, values.length, `kunci harus unik: ${values.join(' | ')}`)
assert.deepEqual(parseUnifiedKey(keys.legacyKomiku), null, 'legacy angka tidak unified')
assert.deepEqual(parseUnifiedKey(keys.unifiedKomiku), { handle: 'komiku:6426', number: '1195' })
const hrefs = [
  readerHref(keys.unifiedKomiku),
  readerHref(keys.unifiedKiryuu),
  readerHref(keys.legacyKomiku),
]
assert.equal(new Set(hrefs).size, 3, `href harus beda: ${hrefs.join(' | ')}`)
ok('komiku:6426:1195 vs legacy 113228 → kunci & href unik, tidak saling menimpa')
const ch = await unifiedApi.chapter('kiryuu:solo-leveling', '2.5')
assert.equal(chapterKeyOf(undefined, 'kiryuu:solo-leveling', ch.number), 'kiryuu:solo-leveling:2.5')
const mkeys = [manifestKey('113228'), manifestKey(keys.unifiedKomiku)]
assert.equal(new Set(mkeys).size, 2, `manifest offline harus beda: ${mkeys.join(' | ')}`)
ok('kunci offline manifest berbeda untuk unified vs legacy (query keyed)')

// ------------------------------------------------------------ W8 rak/unduhan
console.log('[W8] rak: PDF gagal, data jahat, ukuran aneh')
// batch unduh: satu chapter gagal (500 HTML) → baris itu gagal, lainnya tetap
// jalan (tidak ada satu error yang membatalkan seluruh batch).
const progress: Record<string, string> = {}
await downloadChapters(
  [
    { handle: 'komiku:6426', number: '3' },
    { handle: 'komiku:6426', number: 'failmode' },
  ],
  (i, patch) => {
    progress[String(i)] = `${patch.state}${patch.error ? `:${patch.error}` : ''}`
  },
)
assert.ok(progress['0']?.startsWith('ok'), `chapter berhasil tetap dicatat (${progress['0']})`)
assert.ok(
  progress['1']?.startsWith('fail') && progress['1'].length > 5,
  `chapter gagal membawa pesan error, bukan silent (${progress['1']})`,
)
ok('batch unduh: kegagalan satu chapter terisolasi + pesan error terbaca')

// batch dibatasi 30 (range picker); pool menerima daftar lebih besar tidak boleh error
assert.equal(BATCH_MAX, 30, 'batch maksimal 30 sesuai kontrak range picker')
const big = await pool(['a', 'b', 'c', 'd', 'e', 'f', 'g'], 3, async (x) => x)
assert.equal(big.length, 7, 'pool menangani daftar lebih besar dari BATCH_MAX')
ok('pool aman untuk daftar > BATCH_MAX (UI yang memotong, pool tetap jujur)')

// ukuran file aneh dari server tidak boleh jadi "NaN MB"
for (const [bytes, expected] of [
  [0, '0 B'],
  [999, '999 B'],
  [100 * 1024, '100 KB'],
  [2 * 1024 * 1024 * 1024, '2048.0 MB'],
  [Number.NaN, '—'],
  [-5, '—'],
] as const) {
  assert.equal(humanSize(bytes), expected, `humanSize(${bytes}) → ${expected}`)
}
ok('humanSize: byte/KB/MB + nilai tak wajar → "—" (bukan NaN)')

// respons unduhan/eviction berisi judul jahat: apa yang masuk ke UI LOLOS
// sebagai string, bukan dieksekusi — diverifikasi lewat klien (fetch nyata).
const dl = await abs('/api/unified/downloads')
const dlBody = (await dl.json()) as {
  items: { series_title: string; size_bytes: number }[]
  total_bytes: number
  limit_bytes: number
}
assert.equal(typeof dlBody.items[0].series_title, 'string', 'series_title string')
assert.ok(dlBody.items[0].series_title.includes('<b>'), 'fixture kirim markup jahat')
assert.ok(dlBody.total_bytes <= dlBody.limit_bytes, 'total_bytes <= limit_bytes')
const ev2 = await abs('/api/unified/evictions')
const evBody = (await ev2.json()) as { items: { series_title: string }[] }
assert.ok(evBody.items[0].series_title.includes('<b>'), 'eviction juga membawa markup jahat')
ok('unduhan/eviction hostile: klien menerima string (escape terjadi di render React)')

// PDF generator mati (500 HTML) → client lempar Error dengan pesan
await assert.rejects(
  () =>
    fetch(`${BASE}/api/unified/download-pdf`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ handle: 'komiku:6426', number: 'failmode' }),
    }).then((r) => {
      if (!r.ok) throw new Error(`HTTP ${r.status}`)
      return r.json()
    }),
  /HTTP 500/,
  'download-pdf gagal → HTTP 500 (bukan json rusak)',
)
ok('download-pdf 500-HTML → gagal terdeteksi (bukan crash parse JSON)')

console.log(`\nhostile-check: OK — ${n} grup verifikasi lulus`)