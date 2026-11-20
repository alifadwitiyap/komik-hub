import { describe, expect, it } from 'vitest'
import { genreHref, resumeCta } from './pages/Series'
import searchSrc from './pages/Search.tsx?raw'
import seriesSrc from './pages/Series.tsx?raw'
import unifiedSrc from './pages/SeriesUnified.tsx?raw'
import recentSrc from './recentSearches.ts?raw'

describe('detail: genre chip → /cari?genre=', () => {
  it('memakai id slug dari API apa adanya', () => {
    expect(genreHref('action', 'Action')).toBe('/cari?genre=action')
    expect(genreHref('shounen', 'Shounen')).toBe('/cari?genre=shounen')
  })

  it('kunci desain tidak diubah; URL genre lama dibersihkan jadi slug', () => {
    expect(genreHref('/genre/boys-love/', "Boys' Love")).toBe('/cari?genre=boys-love')
    expect(genreHref('', 'Slice of Life')).toBe('/cari?genre=slice-of-life')
    expect(genreHref('', '')).toBe('/cari')
  })

  it('chips 44px dan hanya dirender kalau data genre ada', () => {
    expect(seriesSrc).toContain('to={genreHref(g.id, g.name)}')
    expect(seriesSrc).toContain('inline-flex min-h-11 items-center rounded-full')
    expect(unifiedSrc).toContain('{unifiedGenres && unifiedGenres.length > 0 && (')
    expect(unifiedSrc).toContain('MangaOut belum punya field genre di kontrak API unified')
  })
})

describe('detail: CTA lanjut baca', () => {
  it('kunci chapter persis dipertahankan', () => {
    expect(resumeCta({ chapterId: 'komiku:1548:1189.2', page: 55, progress: 0.64 }, 55)).toEqual({
      label: 'Lanjut Chapter 1189.2',
      sub: 'Hal. 56 · 64%',
    })
    expect(resumeCta({ chapterId: '811 Fix', page: 0, progress: 0 }, 0)?.label)
      .toBe('Lanjut Chapter 811 Fix')
  })

  it('halaman dan persen dibatasi rentang data yang sah', () => {
    expect(resumeCta({ chapterId: '7', page: 2, progress: 1.4 })?.sub).toBe('Hal. 3 · 100%')
    expect(resumeCta({ chapterId: '7', page: -3, progress: -0.2 })?.sub).toBe('Hal. 1 · 0%')
    expect(resumeCta(undefined)?.label).toBeUndefined()
  })

  it('fallback fresh user dan marathon tidak dihapus', () => {
    expect(seriesSrc).toContain('cta = { label: `Baca ${oldest.name}`, to: readerHref(String(oldest.id)) }')
    expect(seriesSrc).toContain('marathonLink ?? marathonHref(String(oldest.id))')
    expect(unifiedSrc).toContain("marathonLink ?? `/maraton/${handle}/${oldest.number}`")
    expect(unifiedSrc).toContain('`Baca ${chapterLabel(oldest)}`')
  })
})

describe('search: history 6 chip + trending statis + grid 2 kolom', () => {
  it('history punya tombol hapus per chip dan global clear hanya saat >1', () => {
    expect(recentSrc).toContain('RECENT_MAX = 6')
    expect(searchSrc).toContain('setRecent(forgetRecent(r))')
    expect(searchSrc).toContain('aria-label={`Hapus ${r}`}')
    expect(searchSrc).toContain('min-h-11 min-w-11 shrink-0 place-items-center')
    expect(searchSrc).toContain('{recent.length > 1 && (')
  })

  it('label trending tidak mengaku data live', () => {
    expect(searchSrc).toContain('Sedang Ramai Dicari')
    expect(searchSrc).not.toContain('Coba cari')
  })

  it('2 kolom kartu ringkas tetap memakai cover 2:3 dan judul 2 baris', () => {
    expect(searchSrc).toContain('grid grid-cols-2 gap-2 [&>ul]:contents')
    expect(searchSrc).toContain('[&>ul>li>a>div:first-child]:w-full')
    expect(searchSrc).toContain('[&>ul>li>a>div:last-child>p:first-child]:text-[12.5px]')
    expect(searchSrc).toContain('[&>ul>li>a>div:last-child>p.font-bold]:bg-black/70')
    expect(searchSrc).toContain('<MangaCard manga={m} compact />')
  })
})
