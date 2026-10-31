/**
 * Self-check readingPosition (K1) — pengukuran DOM + setScrollToAnchor.
 *
 * Jalankan:  node scripts/check-reading-position.ts
 *
 * Yang dibuktikan:
 *  1. measurePages menghasilkan geometry yang benar (pageId, top, height),
 *     melewatkan elemen tanpa resolver/offsetHeight 0.
 *  2. resolver (seam) dipakai: dua resolver berbeda untuk root yang sama.
 *  3. setScrollToAnchor men-scroll ke posisi yang benar dan lapor final
 *     hanya setelah gambar pemilik decode.
 */
import assert from 'node:assert/strict'
import { measurePages, setScrollToAnchor } from '../src/readingPosition.ts'

// --- stub DOM minimal ---------------------------------------------------
class FakeEl {
  offsetHeight = 0
  dataset: Record<string, string> = {}
  // posisi absolut di dokumen
  top = 0
  complete = true
  naturalWidth = 200
  images: FakeEl[] = []
  constructor(opts: Partial<{ h: number; top: number; src: string; b: string; p: string; complete: boolean }> = {}) {
    this.offsetHeight = opts.h ?? 100
    this.top = opts.top ?? 0
    this.complete = opts.complete ?? true
    this.naturalWidth = opts.complete === false ? 0 : 200
    if (opts.src) this.dataset.src = opts.src
    if (opts.b) this.dataset.b = opts.b
    if (opts.p) this.dataset.p = opts.p
  }
  getAttribute(name: string): string | null {
    return this.dataset[name] ?? null
  }
  getBoundingClientRect() {
    return { top: this.top - window.scrollY, height: this.offsetHeight } as DOMRect
  }
  querySelectorAll(sel: string): FakeEl[] {
    // hanya dukung 'img[data-page]' / 'img[data-b]' sederhana
    if (sel.includes('data-page')) return this.images.filter((i) => i.dataset.p !== undefined)
    if (sel.includes('data-b')) return this.images.filter((i) => i.dataset.b !== undefined)
    return this.images
  }
  querySelector(sel: string): FakeEl | null {
    const m = /data-page="(\d+)"/.exec(sel)
    if (m) return this.images.find((i) => i.dataset.p === m[1]) ?? null
    return null
  }
}

// stub window/scrollY — module baca window.scrollY di setScrollToAnchor & measurePages
;(globalThis as any).window = {
  scrollY: 0,
  innerHeight: 800,
  scrollTo({ top }: { top: number }) {
    ;(globalThis as any).window.scrollY = top
  },
}
// stub HTMLImageElement supaya setScrollToAnchor.isImageStable bisa memakai
// instanceof (di Node global ini tidak ada)
;(globalThis as any).HTMLImageElement = FakeEl

// --- 1. measurePages: geometry benar + skip tidak valid --------------------
const root = new FakeEl()
root.images = [
  new FakeEl({ top: 0, h: 100, src: 'a.jpg', p: '0', b: '0' }),
  new FakeEl({ top: 100, h: 100, src: 'b.jpg', p: '1', b: '0' }),
  // tanpa resolusi height (h:0) → tetap di-skip oleh measurePages
  new FakeEl({ top: 200, h: 0, src: 'c.jpg', p: '2', b: '0' }),
  // tanpa resolver (tanpa data-page) → dilewati oleh resolver src
  new FakeEl({ top: 300, h: 100, b: '0' }),
]

const geo = measurePages(root, (el) => el.getAttribute('src'), 'img[data-page]')
assert.equal(geo.length, 2, 'hanya 2 valid (skip height 0 + tanpa src)')
assert.deepEqual(geo[0], { pageId: 'a.jpg', top: 0, height: 100 })
assert.deepEqual(geo[1], { pageId: 'b.jpg', top: 100, height: 100 })

// --- 2. resolver berbeda = seam -----------------------------------------
const geoB = measurePages(root, (el) => {
  const b = (el as FakeEl).dataset.b
  const p = (el as FakeEl).dataset.p
  return b !== undefined && p !== undefined ? `${b}:${p}` : null
}, 'img[data-b]')
assert.equal(geoB.length, 2, 'dua valid via indeks (height 0 & tanpa p di-skip)')
assert.deepEqual(geoB[1], { pageId: '0:1', top: 100, height: 100 })

// --- 3. setScrollToAnchor: scroll ke posisi + final ----------------------
let scrolledTo = 0
;(globalThis as any).window.scrollTo = ({ top }: { top: number }) => { scrolledTo = top }
const el = new FakeEl({ top: 0, h: 100, complete: true })
// offsetRatio 0.5 → target = top + h*0.5 - innerHeight/2 = 0 + 50 - 400
scrolledTo = -999
assert.equal(setScrollToAnchor(el as unknown as HTMLElement, { offsetRatio: 0.5 }), true)
assert.equal(scrolledTo, -350)

// gambar belum decode → final false
const elPending = new FakeEl({ top: 0, h: 100, complete: false })
assert.equal(setScrollToAnchor(elPending as unknown as HTMLElement, { offsetRatio: 0.5 }), false)

console.log('check-reading-position: OK (3 grup asersi lulus)')
