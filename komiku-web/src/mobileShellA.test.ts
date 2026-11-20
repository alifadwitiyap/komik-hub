/** Kontrak mobile shell workstream A: boot skeleton, nav pill, kartu anti-clutter. */
import { describe, it, expect } from 'vitest'
import bootSrc from '../index.html?raw'
import appSrc from './App.tsx?raw'
import homeSrc from './pages/Home.tsx?raw'
import continueSrc from './components/ContinueReading.tsx?raw'

describe('Boot skeleton struktural', () => {
  it('sibling #root, struktural, tanpa teks Memuat', () => {
    expect(bootSrc).toMatch(/<div id="root"><\/div>\s*<div id="boot-skeleton"/)
    expect(bootSrc).not.toContain('Memuat…')
    expect(bootSrc).toContain('aspect-ratio: 16 / 7')
    expect(bootSrc).toContain('aspect-ratio: 3 / 4')
    expect(bootSrc).toContain('grid-template-columns: repeat(3')
    expect(bootSrc).toContain('kb-boot-shimmer')
    expect(bootSrc).toContain("opacity 180ms var(--ease-out-quint)")
  })

  it('tidak mengubah preload font dan bootstrap tema', () => {
    expect(bootSrc).toContain('href="/fonts/NunitoSans-Regular.woff2"')
    expect(bootSrc).toContain("localStorage.getItem('komik-theme')")
    expect(bootSrc).toContain("matchMedia('(prefers-color-scheme: dark)').matches")
    expect(bootSrc).toContain('document.documentElement.style.colorScheme = t')
    expect(bootSrc).toContain('document.documentElement.classList')
    const skeleton = bootSrc.slice(bootSrc.indexOf('<div id="boot-skeleton"'))
    expect(skeleton).not.toMatch(/https?:\/\//)
    expect(skeleton).not.toMatch(/url\(/)
  })
})

describe('App shell', () => {
  it('fade skeleton setelah mount lalu hapus node', () => {
    expect(appSrc).toContain("getElementById('boot-skeleton')")
    expect(appSrc).toContain("boot.dataset.fading = 'true'")
    expect(appSrc).toContain('requestAnimationFrame(')
    expect(appSrc).toContain('setTimeout(() => boot.remove(), 220)')
  })

  it('nav mengambang dengan satu pill persisten (bukan remount)', () => {
    expect(appSrc).toContain('aria-label="Navigasi utama"')
    expect(appSrc).toContain('bg-ink-900/88')
    expect(appSrc).toContain('backdrop-blur-[16px]')
    expect(appSrc).toContain('border-hairline')
    expect(appSrc).toContain('pb-[env(safe-area-inset-bottom)]')
    expect(appSrc).toContain('w-[calc((100%-0.5rem)/3)]')
    expect(appSrc).toContain('translateX(${activeIndex * 100}%)')
    expect(appSrc).toContain('transition-transform duration-[var(--dur-ui)]')
    expect(appSrc).toContain('group-active:scale-[0.88]')
    expect(appSrc).not.toContain('nav-indicator')
    expect(appSrc).not.toContain('backdrop-blur"')
    expect(appSrc.match(/to: '\/(cari|rak)'/g)?.length).toBe(2)
  })
})

describe('Kartu dan rail anti-clutter', () => {
  it('snap proximity, px-4, satu badge dan cover 3/4', () => {
    expect(homeSrc).toContain('snap-x snap-proximity')
    expect(homeSrc).not.toContain('snap-mandatory')
    expect(homeSrc).toContain('relative px-4 pt-3')
    expect(homeSrc).toContain('tactile-press group block w-[132px]')
    expect(homeSrc).toContain('aspect-[3/4] overflow-hidden rounded-xl')
    expect(homeSrc).not.toContain('aspect-[62/82]')
    expect(homeSrc).toContain('text-ink-600')
  })

  it('referrerPolicy tetap ada di semua img sampul Home', () => {
    const imgs = homeSrc.match(/<img[^>]*>/g) ?? []
    expect(imgs.length).toBeGreaterThan(0)
    for (const img of imgs) expect(img).toContain('referrerPolicy="no-referrer"')
  })
})

describe('ContinueReading progress', () => {
  it('progress 0..1 dirender sebagai scaleX transform', () => {
    expect(continueSrc).toContain('progress: number | null')
    expect(continueSrc).toContain('progress: Math.min(1, Math.max(0, p.progress))')
    expect(continueSrc).toContain('h-[3px]')
    expect(continueSrc).toContain('origin-left bg-brand-amber')
    expect(continueSrc).toContain('scaleX(${item.progress})')
    expect(continueSrc).toContain('data-testid="continue-reading-card"')
    expect(continueSrc).toContain('data-resume-source')
  })
})
