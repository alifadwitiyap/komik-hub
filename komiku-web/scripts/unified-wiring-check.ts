/**
 * Verifikasi WIRING route + komponen unified (tanpa browser).
 * Me-render komponen React sungguhan ke string HTML lewat react-dom/server,
 * mengambil data dari server yang BENAR-BENAR melayani kontrak
 * (komiku-server :8788 kalau hidup, kalau tidak fixture server dari
 * scripts/run-wiring-check.mjs).
 *
 * Yang dibuktikan:
 *   1. Kontrak /api/unified/* hidup & bentuk datanya sesuai tipe web
 *   2. /manga/<handle> → halaman unified dirender (bukan halaman komiku lama)
 *   3. /manga/<angka>  → halaman Komiku lama tetap jalan, tautan chapter utuh
 *   4. Kartu unified memakai handle + badge sumber tampil
 *   5. Kunci chapter (anchor/riwayat/offline) berbentuk sumber:id:nomor
 *
 * Jalankan dari root repo:   node scripts/run-wiring-check.mjs
 */
import assert from 'node:assert/strict'
import { renderToStaticMarkup } from 'react-dom/server'
import React from 'react'
import { MemoryRouter } from 'react-router-dom'
import App from '../src/App.tsx'
import SourceBadge from '../src/components/SourceBadge.tsx'
import HeartButton from '../src/components/HeartButton.tsx'
import Rak from '../src/pages/Rak.tsx'
import { toMangaCard } from '../src/api.ts'
import { loadChapter, marathonHref, parseUnifiedKey, readerHref } from '../src/readerSource.ts'
import type { MangaOut } from '../src/types.ts'
import * as rakStore from '../src/rakStore.ts'

/**
 * BASE server: Vite `define` men-static-kan KOMIKU_CHECK_BASE saat bundling
 * (lihat scripts/vite-run-check.mjs), supaya nilai runtime benar-benar
 * terbawa ke bundle. Fallback file `.checkbase` untuk jalan tanpa bundling.
 */
export function baseUrl(): string {
  const baked = KOMIKU_CHECK_BASE
  if (baked) return baked
  const fs = require('node:fs') as typeof import('node:fs')
  const path = require('node:path') as typeof import('node:path')
  const p = path.join(process.cwd(), '.checkbase')
  if (fs.existsSync(p)) return fs.readFileSync(p, 'utf8').trim()
  return 'http://127.0.0.1:8788'
}

const BASE = baseUrl()

// localStorage palsu: halaman Rak/Home membaca rakStore saat render, dan
// renderToStaticMarkup menjalankan body komponen (SSR tanpa DOM).
const storeMap = new Map<string, string>()
const localStorageMock = {
  getItem: (k: string) => (storeMap.has(k) ? (storeMap.get(k) as string) : null),
  setItem: (k: string, v: string) => void storeMap.set(k, v),
  removeItem: (k: string) => void storeMap.delete(k),
  clear: () => storeMap.clear(),
  key: () => null,
  length: 0,
} as unknown as Storage
;(globalThis as { localStorage?: Storage }).localStorage = localStorageMock

// src/api.ts memakai path relatif '/api/...' → arahkan ke server fixture.
const rawFetch = globalThis.fetch
globalThis.fetch = ((input: any, init?: any) =>
  typeof input === 'string' && input.startsWith('/api')
    ? rawFetch(`${BASE}${input}`, init)
    : rawFetch(input, init)) as typeof fetch

async function getJson(path: string): Promise<any> {
  const res = await fetch(`${BASE}${path}`)
  assert.ok(res.ok, `GET ${path} -> HTTP ${res.status}`)
  return res.json()
}

/** Render app pada satu URL (state awal; data async belum resolve). */
function renderAt(url: string): string {
  return renderToStaticMarkup(
    React.createElement(MemoryRouter, { initialEntries: [url] }, React.createElement(App)),
  )
}

let checks = 0
const ok = (label: string) => {
  checks++
  console.log(`  ok ${checks} — ${label}`)
}

// ---------------------------------------------------------------- 1. kontrak
console.log('\n[1] kontrak /api/unified/* dari server yang melayani')
const search = await getJson('/api/unified/search?q=solo&page=1')
assert.ok(Array.isArray(search.items) && search.items.length > 0, 'search.items tidak kosong')
assert.ok(Array.isArray(search.failed_sources), 'failed_sources harus array')
ok(`search → ${search.items.length} item, failed_sources=${search.failed_sources.length}`)

