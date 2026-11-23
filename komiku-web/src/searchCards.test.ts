/**
 * Kontrak sumber untuk Search kompak + kartu katalog/lanjut-baca (P1).
 * Vitest env = 'node', jadi assertion `?raw` mengunci kontrak literal, bukan
 * render DOM. Pola sama dipakai p1AnimationMotion.test.ts / p2A11y.test.ts.
 */
import { describe, it, expect } from 'vitest'
import searchSrc from './pages/Search.tsx?raw'
import homeSrc from './pages/Home.tsx?raw'
import continueSrc from './components/ContinueReading.tsx?raw'
import heartSrc from './components/HeartButton.tsx?raw'

describe('Search kompak 320px', () => {
  it('judul sr-only + kontrol search/filter/urutkan rapat tapi target sentuh tetap 44px', () => {
    expect(searchSrc).toContain('<div className="mx-auto max-w-3xl px-3 py-3">')
    expect(searchSrc).toContain('<h1 className="sr-only">Cari manga</h1>')
    expect(searchSrc).toContain('data-search-controls')
    expect(searchSrc).toContain('data-search-form')
    expect(searchSrc).toContain('className="flex gap-1.5"')
    expect(searchSrc).toContain('aria-label="Cari"')
    // Filter + hitungan aktif tetap terbaca,Ci dan keduanya min-h-11.
    expect(searchSrc).toContain('Filter{activeChips.length > 0 ? ` (${activeChips.length})` : \'\'}')
    expect(searchSrc).toContain('inline-flex min-h-11 flex-1 touch-manipulation')
    expect(searchSrc).toContain('px-2.5 py-1.5 text-[12.5px] font-bold')
    expect(searchSrc).toContain('aria-label="Urutkan hasil"')
    expect(searchSrc).toContain('pr-7 text-[12.5px] font-semibold')
    // Riwayat tidak lagi mengambil ruang sebelum hasil.
    expect(searchSrc).not.toContain('mt-5">\n          {loading && <SkeletonCards />}')
  })

  it('riwayat hanya saat input aktif; submit mematikan dan hasil langsung dekat atas', () => {
    expect(searchSrc).toContain('{inputActive && !riwayatDimatikan && !searching && (')
    expect(searchSrc).toContain('data-recent-searches')
    expect(searchSrc).toContain('setRiwayatDimatikan(true)')
    expect(searchSrc).toContain('onFocus={() => setRiwayatDimatikan(false)}')
    expect(searchSrc).toContain('setInputActive(true)')
    expect(searchSrc).toContain('setRiwayatDimatikan(false)')
    // Submit tidak menambah riwayat pencarian ke layar hasil.
    expect(searchSrc).toContain('const commitQuery = (v: string) => {\n    setRiwayatDimatikan(true)')
    expect(searchSrc).toContain('{searching ? (\n        <div className="mt-2">')
    expect(searchSrc).toContain('data-search-count className="text-[11.5px] text-ink-500"')
    expect(searchSrc).toContain('<ResultGrid items={results} />')
    // Event delegation link/history tidak berubah.
    expect(searchSrc).toContain('writeSearchReturn({')
    expect(searchSrc).toContain('query,\n        filter: cloneFilters(params),')
    expect(searchSrc).toContain('scrollY: window.scrollY,')
    expect(searchSrc).toContain('href: link.getAttribute(\'href\') ?? \'\',')
  })
})

describe('Kartu katalog: cover + judul 2 baris + label Ch.', () => {
  it('MangaCard / Search memakai satu sumber label chapter eksplisit', () => {
    expect(homeSrc).toContain('export function chapterLabel(manga: Manga): string | null {')
    expect(homeSrc).toContain("const raw = first.trim().replace(/^Chapter\\s+/i, '')")
    expect(homeSrc).toContain("const number = raw.replace(/^Ch\\.\\s*/i, '')")
    expect(homeSrc).toContain('return `Ch. ${number}`')
    expect(homeSrc).toContain('const label = chapterLabel(manga)')
    expect(homeSrc).toContain('aspect-[62/82] overflow-hidden rounded-xl')
    expect(homeSrc).toContain('line-clamp-2 font-display text-[12.5px] font-medium')
    expect(homeSrc).toContain('{label}')
    expect(searchSrc).toContain('<MangaCard manga={m} />')
    expect(searchSrc).not.toContain('withChapterLabel')
    expect(searchSrc).not.toContain('Terbaru · Ch.')
  })

  it('carousel, heart, dan Rak tab tidak berubah (target 44px)', () => {
    // ContinueReading tetap di atas carousel di Home.
    expect(homeSrc).toMatch(/<ContinueReading \/>\s*\{?\s*\/\*[\s\S]*?shortcut menu[\s\S]*?\{\/\*[\s\S]*?BackdropCarousel/)
    expect(homeSrc).toContain('aria-label={`Menuju slide ${i + 1}`}')
    expect(homeSrc).toContain("aria-current={i === idx ? 'true' : undefined}")
    expect(homeSrc).toContain('aria-label={autoplay ? \'Jeda putar otomatis\' : \'Lanjutkan putar otomatis\'}')
    expect(homeSrc).toContain('size-11')
    expect(heartSrc).toContain('min-h-11 min-w-11')
  })
})

describe('ContinueReading kartu horizontal di atas carousel', () => {
  it('satu kartu: cover kecil, judul, chapter, sumber opsional, satu aksi Lanjut baca', () => {
    expect(continueSrc).toContain("import { sourceLabel } from './SourceBadge'")
    expect(continueSrc).toContain('source: string | null')
    expect(continueSrc).toContain('source: p.source ?? entry.source')
    expect(continueSrc).toContain('source: entry.source')
    expect(continueSrc).toContain('const source = sourceLabel(item.source)')
    expect(continueSrc).toContain('data-testid="continue-reading-card"')
    expect(continueSrc).toContain('className="flex min-h-20 items-center gap-3')
    expect(continueSrc).toContain('size-16 shrink-0 overflow-hidden rounded-xl')
    expect(continueSrc).toContain('{item.chapter}{item.page != null ? ` · Hal. ${item.page + 1}` : \'\'}')
    expect(continueSrc).toContain('data-resume-source')
    expect(continueSrc).toContain('{source}')
    // Satu aksi; sisanya tautan detail yang sama (link kartu + "Lihat semua").
    expect(continueSrc.match(/Lanjut baca/g)?.length).toBe(1)
    expect(continueSrc).toContain('to={item.href}')
    expect(continueSrc).toContain('to="/rak?tab=sejarah"')
    expect(continueSrc).toContain('min-h-11 min-w-11')
  })
})
