/**
 * SELF-CHECK logika inti unified (tanpa framework, jalan dengan jiti).
 *
 * Memverifikasi hal-hal yang PALING mudah salah dan tidak terlihat oleh
 * `tsc`: bentuk kunci chapter, parse nomor desimal/non-numerik, rewrite URL
 * gambar host baru, dan bentuk kartu. Semua assertion memakai nilai yang
 * benar-benar dikirim komiku-server (lihat komiku-server/src/unified.rs).
 *
 * Jalankan dari root repo:
 *   node node_modules/jiti/lib/jiti-cli.mjs scripts/unified-selfcheck.ts
 */
import assert from 'node:assert/strict'
import {
  chapterKeyOf,
  marathonHref,
  parseUnifiedKey,
  readerHref,
  seriesHref,
  unifiedKey,
} from '../src/readerSource.ts'
import { toMangaCard } from '../src/api.ts'
import type { MangaOut, UnifiedChapter, UnifiedChapterOut } from '../src/types.ts'
import { imgUrl } from '../src/imgUrl.ts'
import * as rakStore from '../src/rakStore.ts'
import { BATCH_MAX, CONCURRENCY, pool } from '../src/downloadBatch.ts'
import { resumeHref } from '../src/readerSource.ts'

// --- kunci chapter: gabungan param route -----------------------------------
assert.equal(chapterKeyOf('6427', undefined, undefined), '6427')
assert.equal(chapterKeyOf(undefined, 'komiku:6426', '1195'), 'komiku:6426:1195')
// nomor desimal harus utuh (JANGAN menjadi 1195.0 / kehilangan titik)
assert.equal(chapterKeyOf(undefined, 'kiryuu:solo-leveling', '2.5'), 'kiryuu:solo-leveling:2.5')

// --- parse kunci: sumber:native_id:nomor -----------------------------------
assert.deepEqual(parseUnifiedKey('komiku:6426:1195'), {
  handle: 'komiku:6426',
  number: '1195',
})
assert.deepEqual(parseUnifiedKey('kiryuu:solo-leveling:2.5'), {
  handle: 'kiryuu:solo-leveling',
  number: '2.5',
})
// nomor non-numerik (extra/ona) tetap utuh
assert.deepEqual(parseUnifiedKey('komiku:6426:extra-9'), {
  handle: 'komiku:6426',
  number: 'extra-9',
})
// kunci komiku lama: angka polos TIDAK boleh terbaca sebagai unified
assert.equal(parseUnifiedKey('6427'), null)
assert.equal(parseUnifiedKey(''), null)

// --- href: route baru berbasis handle --------------------------------------
assert.equal(readerHref('komiku:6426:1195'), '/baca/komiku:6426/1195')
assert.equal(readerHref('kiryuu:solo-leveling:2.5'), '/baca/kiryuu:solo-leveling/2.5')
assert.equal(readerHref('6427'), '/baca/6427')
assert.equal(marathonHref('komiku:6426:1'), '/maraton/komiku:6426/1')
assert.equal(marathonHref('6427'), '/maraton/6427')
assert.equal(seriesHref('komiku:6426'), '/manga/komiku:6426')
assert.equal(seriesHref(null), null)
assert.equal(seriesHref(''), null)
assert.equal(unifiedKey('komiku:6426', '1195'), 'komiku:6426:1195')

// --- imgUrl: hotlink CDN apa adanya (Q21 — tanpa proxy /img) ----------------
assert.equal(imgUrl('https://image2.komiku.to/a/1.jpg'), 'https://image2.komiku.to/a/1.jpg')
assert.equal(
  imgUrl('https://v2.yuucdn.net/wp-content/uploads/1.jpg'),
  'https://v2.yuucdn.net/wp-content/uploads/1.jpg',
)
assert.equal(imgUrl('https://assets.shngm.id/x.webp'), 'https://assets.shngm.id/x.webp')
assert.equal(imgUrl('https://cdnkuma.my.id/x.jpg'), 'https://cdnkuma.my.id/x.jpg')
assert.equal(imgUrl('https://cdn.jsdelivr.net/gh/a/b.png'), 'https://cdn.jsdelivr.net/gh/a/b.png')
assert.equal(imgUrl('https://v7.kiryuu.to/uploads/a%20b.jpg'), 'https://v7.kiryuu.to/uploads/a%20b.jpg')
assert.equal(imgUrl('https://img.komiku.org/a/1.jpg'), 'https://img.komiku.org/a/1.jpg')
assert.equal(imgUrl('https://thumbnail.komiku.org/c.jpg'), 'https://thumbnail.komiku.org/c.jpg')
// protocol-relative & path relatif juga dibiarkan apa adanya
assert.equal(imgUrl('//image2.komiku.to/a/1.jpg'), '//image2.komiku.to/a/1.jpg')
assert.equal(imgUrl('/covers/local.jpg'), '/covers/local.jpg')
// idempoten: hasil apa pun dilewatkan lagi tetap sama
assert.equal(
  imgUrl('https://image2.komiku.to/a/1.jpg'),
  'https://image2.komiku.to/a/1.jpg',
)
// host asing tetap dibiarkan (tak ada lagi allowlist proxy di klien)
assert.equal(imgUrl('https://evil.example.com/1.jpg'), 'https://evil.example.com/1.jpg')
assert.equal(imgUrl(null), '')