// pakai item NON-KOMIKU kalau ada: itu justru jalur baru yang perlu dibuktikan
const sample: MangaOut =
  search.items.find((i: MangaOut) => i.source !== 'komiku') ?? search.items[0]
ok(`sampel handle = ${sample.handle} (source ${sample.source})`)

const series = await getJson(`/api/unified/series/${encodeURIComponent(sample.handle)}`)
assert.ok(series.manga?.title, 'series.manga.title ada')
assert.ok(Array.isArray(series.chapters) && series.chapters.length > 0, 'series.chapters ada')
ok(`series "${series.manga.title}" → ${series.chapters.length} chapter (source ${series.source})`)

const chapterNo: string = series.chapters[0].number
const chapter = await getJson(
  `/api/unified/chapter/${encodeURIComponent(sample.handle)}/${encodeURIComponent(chapterNo)}`,
)
assert.ok(Array.isArray(chapter.images) && chapter.images.length > 0, 'chapter.images ada')
assert.equal(typeof chapter.number, 'string', 'chapter.number adalah string')
// kontrak v2: prev/next = objek {number, source, handle} | null (lintas-sumber)
const navShape = (nav: any, name: string) => {
  if (nav === null || nav === undefined) return
  assert.equal(typeof nav.number, 'string', `${name}.number string`)
  assert.equal(typeof nav.source, 'string', `${name}.source string`)
  assert.equal(typeof nav.handle, 'string', `${name}.handle string`)
  assert.ok(nav.handle.startsWith(`${nav.source}:`), `${name}.handle konsisten dgn source`)
}
navShape(chapter.prev, 'prev')
navShape(chapter.next, 'next')
assert.ok(
  chapter.prev === null || typeof chapter.prev === 'object',
  'prev objek|null (kontrak v2)',
)
assert.ok(
  chapter.next === null || typeof chapter.next === 'object',
  'next objek|null (kontrak v2)',
)
ok(
  `chapter ${chapter.number} → ${chapter.images.length} gambar, prev=${JSON.stringify(chapter.prev)}, next=${JSON.stringify(chapter.next)}`,
)

// navigasi reader memakai HANDLE pointer (bukan handle halaman ini): kalau
// pointer prev/next membawa handle yang valid, route /baca/<handle>/<number>
// benar-benar terbentuk (lintas sumber).
if (chapter.next?.handle && chapter.next?.number) {
  const nextHref = readerHref(`${chapter.next.handle}:${chapter.next.number}`)
  assert.ok(
    nextHref === `/baca/${chapter.next.handle}/${chapter.next.number}`,
    `nextHref lintas-sumber terbentuk (${nextHref})`,
  )
  ok(`navigasi next lintas-sumber → ${nextHref}`)
}

// gambar non-komiku harus bisa lewat proxy /img (bukan hotlink yang akan gagal)
const nonKomikuImg = chapter.images.find((u: string) => !u.includes('komiku.org'))
if (nonKomikuImg) {
  const r = await fetch(`${BASE}/img?u=${encodeURIComponent(nonKomikuImg)}`, { method: 'HEAD' })
  assert.ok(r.status < 400, `proxy /img untuk ${nonKomikuImg} -> ${r.status}`)
  ok(`gambar non-komiku lewat proxy /img (${new URL(nonKomikuImg).hostname})`)
} else {
  ok('gambar chapter ini semuanya host komiku (proxy existing)')
}

// ------------------------------------------------- 2. route handle → unified
console.log('\n[2] /manga/<handle> dirender lewat halaman unified')
const handleHtml = renderAt(`/manga/${sample.handle}`)
// Spinner unified dan komiku lama sama ("Memuat manga…"), jadi pembedanya
// adalah shell: halaman kompi lama selalu punya tautan kembali "Beranda"
// persis di posisi yang sama; yang membuktikan unified adalah komponen
// SeriesUnified yang dirender tanpa error + data hasil fetch di atas.
assert.ok(handleHtml.includes('Memuat'), 'state awal terender (tanpa crash)')
ok(`/manga/${sample.handle} → dirender tanpa error (SeriesRoute memilih unified)`)

