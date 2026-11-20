/**
 * WS-B advanced reader — kontrak B1/B2/B3/A2.
 * Vitest env = node: logika murni diuji langsung, markup .tsx/.css di-pin
 * lewat import `?raw` (bukan render), mengikuti pola readerP0/p2A11y.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { createTapTracker, type TapAction } from './tapTracker'
import tapSrc from './tapTracker.ts?raw'
import readerSrc from './pages/Reader.tsx?raw'
import marathonSrc from './pages/ReaderMarathon.tsx?raw'
import footerSrc from './components/ReaderFooter.tsx?raw'
import comicSrc from './components/ComicImage.tsx?raw'
import menuSrc from './components/ReaderMenu.tsx?raw'
import sheetSrc from './components/ReaderSettingsSheet.tsx?raw'
import settingsSrc from './hooks/useReaderSettings.ts?raw'

// Vite memberi string kosong untuk `?raw` pada CSS di env node — baca langsung.
const cssSrc = readFileSync(
  fileURLToPath(new URL('./styles/reader.css', import.meta.url)),
  'utf8',
)

const W = 390
const now = 1000

function tapAt(
  tracker: ReturnType<typeof createTapTracker>,
  x: number,
  t: number,
  width = W,
  tapScroll = false,
): TapAction {
  tracker.down(1, 'touch', x, 400, t)
  const action = tracker.resolve(x, 400, t, width, tapScroll)
  tracker.up(1)
  return action
}

describe('B1 — tap map + double-tap zoom', () => {
  it('tengah 60% toggle HUD; tepi 20% default OFF', () => {
    expect(tapAt(createTapTracker(), W / 2, now)).toEqual({ type: 'hud' })
    expect(tapAt(createTapTracker(), W * 0.1, now)).toEqual({ type: 'none' })
    expect(tapAt(createTapTracker(), W * 0.9, now)).toEqual({ type: 'none' })
  })

  it('tap tepi opsional menggulir 75% viewport (kiri maju, kanan mundur)', () => {
    expect(tapAt(createTapTracker(), W * 0.1, now, W, true)).toEqual({
      type: 'scroll',
      direction: 1,
    })
    expect(tapAt(createTapTracker(), W * 0.9, now, W, true)).toEqual({
      type: 'scroll',
      direction: -1,
    })
    expect(footerSrc).toContain('data-reader-scrubber')
  })

  it('double-tap di titik sentuh toggle zoom 1 ↔ 1.8', () => {
    const t = createTapTracker()
    expect(tapAt(t, 120, now)).toEqual({ type: 'hud' })
    expect(tapAt(t, 124, now + 180)).toEqual({ type: 'zoom', x: 124, y: 400 })
    // setelah zoom, tap berikutnya bukan double-tap lagi
    expect(tapAt(t, 124, now + 400)).toEqual({ type: 'hud' })
    for (const src of [readerSrc, marathonSrc]) {
      expect(src).toContain('reader-zoom-flow')
      expect(src).toContain('setZoomOrigin')
      expect(src).toContain('z) => (z > 1 ? 1 : 1.8)')
      expect(src).toContain("prefers-reduced-motion: reduce")
    }
    expect(cssSrc).toContain('transform-origin: 50% 50%')
    expect(cssSrc).toMatch(/@media \(prefers-reduced-motion: reduce\)[\s\S]*reader-zoom-flow/)
    expect(tapSrc).not.toContain('will-change')
    expect(cssSrc).not.toContain('will-change')
  })

  it('drag >12px, tahan >900ms, pointercancel, pinch, dan kontrol bukan tap', () => {
    const moved = createTapTracker()
    moved.down(1, 'touch', 100, 400, now)
    expect(moved.resolve(113, 400, now + 50, W)).toEqual({ type: 'none' })

    const held = createTapTracker()
    held.down(1, 'touch', 100, 400, now)
    expect(held.resolve(100, 400, now + 901, W)).toEqual({ type: 'none' })

    const cancelled = createTapTracker()
    cancelled.down(1, 'touch', 100, 400, now)
    cancelled.cancel(1)
    expect(cancelled.resolve(100, 400, now + 40, W)).toEqual({ type: 'none' })

    const pinch = createTapTracker()
    pinch.down(1, 'touch', 100, 400, now)
    pinch.down(2, 'touch', 140, 400, now)
    expect(pinch.resolve(100, 400, now + 40, W)).toEqual({ type: 'none' })

    const control = createTapTracker((x) => x > 300)
    expect(tapAt(control, 320, now)).toEqual({ type: 'none' })
  })
})

describe('B2 — panel anti-CLS', () => {
  it('copy panel + Muat ulang 44px, slot inline, skeleton 65vh', () => {
    expect(comicSrc).toContain('`Panel ${pageNumber} gagal dimuat`')
    expect(comicSrc).toContain('`${label} · Muat ulang`')
    expect(comicSrc).toContain('reader-panel-failed')
    expect(comicSrc).toContain('min-h-11')
    expect(comicSrc).toContain('Memuat panel ${panelNumber}...')
    expect(comicSrc).toContain('reader-panel-skeleton')
    expect(cssSrc).toMatch(/reader-panel-skeleton[\s\S]*min-height: 65vh/)
    expect(cssSrc).toMatch(/reader-panel-failed[\s\S]*min-height: 160px/)
    expect(cssSrc).toContain('#141820')
    expect(cssSrc).toContain('#1d2330')
  })

  it('3 panel pertama eager/high, sisanya lazy + horizon 1200px', () => {
    expect(readerSrc).toContain('eager={i < 3}')
    expect(marathonSrc).toContain('eager={bi === 0 && i < 3}')
    expect(comicSrc).toContain('mountAhead = 1200')
    expect(comicSrc).toContain('rootMargin: `${mountAhead}px 0px`')
  })
})

describe('B3 — scrubber + canvas theme/night shield', () => {
  it('scrubber satu baris di atas footer nav', () => {
    expect(footerSrc).toContain('aria-label="Pilih halaman"')
    expect(footerSrc).toContain('aria-valuetext={`Hal. ${shown} · ${percent}%`}')
    expect(footerSrc).toContain('onPointerUp={commit}')
    expect(footerSrc).toContain('onSeek?.(preview)')
    expect(footerSrc).toContain('min-h-11 flex-1 touch-manipulation')
    expect(footerSrc).toContain('Hal. ${shown} · ${percent}%')
    for (const src of [readerSrc, marathonSrc]) {
      expect(src).toContain('<ReaderFooter')
      expect(src).toContain('pageCount=')
    }
    const scr = footerSrc.indexOf('reader-scrubber')
    const nav = footerSrc.indexOf('<nav')
    expect(scr).toBeGreaterThan(0)
    expect(nav).toBeGreaterThan(scr)
  })

  it('tema kanvas terpisah dari app theme, default Arang #090B0E', () => {
    expect(menuSrc).toContain("canvasTheme: 'arang'")
    expect(menuSrc).toContain('canvasTheme: CanvasTheme')
    expect(sheetSrc).toContain("'Arang'")
    expect(sheetSrc).toContain("'OLED'")
    expect(sheetSrc).toContain("'Sepia Gelap'")
    expect(sheetSrc).toContain("'Terang'")
    expect(cssSrc).toContain('background-color: #000000')
    expect(cssSrc).toContain('background-color: #1a1612')
    expect(cssSrc).toContain('background-color: #f6f7f9')
    // keep paperLight compatibility without changing the default canvas
    expect(sheetSrc).toContain('settings.paperLight')
    expect(sheetSrc).toContain("value={settings.paperLight ? 'Terang' : canvasLabel(settings.canvasTheme)}")
  })

  it('brightness/warmth jadi overlay z-40, bukan filter per panel', () => {
    expect(settingsSrc).toContain('const dimOpacity =')
    expect(settingsSrc).toContain('const warmOpacity =')
    expect(settingsSrc).not.toContain('brightness(${settings.brightness}%)')
    expect(cssSrc).toMatch(/\.reader-night-overlay[\s\S]*z-index: 40/)
    expect(cssSrc).toMatch(/\.reader-night-overlay[\s\S]*pointer-events: none/)
    for (const src of [readerSrc, marathonSrc]) {
      expect(src).toContain('reader-night-overlay')
      expect(src).toContain('rgba(255,160,70,${warmOpacity})')
    }
  })
})

describe('A2 — restore toast, prefetch, source fallback', () => {
  it('toast restore hanya setelah anchor berhasil diterapkan', () => {
    for (const src of [readerSrc, marathonSrc]) {
      expect(src).toContain('showToastWithAction')
      expect(src).toContain('Melanjutkan dari Hal.')
      expect(src).toContain("'Ke awal'")
      expect(src).toContain('restoreToastShown')
      expect(src).toContain('top: 0')
    }
  })

  it('prefetch metadata + 3 panel, tetap hormati hemat/saveData', () => {
    expect(readerSrc).toContain('(d.images ?? []).slice(0, 3)')
    expect(readerSrc).toContain('mode === \'hemat\' || conn?.saveData')
    expect(marathonSrc).toContain('(d.images ?? []).slice(0, 3)')
    expect(marathonSrc).toContain("settings.prefetchMode !== 'hemat' && !conn?.saveData")
  })

  it('fallback hanya memakai tautan eksplisit dari data (tanpa endpoint rekaan)', () => {
    for (const src of [readerSrc, marathonSrc]) {
      expect(src).toContain('Gambar bermasalah di {source} · Coba sumber lain')
      expect(src).toContain('alternateSourceLinks')
      expect(src).toContain("typeof r.href === 'string'")
      expect(src).toContain("typeof r.url === 'string'")
      expect(src).toContain("href.startsWith('/')")
      expect(src).toContain('^https?:\\/\\/')
    }
    expect(readerSrc).toContain('failedPages.size > 3')
    expect(marathonSrc).toContain('failedPanels.size > 3')
  })
})
