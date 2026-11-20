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

describe('Fase 3.6 — HUD transform + progress hairline', () => {
  const readerCss = readFileSync(
    fileURLToPath(new URL('./styles/reader.css', import.meta.url)),
    'utf8',
  )

  it('top/bottom HUD geser 140ms ease-snappy, opacity 140ms', () => {
    expect(readerCss).toMatch(/transform var\(--dur-hud\) var\(--ease-snappy\)/)
    expect(readerCss).toMatch(/opacity var\(--dur-hud\) var\(--ease-out\)/)
    expect(readerCss).toMatch(/\.reader-hud-top\[data-hidden='true'\]\s*\{\s*transform: translateY\(-100%\)/)
    expect(readerCss).toMatch(/\.reader-hud-bottom\[data-hidden='true'\]\s*\{\s*transform: translateY\(100%\)/)
    // index.css tidak berubah → kontrak lama tetap hijau
    expect(css).toMatch(/\.reader-chrome-fade\s*\{[^}]*transition:\s*opacity 140ms var\(--ease-out\)/)
    const motionCss = readFileSync(
      fileURLToPath(new URL('./styles/motion.css', import.meta.url)),
      'utf8',
    )
    expect(motionCss).toMatch(/--dur-hud:\s*140ms/)
    expect(motionCss).toMatch(/--ease-snappy:\s*cubic-bezier\(0\.16, 1, 0\.3, 1\)/)
    expect(motionCss).toMatch(/--ease-out-emil:\s*cubic-bezier\(0\.22, 1, 0\.36, 1\)/)
    expect(motionCss).toMatch(/--dur-press:\s*100ms/)
    expect(motionCss).toMatch(/--dur-sheet:\s*240ms/)
  })

  it('preset JS selaras: sheetSpring 420/36/0.8, popover 0.96→1 160ms', () => {
    const motionTs = readFileSync(
      fileURLToPath(new URL('./lib/motion.ts', import.meta.url)),
      'utf8',
    )
    expect(motionTs).toMatch(/stiffness: 420,\s*damping: 36,\s*mass: 0\.8/)
    expect(motionTs).toContain('scale: 0.96')
    expect(motionTs).toMatch(/duration: 0\.16/)
    expect(motionTs).toContain('export const DUR_PRESS_MS = 100')
    expect(motionTs).toContain('export const DUR_HUD_MS = 140')
    expect(motionTs).toContain('export const DUR_SHEET_MS = 240')
  })

  it('hairline 2px scaleX dari kiri, ditulis lewat ref.style tanpa setState per frame', () => {
    expect(readerCss).toMatch(/\.reader-progress-hairline\s*\{[^}]*height: 2px/)
    expect(readerCss).toMatch(/transform: scaleX\(0\)/)
    expect(readerCss).toMatch(/transform-origin: left center/)
    expect(readerCss).toMatch(/top: env\(safe-area-inset-top\)/)
    for (const src of [readerSrc, marathonSrc]) {
      expect(src).toContain('reader-progress-hairline')
      expect(src).toContain('hairlineRef.current.style.transform')
      expect(src).toMatch(/scaleX\(\$\{p\}\)/)
    }
  })

  it('auto-hide threshold 24px', () => {
    const hookSrc = readFileSync(
      fileURLToPath(new URL('./hooks/useChromeOnScroll.ts', import.meta.url)),
      'utf8',
    )
    expect(hookSrc).toContain('const THRESHOLD_PX = 24')
  })
})