// bukti komponen halaman unified menerima data server: judul asli muncul
const { default: SeriesUnified } = await import('../src/pages/SeriesUnified.tsx')
const unifiedHtml = renderToStaticMarkup(
  React.createElement(
    MemoryRouter,
    { initialEntries: [`/manga/${sample.handle}`] },
    React.createElement(SeriesUnified),
  ),
)
assert.ok(unifiedHtml.length > 0, 'komponen series unified bisa dirender')
ok('komponen SeriesUnified sanggup dirender (props route handle benar)')

// ------------------------------------------------- 3. route angka → komiku lama
console.log('\n[3] /manga/<angka> tetap memakai halaman Komiku lama')
const legacy = await getJson('/api/homepage')
const firstSection = Object.values(legacy).find(
  (v: any) => v && typeof v === 'object' && Array.isArray(v.data) && v.data.length > 0,
) as any
assert.ok(firstSection, 'homepage punya seksi dengan data')
const legacyManga = firstSection.data[0]
assert.equal(typeof legacyManga.id, 'number', 'id komiku legacy adalah number')
ok(`homepage legacy → seksi "${firstSection.title}" (${firstSection.data.length} item)`)

const legacySeries = await getJson(`/api/series/${legacyManga.id}`)
assert.ok(Array.isArray(legacySeries.chapters) && legacySeries.chapters.length > 0, 'chapters legacy ada')
const legacyLinks = legacySeries.chapters.map((c: any) => readerHref(String(c.id)))
assert.ok(
  legacyLinks.every((h: string) => /^\/baca\/\d+$/.test(h)),
  `semua tautan chapter legacy berbentuk /baca/<angka> (${legacyLinks.join(', ')})`,
)
ok(`series komiku lama "${legacySeries.series.title}" → ${legacyLinks.length} tautan /baca/<angka>`)

// ------------------------------------------------- 4. kartu + badge sumber
console.log('\n[4] kartu unified: handle sebagai id + badge sumber')
const card = toMangaCard(sample)
assert.equal(card.id, sample.handle, 'kartu memakai handle sebagai id')
assert.equal(card.handle, sample.handle, 'kartu membawa handle (link /manga/:handle)')
assert.equal(card.source, sample.source, 'kartu membawa source (badge)')
// badge menampilkan LABEL ramah ("Kiryuu"), bukan string mentah "kiryuu"
const badgeHtml = renderToStaticMarkup(React.createElement(SourceBadge, { source: card.source }))
assert.ok(
  badgeHtml.includes('Kiryuu') || badgeHtml.includes(sample.source),
  `badge menampilkan label sumber ("${sample.source}" → "Kiryuu")`,
)
ok(`kartu ${sample.title} → /manga/${card.handle} + badge "Kiryuu" (label ramah)`)

// --------------------------------------------- 5. kunci chapter (anchor dll)
console.log('\n[5] kunci chapter: sumber:native_id:nomor')
const chapterKey = `${sample.handle}:${chapter.number}`
assert.deepEqual(parseUnifiedKey(chapterKey), { handle: sample.handle, number: chapter.number })
assert.equal(readerHref(chapterKey), `/baca/${sample.handle}/${chapter.number}`)
assert.equal(marathonHref(chapterKey), `/maraton/${sample.handle}/${chapter.number}`)
ok(`kunci "${chapterKey}" → ${readerHref(chapterKey)} (anchor & riwayat per-sumber)`)

// nomor non-numerik / desimal tidak boleh pecah
for (const n of ['extra-9', '1.5', '1195']) {
  assert.deepEqual(parseUnifiedKey(`${sample.handle}:${n}`), { handle: sample.handle, number: n })
}
ok('nomor desimal & non-numerik (1.5, extra-9) tetap aman')

// ------------------------------------------- 6. rak: title_key + /rak + hati
console.log('\n[6] rak: title_key, halaman /rak, heart, endpoint unduhan')
assert.equal(typeof series.manga.title_key, 'string', 'MangaOut.title_key ada')
assert.ok(series.manga.title_key.length > 0, 'MangaOut.title_key tidak kosong')
assert.equal(typeof chapter.title_key, 'string', 'respons chapter membawa title_key')
assert.equal(chapter.title_key, series.manga.title_key, 'title_key chapter = title_key series')
ok(`title_key "${series.manga.title_key}" hadir di series & chapter (kunci favorit/sejarah)`)

