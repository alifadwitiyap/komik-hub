/**
 * Self-check Lane A — matematika posisi baca.
 *
 * Jalankan:  node scripts/check-anchor.ts
 * (tanpa framework, tanpa dependency — cukup Node >= 22 type-stripping)
 *
 * Yang dibuktikan:
 *  1. anchorFrom memilih halaman yang ditatap + offsetRatio yang benar,
 *  2. round-trip: scrollYForAnchor(...) mengembalikan scroll asli
 *     (inilah yang membuat posisi "presisi", bukan cuma per halaman),
 *  3. clamp01 membatasi rasio di 0..1,
 *  4. usableAnchor menolak anchor kosong/kedaluwarsa,
 *  5. rasio aspek bertahan lewat localStorage (anti layout-shift).
 */
import assert from 'node:assert/strict'
import {
  anchorFrom,
  scrollYForAnchor,
  usableAnchor,
  clamp01,
  rememberAspect,
  aspectOf,
} from '../src/pageMemory.ts'

// --- stub localStorage untuk uji rasio aspek (node tidak punya DOM) --------
const store = new Map<string, string>()
// @ts-expect-error sediakan localStorage minimal untuk modul
globalThis.localStorage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k),
}

// 4 halaman setinggi 1000px, menempel vertikal (col flow), viewport 800px
const VH = 800
const tops = [0, 1000, 2000, 3000]
const heights = [1000, 1000, 1000, 1000]
const ids = ['/img?u=a', '/img?u=b', '/img?u=c', '/img?u=d']

// 1 & 2 — scroll 1050px → tengah viewport di 1450px (di dalam halaman ke-2,
//         tepat 45% dari atasnya) → anchor harus halaman itu + rasio 0.45
const scrollY = 1050
const anchor = anchorFrom(123, ids, scrollY, VH, tops, heights)
assert.ok(anchor, 'anchor terhitung')
assert.equal(anchor.chapterId, 123)
assert.equal(anchor.pageId, '/img?u=b')
assert.equal(anchor.offsetRatio, 0.45)
// round-trip: posisi scroll yang membuat rasio itu kembali ke tengah viewport
const back = scrollYForAnchor(anchor.offsetRatio, tops[1], heights[1], VH)
assert.equal(back, scrollY)
assert.equal(back + VH / 2, tops[1] + heights[1] * anchor.offsetRatio)

// mid tepat di 400px → masih halaman pertama, rasio 0.4 (bukan 0)
const a0 = anchorFrom('ch', ids, 0, VH, tops, heights)
assert.equal(a0!.pageId, '/img?u=a')
assert.equal(a0!.offsetRatio, 0.4)
// scroll jauh di bawah → halaman terakhir, rasio di-clamp ke 1
const aLast = anchorFrom('ch', ids, 4000, VH, tops, heights)
assert.equal(aLast!.pageId, '/img?u=d')
assert.equal(aLast!.offsetRatio, 1)

// 3 — clamp
assert.equal(clamp01(-3), 0)
assert.equal(clamp01(2), 1)
assert.equal(clamp01(0.37), 0.37)

// 4 — validasi & TTL
const good = { chapterId: 7, pageId: '/img?u=a', offsetRatio: 0.2, at: Date.now() }
assert.equal(usableAnchor(good), good)
assert.equal(usableAnchor({ ...good, pageId: '' }), null)
assert.equal(usableAnchor({ ...good, offsetRatio: Number.NaN }), null)
assert.equal(usableAnchor({ ...good, chapterId: undefined as unknown as string }), null)
assert.equal(usableAnchor({ ...good, at: Date.now() - 400 * 24 * 3600_000 }), null)

// 5 — rasio aspek: dimensi valid dipakai, tidak valid diabaikan
assert.equal(aspectOf('/img?u=a'), null)
rememberAspect('/img?u=a', 700, 1000)
assert.equal(aspectOf('/img?u=a'), 0.7)
rememberAspect('/img?u=a', 0, 1000)
assert.equal(aspectOf('/img?u=a'), 0.7)
rememberAspect('/img?u=a', 1000, 700)
assert.equal(Math.round(aspectOf('/img?u=a')! * 1000) / 1000, 1.429)

// guard pemakaian salah
assert.equal(anchorFrom(1, ids, 0, VH, [0, 1], [1, 1]), null)
assert.equal(anchorFrom(1, ids, 0, 0, tops, heights), null)
assert.equal(anchorFrom(1, [], 0, VH, [], []), null)

console.log('check-anchor: OK (5 grup asersi lulus)')
