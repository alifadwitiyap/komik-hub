/**
 * P1 — animasi & reduced-motion: unit test + source-contract tests.
 * Vitest env = 'node'; source-contract via ?raw mengunci kontrak literal yang
 * tidak bisa dirender (tap handler, kelas animasi, media query).
 * Run: npx vitest run src/p1AnimationMotion.test.ts
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { createTapTracker } from './tapTracker'
import readerSrc from './pages/Reader.tsx?raw'
import marathonSrc from './pages/ReaderMarathon.tsx?raw'
import homeSrc from './pages/Home.tsx?raw'

const css = readFileSync(fileURLToPath(new URL('./index.css', import.meta.url)), 'utf8')

describe('P1 tap tracker — tap sahaja, bukan scroll/pinch', () => {
  it('tap biasa (diam, <900ms) = toggle', () => {
    const t = createTapTracker()
    t.down(1, 'mouse', 100, 100, 1000)
    t.up(1)
    expect(t.shouldToggle(100, 100, 1050)).toBe(true)
  })

  it('geser >12px (scroll) bukan tap', () => {
    const t = createTapTracker()
    t.down(1, 'touch', 100, 100, 1000)
    t.up(1)
    expect(t.shouldToggle(130, 100, 1050)).toBe(false)
  })

  it('tahan >900ms bukan tap', () => {
    const t = createTapTracker()
    t.down(1, 'touch', 100, 100, 1000)
    t.up(1)
    expect(t.shouldToggle(100, 100, 2000)).toBe(false)
  })

  it('pointercancel (scroll dibatalkan browser) bukan tap', () => {
    const t = createTapTracker()
    t.down(1, 'touch', 100, 100, 1000)
    t.cancel(1)
    expect(t.shouldToggle(100, 100, 1030)).toBe(false)
  })

  it('pinch/dua jari bersamaan bukan tap', () => {
    const t = createTapTracker()
    t.down(1, 'touch', 100, 100, 1000)
    t.down(2, 'touch', 200, 200, 1005)
    t.up(1)
    t.up(2)
    expect(t.shouldToggle(100, 100, 1050)).toBe(false)
  })

  it('kontrol halaman (mis. tombol reload) bukan tap chrome', () => {
    const control = (x: number) => x === 5
    const t = createTapTracker(control)
    t.down(1, 'mouse', 5, 5, 1000)
    t.up(1)
    expect(t.shouldToggle(5, 5, 1010)).toBe(false)
  })

  it('gesture baru setelah invalid sukses lagi', () => {
    const t = createTapTracker()
    t.down(1, 'touch', 100, 100, 1000)
    t.cancel(1)
    expect(t.shouldToggle(100, 100, 1010)).toBe(false)
    t.down(2, 'touch', 50, 50, 2000)
    t.up(2)
    expect(t.shouldToggle(50, 50, 2050)).toBe(true)
  })
})

describe('P1 source contracts', () => {
  it('kedua tap layer pakai tracker + kelas reader-tap-layer (opacity-only, tanpa transform gambar)', () => {
    for (const src of [readerSrc, marathonSrc]) {
      expect(src).toContain('createTapTracker(tapHitsReaderControl)')
      expect(src).toContain('reader-tap-layer fixed inset-0')
      expect(src).toContain('onPointerCancel={(e) => tap.cancel(e.pointerId)}')
      expect(src).toContain('if (!tap.shouldToggle(e.clientX, e.clientY, performance.now())) return')
    }
    expect(css).toMatch(/\.reader-tap-layer\s*\{\s*touch-action:\s*pan-y/)
    expect(css).toMatch(/\.reader-chrome-fade\s*\{[^}]*transition:\s*opacity 140ms var\(--ease-out\)/)
    // tidak ada translate pada chrome fade
    expect(css).not.toMatch(/\.reader-chrome-fade\s*\{[^}]*transform:/)
  })

  it('marathon crossfade 120ms hanya khi active chapter berubah (bukan background pushBlock)', () => {
    expect(css).toContain('@keyframes chapter-label-fade {')
    expect(css).toContain('from { opacity: 0; }')
    expect(css).toContain('to { opacity: 1; }')
    expect(css).toContain(".marathon-chapter-label-switch {\n  animation: chapter-label-fade 120ms var(--ease-out) both;\n}")
    expect(css).toMatch(/\.marathon-chapter-label-switch\s*\{\s*animation:\s*chapter-label-fade 120ms/)
    expect(marathonSrc).toContain('prevActiveChapterRef')
    expect(marathonSrc).toContain('crossedChapter && bi === readBlock')
    expect(marathonSrc).toContain('data-marathon-chapter-label={b.chapterId}')
    // kunci pada chapterId aktif, BUKAN blocks.length
    expect(marathonSrc).toContain('const activeChapterId = curBlock?.chapterId ?? null')
  })

  it('carousel autoplay berhenti pada reduced motion + interaksi manual', () => {
    expect(homeSrc).toContain("window.matchMedia('(prefers-reduced-motion: reduce)')")
    expect(homeSrc).toContain('if (mq.matches) return')
    expect(homeSrc).toContain('onPointerDownCapture={() => setAutoplay(false)}')
  })
})