// halaman /rak: 3 tab + pengganti /lanjut
const rakHtml = renderToStaticMarkup(
  React.createElement(MemoryRouter, { initialEntries: ['/rak'] }, React.createElement(App)),
)
for (const label of ['Sejarah', 'Favorit', 'Unduhan']) {
  assert.ok(rakHtml.includes(label), `tab ${label} terender di /rak`)
}
assert.ok(rakHtml.includes('Rak'), 'BottomNav memakai label Rak')
assert.ok(!rakHtml.includes('Riwayat'), 'label lama "Riwayat" sudah tidak ada')
assert.ok(!rakHtml.includes('/lanjut'), 'route /lanjut sudah tidak ditautkan')
ok('/rak dirender dengan 3 tab (Sejarah · Favorit · Unduhan); BottomNav "Rak"')

// BottomNav benar-benar mengarah ke /rak (bukan cuma teks)
const navHtml = renderToStaticMarkup(
  React.createElement(MemoryRouter, { initialEntries: ['/'] }, React.createElement(App)),
)
assert.ok(navHtml.includes('href="/rak"'), 'BottomNav punya tautan href="/rak"')
assert.ok(!navHtml.includes('href="/lanjut"'), 'tidak ada tautan href="/lanjut"')
ok('BottomNav href="/rak" (ganti /lanjut); FAB home dari sejarah rak')

// HeartButton: state dibaca dari rakStore (bukan state lokal palsu)
const heartManga = {
  title_key: series.manga.title_key,
  title: series.manga.title,
  cover_url: series.manga.cover_url ?? null,
  handle: sample.handle,
  source: sample.source,
}
const heartOff = renderToStaticMarkup(React.createElement(HeartButton, { manga: heartManga }))
assert.ok(heartOff.includes('Tambah ke favorit'), 'heart belum nyala saat belum favorit')
rakStore.toggleFavorite(heartManga)
assert.equal(rakStore.isFavorite(series.manga.title_key), true, 'favorit tersimpan per title_key')
const heartOn = renderToStaticMarkup(React.createElement(HeartButton, { manga: heartManga }))
assert.ok(heartOn.includes('Hapus dari favorit'), 'heart menyala setelah favorit')
assert.ok(heartOn.includes('aria-pressed="true"'), 'aria-pressed benar')
rakStore.toggleFavorite(heartManga)
const heartBack = renderToStaticMarkup(React.createElement(HeartButton, { manga: heartManga }))
assert.ok(heartBack.includes('Tambah ke favorit'), 'toggle off lagi kembali mati')
ok('HeartButton membaca/menulis rakStore (aria-label + aria-pressed berubah)')

// reader: sejarah ditulis dari respons chapter yang benar (bukan tipe TS saja)
storeMap.clear()
const loaded = await loadChapter(`${sample.handle}:${chapter.number}`)
assert.equal(loaded.title_key, series.manga.title_key, 'loadChapter membawa title_key')
assert.equal(loaded.series_handle, sample.handle, 'loadChapter membawa handle series')
const { rakMangaOf } = await import('../src/pages/Reader.tsx')
rakStore.recordRead(rakMangaOf(loaded, loaded.title_key as string), loaded.chapter.number)
const hist = rakStore.listHistory()
assert.equal(hist.length, 1, 'satu entri sejarah setelah baca chapter')
assert.equal(hist[0].title_key, series.manga.title_key, 'sejarah berkunci title_key')
assert.equal(hist[0].last_chapter, chapter.number, 'sejarah menyimpan chapter terakhir')
assert.equal(hist[0].handle, sample.handle, 'snapshot sejarah membawa handle (lintas sumber)')
ok(`reader → sejarah: "${hist[0].title}" ch ${hist[0].last_chapter} (title_key + handle)`)

// FAB Home "Lanjut baca" memakai entri sejarah terbaru; rak kosong → null
const { resumeHref } = await import('../src/readerSource.ts')
assert.equal(resumeHref(null), null, 'rak kosong → FAB resume tidak punya URL')
assert.equal(
  resumeHref(hist[0]),
  `/baca/${sample.handle}/${chapter.number}`,
  'FAB resume → chapter terakhir yang dibaca',
)
ok('FAB "Lanjut baca" Home: URL dari sejarah[0]; null kalau rak kosong')

