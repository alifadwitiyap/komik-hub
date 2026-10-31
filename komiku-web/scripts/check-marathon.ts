/**
 * Self-check posisi baca MODE MARATON.
 *
 * Jalankan:  node scripts/check-marathon.ts
 * (tanpa framework, tanpa dependency — Node >= 22 type-stripping)
 *
 * Yang dibuktikan:
 *  1. `handleOf` memisahkan handle series dari kunci chapter (dan null untuk
 *     flow komiku lama yang kuncinya id numerik),
 *  2. `latestForHandle` memilih SESI TERBARU milik series itu, bukan sesi
 *     series lain — inilah yang membuat "Lanjut membaca" tidak nyasar,
 *  3. `upsertPosition` mengganti entri sesi yang sama (bukan menduplikasi)
 *     dan mengurutkan terbaru-dulu,
 *  4. `usablePosition` menolak entri tanpa halaman/kedaluwarsa, dan
 *     memperbaiki entri cacat (blocks 0, activeKey hilang) alih-alih membuang,
 *  5. `parsePositions` tahan terhadap JSON rusak / bukan array,
 *  6. `removeHandle` hanya menghapus sesi series itu.
 */
import assert from 'node:assert/strict'
import {
  handleOf,
  latestForHandle,
  parsePositions,
  removeHandle,
  serializePositions,
  upsertPosition,
  usablePosition,
  MARATHON_TTL_MS,
  type MarathonPosition,
} from '../src/marathonMemory.ts'

const now = Date.now()
const pos = (over: Partial<MarathonPosition> = {}): MarathonPosition => ({
  chapterKey: 'komiku:1284:121',
  activeKey: 'komiku:1284:121',
  pageId: 'https://cdn.example/p1.jpg',
  offsetRatio: 0.25,
  blocks: 1,
  chapterIdx: 0,
  at: now,
  ...over,
})

// 1 — handle series dari kunci chapter
assert.equal(handleOf('komiku:1284:121'), 'komiku:1284')
assert.equal(handleOf('shinigami:abc-def:12.5'), 'shinigami:abc-def')
assert.equal(handleOf('6427'), null)
assert.equal(handleOf(''), null)

// 2 — sesi terbaru milik series yang diminta
const list = [
  pos({ chapterKey: 'komiku:1284:121', at: now - 5000 }),
  pos({ chapterKey: 'komiku:1284:100', at: now - 1000 }),
  pos({ chapterKey: 'komiku:999:1', at: now }), // series lain, paling baru
]
assert.equal(latestForHandle(list, 'komiku:1284')?.chapterKey, 'komiku:1284:100')
assert.equal(latestForHandle(list, 'komiku:999')?.chapterKey, 'komiku:999:1')
assert.equal(latestForHandle(list, 'komiku:000'), null)
assert.equal(latestForHandle(list, null), null)
// flow komiku lama: identitas series = id numerik, bukan handle
const legacy = [pos({ chapterKey: '6427', seriesKey: '512', at: now })]
assert.equal(latestForHandle(legacy, '512')?.chapterKey, '6427')
assert.equal(latestForHandle(legacy, '6427'), null, 'id chapter bukan identitas series')

// 3 — upsert mengganti entri sesi yang sama + urut terbaru dulu
const u1 = upsertPosition([], pos({ at: now - 10 }))
assert.equal(u1.length, 1)
const u2 = upsertPosition(u1, pos({ activeKey: 'komiku:1284:122', at: now }))
assert.equal(u2.length, 1, 'sesi sama tidak diduplikasi')
assert.equal(u2[0].activeKey, 'komiku:1284:122')
const u3 = upsertPosition(u2, pos({ chapterKey: 'komiku:7:1', at: now - 100 }))
assert.deepEqual(
  u3.map((e) => e.chapterKey),
  ['komiku:1284:121', 'komiku:7:1'],
  'urut terbaru-dulu',
)

// 4 — validasi & perbaikan
const good = pos()
assert.deepEqual(usablePosition(good), { ...good, seriesKey: 'komiku:1284' })
assert.equal(usablePosition({ ...good, pageId: '' }), null)
assert.equal(usablePosition({ ...good, chapterKey: '' }), null)
assert.equal(usablePosition({ ...good, offsetRatio: Number.NaN }), null)
assert.equal(usablePosition({ ...good, at: now - MARATHON_TTL_MS - 1 }), null)
// offset di-clamp, blocks/chapterIdx aneh diperbaiki
const fixed = usablePosition({
  ...good,
  offsetRatio: 3,
  blocks: 0,
  chapterIdx: -5,
  activeKey: '',
})
assert.ok(fixed)
assert.equal(fixed!.offsetRatio, 1)
assert.equal(fixed!.blocks, 1)
assert.equal(fixed!.chapterIdx, 0)
assert.equal(fixed!.activeKey, 'komiku:1284:121', 'activeKey jatuh ke blok pertama')

// 5 — parse tahan sampah
assert.deepEqual(parsePositions(null), [])
assert.deepEqual(parsePositions('bukan json'), [])
assert.deepEqual(parsePositions('{"a":1}'), [])
assert.deepEqual(parsePositions('[]'), [])
const roundTrip = parsePositions(serializePositions([pos({ at: now - 2 }), pos({ chapterKey: 'x:1:1', at: now })]))
assert.equal(roundTrip.length, 2)
assert.equal(roundTrip[0].chapterKey, 'x:1:1', 'hasil parse urut terbaru-dulu')

// 6 — hapus per series
const afterRemove = removeHandle(list, 'komiku:1284')
assert.deepEqual(afterRemove.map((e) => e.chapterKey), ['komiku:999:1'])
assert.equal(removeHandle(list, null).length, list.length, 'handle null = tak menghapus apa pun')

console.log('check-marathon: OK (6 grup asersi lulus)')
