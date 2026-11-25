/**
 * P2 — ANIMASI & AKSESIBILITAS: source-contract tests.
 *
 * Vitest env = 'node' (tanpa jsdom / @testing-library), jadi file .tsx tidak
 * dirender. Import `?raw` di sini BUKAN render assertion — ini mengunci
 * kontrak literal (class utilitas, atribut ARIA, token kontras, timings) yang
 * lived di source. Pendekatan yang sama dipakai downloadA11y.test.ts.
 * Kontras dihitung dari nilai token CSS aktual (bukan perkiraan) — angka
 * tertanam di komentar di bawah supaya audit bisa diverifikasi ulang.
 *
 * Run: npx vitest run src/p2A11y.test.ts
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import toolbarSrc from './components/ReaderToolbar.tsx?raw'
import footerSrc from './components/ReaderFooter.tsx?raw'
import heartSrc from './components/HeartButton.tsx?raw'
import comicImgSrc from './components/ComicImage.tsx?raw'
import notifSrc from './components/NotifPanel.tsx?raw'
import chapterSheetSrc from './components/ChapterPickerSheet.tsx?raw'
import modeSheetSrc from './components/ModeBacaSheet.tsx?raw'
import settingsSheetSrc from './components/ReaderSettingsSheet.tsx?raw'
import homeSrc from './pages/Home.tsx?raw'

const sheetsCssSrc = readFileSync(fileURLToPath(new URL('./styles/sheets.css', import.meta.url)), 'utf8')
const css = readFileSync(fileURLToPath(new URL('./index.css', import.meta.url)), 'utf8')

describe('P2 kontras teks', () => {
  it('token teks brand gelap didefinisikan di .dark dengan nilai teraudit', () => {
    // dark bg ink-950 #1a1b1e: #7dc1e6 = 8.73:1, #c792e0 = 7.07:1
    expect(css).toContain('--color-brand-amber-text: #7dc1e6')
    expect(css).toContain('--color-brand-red-text: #c792e0')
  })

  it('class utilitas text-brand-* ditimpa hanya di .dark (fill tidak berubah)', () => {
    expect(css).toMatch(/\.dark \.text-brand-amber\s*\{[^}]*var\(--color-brand-amber-text\)/)
    expect(css).toMatch(/\.dark \.text-brand-red\s*\{[^}]*var\(--color-brand-red-text\)/)
    // fill tetap pakai token asli — jangan pernah menimpa bg-brand-amber
    expect(css).not.toMatch(/\.dark \.bg-brand-amber\s*\{/)
  })

  it('brand-red light dinaikkan ke #7c3aed (4.40:1 -> 5.16:1 di ink-950)', () => {
    expect(css).toMatch(/:root:not\(\.dark\) \.text-brand-red\s*\{[^}]*#7c3aed/)
  })

  it('ink-400 light diganti #6c6e73 (2.85:1 -> 4.62:1 di ink-950)', () => {
    expect(css).toContain('--color-ink-400: #6c6e73')
  })
})

describe('P2 animasi — durasi & sifat sesuai rentang rencana', () => {
  it('toolbar reader fade opacity 140ms, tanpa transform (tidak geser scroll)', () => {
    expect(css).toMatch(/\.reader-chrome-fade\s*\{[^}]*transition:\s*opacity 140ms var\(--ease-out\)/)
    expect(css).toContain(".reader-chrome-fade[data-hidden='true']")
    for (const src of [toolbarSrc, footerSrc]) {
      expect(src).toContain('reader-chrome-fade')
      expect(src).toContain('data-hidden={!visible}')
      // lama: transition-transform duration-200 + translate-y-* → Dihapus
      expect(src).not.toContain('transition-transform duration-200')
      expect(src).not.toContain('translate-y-full')
      expect(src).not.toContain('-translate-y-full')
      expect(src).toContain('aria-hidden={!visible}')
      expect(src).toContain('inert={!visible}')
    }
  })

  it('sheet masuk 240ms ease-out-emil, keluar 160ms, sticky header, tanpa touch-through', () => {
    // Kontrak baru: durasi enter dari token --dur-sheet (240ms) di sheets.css.
    // Normalisasi whitespace dulu: aturan CSS dibarisan agar mudah dibaca.
    const sheetCss = sheetsCssSrc.replace(/\s+/g, ' ')
    expect(sheetCss).toContain(
      '.sheet-panel.sheet-panel { transition: transform var(--dur-sheet) var(--ease-out-emil), opacity var(--dur-sheet) var(--ease-out-emil); animation: sheet-interactive var(--dur-sheet) step-end forwards; }',
    )
    expect(sheetCss).toContain(
      '.sheet-panel.sheet-panel.sheet-closing { transition-duration: 160ms; transition-timing-function: var(--ease-drawer); }',
    )
    expect(sheetCss).toContain('@starting-style')
    // Token di motion.css (milik workstream ini) = 240ms, press 100ms.
    const motionCss = readFileSync(fileURLToPath(new URL('./styles/motion.css', import.meta.url)), 'utf8')
    expect(motionCss).toMatch(/--dur-sheet:\s*240ms/)
    expect(motionCss).toMatch(/--dur-press:\s*100ms/)
    // Gate pointer-events tetap dari index.css (tidak diedit workstream ini).
    expect(css).toMatch(/\.sheet-panel\s*\{[^}]*pointer-events:\s*none/)
    expect(css).toMatch(/@keyframes sheet-interactive\s*\{[^}]*to\s*\{\s*pointer-events:\s*auto/)
    for (const src of [chapterSheetSrc, modeSheetSrc, settingsSheetSrc]) {
      expect(src).toContain('sticky top-0')
      expect(src).toContain('useSheetDrag')
      expect(src).toContain('h-11')
      expect(src).toContain('h-1 w-9')
    }
    // fokus dikembalikan ke pembuka tanpa menggulir halaman (preventScroll)
    expect(chapterSheetSrc).toContain('opener?.focus({ preventScroll: true })')
    expect(chapterSheetSrc).toContain('singleSourceLabel')
    expect(chapterSheetSrc).toContain('<SourceBadge')
    expect(chapterSheetSrc).toContain('showSourceBadge && c.source')
    expect(modeSheetSrc).toContain('prev?.focus({ preventScroll: true })')
    expect(settingsSheetSrc).toContain('openerRef.current?.focus({ preventScroll: true })')
  })

  it('favorit: isi + satu kali scale 1.08× 150ms + konfirmasi teks', () => {
    // Blok keyframes punya dua setkur bertingkat; cek urutan baris.
    expect(css).toContain('@keyframes heart-confirm {')
    expect(css).toMatch(/scale\(1\.08\)/)
    expect(css.indexOf('@keyframes heart-confirm {')).toBeLessThan(css.indexOf('scale(1.08)'))
    expect(css).toMatch(/\.animate-heart-confirm\s*\{[^}]*animation:\s*heart-confirm 150ms var\(--ease-out\)/)
    expect(heartSrc).toContain("loved ? 'fill-brand-amber stroke-brand-amber' : 'fill-none stroke-current'")
    expect(heartSrc).toContain("pop ? 'animate-heart-confirm' : ''")
    expect(heartSrc).toContain("loved ? 'Difavoritkan' : 'Favorit'")
    expect(heartSrc).toContain('aria-pressed={loved}')
  })

  it('placeholder gambar mengunci rasio sejak awal, termasuk saat gagal', () => {
    // 2 holder: normal (line ~411) + failed (line ~387) — keduanya style ratio
    const matches = comicImgSrc.match(/style=\{ratio \? \{ aspectRatio: String\(ratio\) \} : undefined\}/g) ?? []
    expect(matches.length).toBe(2)
    expect(comicImgSrc).toContain('motion-reduce:animate-none')
    // Skeleton anti-CLS mengisi slot yang sama, fade 100–140ms saat decode.
    expect(comicImgSrc).toContain('data-reader-skeleton=""')
    expect(comicImgSrc).toContain('skeleton-shimmer comic-image-fade')
    const readerCss = readFileSync(fileURLToPath(new URL('./styles/reader.css', import.meta.url)), 'utf8')
    expect(readerCss).toMatch(/\.reader-canvas-paper \.skeleton-shimmer/)
    // P1: holder gagal tidak menghapus kotaknya — retry mengganti src gambar
    // yang sama, jadi tinggi halaman tidak berubah.
    expect(comicImgSrc).toContain('key={attempt}')
  })

  it('placeholder→gambar fade 120ms (100–140ms), cache instan, tanpa layout shift', () => {
    expect(css).toMatch(/\.comic-image-fade\s*\{[^}]*transition:\s*opacity 120ms var\(--ease-out\)/)
    expect(css).toMatch(/\.comic-image-fade\[data-instant='true'\]\s*\{[^}]*transition:\s*none/)
    expect(comicImgSrc).toContain('comic-image-fade')
    expect(comicImgSrc).toContain("data-instant={instantRef.current ? 'true' : undefined}")
    expect(comicImgSrc).toContain('instantRef.current = true')
    expect(comicImgSrc).toContain('el.complete && el.naturalWidth > 0')
  })

  it('reduced motion: semua motion jadi INSTAN (0ms), carousel autoplay stop via JS', () => {
    expect(css).toContain('@media (prefers-reduced-motion: reduce)')
    expect(css).toMatch(/animation:\s*none !important/)
    expect(css).toMatch(/transition-property:\s*none !important/)
    expect(css).toMatch(/transition-duration:\s*0ms !important/)
    expect(css).toMatch(/scroll-behavior:\s*auto !important/)
    expect(css).toMatch(/\.sheet-panel\s*\{\s*pointer-events:\s*auto !important/)
  })
})

describe('P2 carousel Beranda — jeda, stop manual, indikator sinkron', () => {
  it('autoplay dijeda saat reduced-motion, saat tab hidden, saat fokus di carousel', () => {
    expect(homeSrc).toContain("window.matchMedia('(prefers-reduced-motion: reduce)')")
    expect(homeSrc).toContain('if (mq.matches) return')
    expect(homeSrc).toContain('tabHidden')
    expect(homeSrc).toContain('focusInside')
    expect(homeSrc).toContain('onPointerDownCapture={() => setAutoplay(false)}')
  })

  it('tombol jeda punya label dinamis, status pressed, target 44px', () => {
    expect(homeSrc).toContain("aria-label={autoplay ? 'Jeda putar otomatis' : 'Lanjutkan putar otomatis'}")
    expect(homeSrc).toContain('aria-pressed={!autoplay}')
    expect(homeSrc).toContain('size-11')
  })

  it('dot indikator sinkron dengan slide aktif via aria-current', () => {
    expect(homeSrc).toContain('aria-label={`Menuju slide ${i + 1}`}')
    expect(homeSrc).toContain("aria-current={i === idx ? 'true' : undefined}")
  })
})

describe('P2 fokus keyboard & target sentuh pada komponen yang diown', () => {
  it('semua tombol ikon punya aria-label + focus-visible ring', () => {
    expect(toolbarSrc).toContain('aria-label="Kembali"')
    expect(toolbarSrc).toContain('aria-label="Beranda"')
    expect(toolbarSrc).toContain('aria-label="Bagikan"')
    expect(toolbarSrc).toContain('aria-label="Menu"')
    expect(footerSrc).toContain('aria-label="Pilih Chapter"')
    expect(footerSrc).toContain('aria-label="Navigasi chapter"')
    expect(notifSrc).toContain('aria-label={`Buka notifikasi ${g.latest.title}`}')
    expect(notifSrc).toContain('aria-label={`Hapus notifikasi ${g.latest.title}`}')
    for (const src of [toolbarSrc, footerSrc, notifSrc, heartSrc]) {
      expect(src).toContain('focus-visible:ring-2')
    }
  })

  it('target sentuh utama minimal 44px (min-h-11 / min-w-11 / size-11)', () => {
    for (const src of [toolbarSrc, footerSrc, notifSrc, heartSrc]) {
      expect(src).toMatch(/min-h-11|size-11/)
    }
    expect(heartSrc).toContain('min-h-11 min-w-11')
  })
})