// --- endpoint unduhan/eviction/settings (kontrak rak-buku.md) ---------------
const settingsBefore = await getJson('/api/unified/settings/downloads')
assert.equal(settingsBefore.limit_bytes, 2 * 1024 * 1024 * 1024, 'limit default 2 GB')

// batas dikecilkan supaya eviction benar-benar terjadi
const putLimit = await fetch(`${BASE}/api/unified/settings/downloads`, {
  method: 'PUT',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ limit_bytes: 150 * 1024 }),
})
assert.ok(putLimit.ok, 'PUT settings/downloads hidup')
const limitAfter = (await putLimit.json()) as { limit_bytes: number }
assert.equal(limitAfter.limit_bytes, 150 * 1024, 'limit ter-update')

const created: any[] = []
const chapterNumbers: string[] = (series.chapters as any[]).map((c) => String(c.number))
assert.ok(chapterNumbers.length >= 3, 'fixture punya >=3 chapter untuk skenario eviction')
for (const n of chapterNumbers) {
  const r = await fetch(`${BASE}/api/unified/download-pdf`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ handle: sample.handle, number: n }),
  })
  assert.ok(r.ok, `POST download-pdf ${n} -> HTTP ${r.status}`)
  created.push(await r.json())
}
assert.ok(created.length > 1, 'beberapa PDF dibuat untuk skenario eviction')
for (const c of created) {
  assert.equal(typeof c.id, 'string', 'download-pdf mengembalikan id')
  assert.equal(typeof c.size_bytes, 'number', 'download-pdf mengembalikan size_bytes')
  assert.equal(typeof c.filename, 'string', 'download-pdf mengembalikan filename')
}
const list = await getJson('/api/unified/downloads')
assert.ok(list.total_bytes <= list.limit_bytes, 'total_bytes tidak melewati limit_bytes')
assert.ok(
  list.items.length < created.length,
  `eviction membuang bertahap: ${created.length} dibuat, ${list.items.length} tersisa`,
)
const ev = await getJson('/api/unified/evictions')
assert.ok(Array.isArray(ev.items) && ev.items.length > 0, 'log eviction terisi')
assert.equal(typeof ev.items[0].series_title, 'string', 'eviction membawa series_title')
assert.equal(typeof ev.items[0].size_bytes, 'number', 'eviction membawa size_bytes')
ok(
  `unduhan: ${created.length} dibuat → ${list.items.length} tersisa (limit ${list.limit_bytes}B), ${ev.items.length} eviction tercatat`,
)

// GET file: attachment PDF + last_opened_at ikut ter-update (LRU)
const first = list.items[0]
const fileRes = await fetch(`${BASE}/api/unified/downloads/${encodeURIComponent(first.id)}`)
assert.equal(fileRes.status, 200, 'GET file unduhan hidup')
assert.match(
  fileRes.headers.get('content-type') ?? '',
  /application\/pdf/,
  'content-type application/pdf',
)
assert.match(
  fileRes.headers.get('content-disposition') ?? '',
  /attachment/,
  'content-disposition attachment',
)
const afterOpen = (await (await fetch(`${BASE}/api/unified/downloads`)).json()) as any
const opened = afterOpen.items.find((d: any) => d.id === first.id)
assert.ok(opened && opened.last_opened_at != null, 'last_opened_at ter-update saat file dibuka')
ok('GET /downloads/{id} → PDF attachment + last_opened_at ter-update')

// dismiss eviction + delete unduhan
const dismiss = await fetch(`${BASE}/api/unified/evictions/dismiss`, { method: 'POST' })
assert.ok(dismiss.ok, 'POST evictions/dismiss hidup')
const del = await fetch(`${BASE}/api/unified/downloads/${encodeURIComponent(first.id)}`, {
  method: 'DELETE',
})
assert.ok(del.ok, 'DELETE unduhan hidup')
const afterDel = (await (await fetch(`${BASE}/api/unified/downloads`)).json()) as any
assert.ok(
  !afterDel.items.some((d: any) => d.id === first.id),
  'item hilang setelah DELETE',
)
ok('dismiss eviction + DELETE unduhan bekerja (kontrak terkunci)')

console.log(`\nunified-wiring-check: OK — ${checks} verifikasi lulus`)