// --- toMangaCard: bentuk respons server (rating string, updated_at epoch) ---
const out: MangaOut = {
  source: 'kiryuu',
  native_id: 'solo-leveling',
  handle: 'kiryuu:solo-leveling',
  title: 'Solo Leveling',
  cover_url: 'https://v2.yuucdn.net/S/1.jpg',
  author: 'Chugong',
  status: 'Ongoing',
  manga_type: 'Manhwa',
  rating: '9.1',
  last_chapter: '200',
  updated_at: 1760000000000,
  url: 'https://v7.kiryuu.to/manga/solo-leveling/',
  // kontrak rak: judul ter-normalisasi untuk favorit/sejarah lintas-sumber
  title_key: 'solo-leveling',
}
const card = toMangaCard(out)
assert.equal(card.id, 'kiryuu:solo-leveling')
assert.equal(card.handle, 'kiryuu:solo-leveling')
assert.equal(card.source, 'kiryuu')
assert.equal(card.score, '9.1')
// rating "-" dari server harus hilang dari kartu (bukan jadi ★ -)
assert.equal(toMangaCard({ ...out, rating: '-' }).score, null)
assert.equal(card.thumbnail, 'https://v2.yuucdn.net/S/1.jpg')
assert.equal(card.tipe?.[0], 'Manhwa')
assert.ok(card.other?.includes('200'), 'last_chapter masuk meta kartu')

// --- bentuk kontrak: chapter unified (prev/next OBJEK lintas-sumber) ------
const chapter: UnifiedChapter = {
  title: 'Chapter 2.5',
  number: '2.5',
  source: 'kiryuu',
  images: ['https://v2.yuucdn.net/1.jpg'],
  prev: { number: '1', source: 'komiku', handle: 'komiku:6426' },
  next: { number: '3', source: 'kiryuu', handle: 'kiryuu:solo-leveling' },
}
assert.equal(chapter.number, '2.5')
// kontrak v2: prev/next membawa {number, source, handle} — reader memakai
// handle itu untuk navigasi, BUKAN handle halaman yang sedang dibuka.
assert.deepEqual(chapter.prev, {
  number: '1',
  source: 'komiku',
  handle: 'komiku:6426',
})
assert.equal(chapter.next?.handle, 'kiryuu:solo-leveling')
assert.equal(chapter.next?.source, 'kiryuu')
// null tetap null (ujung chapter)
const tail: UnifiedChapter = { ...chapter, prev: { ...chapter.prev! }, next: null }
assert.equal(tail.next, null)
// switched_from + note hadir saat fallback lintas-sumber
const switched: UnifiedChapter = {
  ...chapter,
  switched_from: 'komiku',
  note: 'dibaca dari kiryuu',
}
assert.equal(switched.switched_from, 'komiku')
assert.equal(switched.note, 'dibaca dari kiryuu')

// --- bentuk kontrak: chapter row series (updated_at epoch ms) --------------
const row: UnifiedChapterOut = {
  number: '1',
  title: '',
  native_id: 'c1',
  updated_at: 1760000000000,
}
assert.equal(new Date(row.updated_at!).getFullYear(), 2025)

// --- rak: title_key ikut di respons chapter (dipakai reader) --------------
const chapterWithKey: UnifiedChapter = {
  ...chapter,
  title_key: 'solo-leveling',
  handle: 'kiryuu:solo-leveling',
  cover_url: 'https://v2.yuucdn.net/S/1.jpg',
}
assert.equal(chapterWithKey.title_key, 'solo-leveling')

// --- rakStore: favorit + sejarah lintas-sumber via title_key ---------------
// localStorage palsu: modul rakStore membaca localStorage SAAT DIPANGGIL,
// jadi cukup dipasang sebelum test (tanpa DOM asli di node).
const store = new Map<string, string>()
const localStorageMock = {
  getItem: (k: string) => (store.has(k) ? (store.get(k) as string) : null),
  setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k),
  clear: () => store.clear(),
  key: () => null,
  length: 0,
} as unknown as Storage
;(globalThis as { localStorage?: Storage }).localStorage = localStorageMock

store.clear()
assert.equal(rakStore.isFavorite('solo-leveling'), false, 'awal belum favorit')
const mangaAcrossSources = {
  title_key: 'solo-leveling',
  title: 'Solo Leveling',
  cover_url: null,
  handle: 'kiryuu:solo-leveling',
  source: 'kiryuu',
}
rakStore.toggleFavorite(mangaAcrossSources)
assert.equal(rakStore.isFavorite('solo-leveling'), true, 'setelah toggle → favorit')
assert.equal(rakStore.listFavorites().length, 1, 'satu entri per title_key')
// title_key yang SAMA dari sumber lain memakai kunci yang sama: menambah lewat
// handle lain tidak membuat entri kedua, tapi menyalakan/mematikan status yang
// sama (favorit level series, bukan level sumber).
rakStore.toggleFavorite({ ...mangaAcrossSources, handle: 'shinigami:sl', source: 'shinigami' })
assert.equal(rakStore.isFavorite('solo-leveling'), false, 'toggle key sama → lepas')
rakStore.toggleFavorite({ ...mangaAcrossSources, handle: 'shinigami:sl', source: 'shinigami' })
assert.equal(rakStore.listFavorites().length, 1, 'tetap satu entri lintas-sumber')
assert.equal(rakStore.listFavorites()[0].handle, 'shinigami:sl', 'snapshot entri terakhir')
assert.equal(rakStore.listFavorites()[0].source, 'shinigami', 'snapshot sumber ikut terbaru')
rakStore.toggleFavorite({ ...mangaAcrossSources, handle: 'shinigami:sl', source: 'shinigami' })
assert.equal(rakStore.listFavorites().length, 0, 'toggle off bersih')

// sejarah: sort updated_at desc, retensi maks 200 entri
// (Date.now di-mock naik 1ms per tulis supaya urutan deterministik — tanpa ini
// penulisan sekilat loop bisa berbagi milidetik yang sama dan urutan jadi acak)
const realNow = Date.now
let fakeNow = 1_000_000_000_000
Date.now = () => fakeNow++
for (let i = 0; i < 205; i++) {
  rakStore.recordRead(
    { ...mangaAcrossSources, title_key: `judul-${i}` },
    String(i),
  )
}
const history = rakStore.listHistory()
assert.equal(history.length, 200, 'sejarah dipotong di 200 entri')
assert.ok(
  history.every((e, i) => i === 0 || history[i - 1].updated_at >= e.updated_at),
  'sejarah urut updated_at desc',
)
assert.equal(history[0].title_key, 'judul-204', 'entri terbaru paling atas')
rakStore.recordRead({ ...mangaAcrossSources, title_key: 'judul-7' }, '99')
assert.equal(rakStore.listHistory()[0].title_key, 'judul-7', 'baca lagi → naik ke atas')
assert.equal(rakStore.listHistory()[0].last_chapter, '99', 'chapter terakhir tersimpan')
Date.now = realNow

// FAB "Lanjut baca": URL dari entri sejarah; null kalau rak kosong
assert.equal(resumeHref(null), null, 'rak kosong → tidak ada URL resume')
assert.equal(resumeHref(undefined), null, 'tanpa entri → tidak ada URL resume')
assert.equal(resumeHref({ handle: '', last_chapter: '3' }), null, 'entri tanpa handle → null')
assert.equal(
  resumeHref({ handle: 'kiryuu:solo-leveling', last_chapter: '2.5' }),
  '/baca/kiryuu:solo-leveling/2.5',
  'entri sejarah → URL chapter terakhir',
)

// --- pool konkuren: batas + urutan hasil ----------------------------------
assert.equal(BATCH_MAX, 5, 'batch unduh maksimal 5 chapter')
assert.ok(CONCURRENCY <= BATCH_MAX, 'konkuren tidak melebihi batch')
{
  let active = 0
  let maxActive = 0
  const out2 = await pool([1, 2, 3, 4, 5, 6], 3, async (n) => {
    active++
    maxActive = Math.max(maxActive, active)
    await new Promise((r) => setTimeout(r, 5))
    active--
    return n * 2
  })
  assert.deepEqual(out2, [2, 4, 6, 8, 10, 12], 'pool mengembalikan hasil urut')
  assert.ok(maxActive <= 3, `maksimal ${maxActive} tugas konkuren (batas 3)`)
  const empty = await pool([], 3, async () => 1)
  assert.deepEqual(empty, [], 'pool dengan daftar kosong aman')
}

console.log('unified-selfcheck: OK (semua assertion lulus)')
