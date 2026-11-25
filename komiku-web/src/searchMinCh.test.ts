import { afterEach, describe, expect, it, vi } from 'vitest'
import { unifiedApi } from './api'
import { readSearchReturn, searchReturnQuery, type SearchReturnState } from './searchReturn'

afterEach(() => {
  vi.unstubAllGlobals()
})

const payload: SearchReturnState = {
  query: 'Solo Leveling',
  filter: {
    source: 'semua',
    sort: 'terbaru',
    tipe: '',
    status: 'Completed',
    genre: '',
    min_ch: '50',
  },
  scrollY: 0,
  href: '/manga/mangaku:1',
}

describe('min_ch filter', () => {
  it('mengirim min_ch hanya kalau > 0', async () => {
    const urls: string[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        urls.push(url)
        return { ok: true, json: async () => ({ items: [], has_more: false }) }
      }),
    )
    await unifiedApi.search('Solo Leveling', 1, undefined, { status: 'Completed', min_ch: 50 })
    await unifiedApi.catalogue(2, undefined, { min_ch: 0 })
    await unifiedApi.search('x', 1, undefined, { min_ch: null })

    expect(urls[0]).toContain('&status=Completed&min_ch=50')
    expect(urls[1]).not.toContain('min_ch')
    expect(urls[2]).not.toContain('min_ch')
  })

  it('mengirim limit=20 eksplisit di search/catalogue/popular/latest', async () => {
    const urls: string[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        urls.push(url)
        return { ok: true, json: async () => ({ items: [], has_more: false }) }
      }),
    )
    await unifiedApi.search('q', 1)
    await unifiedApi.catalogue(2)
    await unifiedApi.popular(3)
    await unifiedApi.latest(4)

    expect(urls[0]).toContain('/unified/search?q=q&page=1&limit=20')
    expect(urls[1]).toBe('/api/unified/catalogue?page=2&limit=20')
    expect(urls[2]).toBe('/api/unified/popular?page=3&limit=20')
    expect(urls[3]).toBe('/api/unified/latest?page=4&limit=20')
  })

  it('memulihkan min_ch dari state pergi-pulang', () => {
    vi.stubGlobal('window', {
      sessionStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
      history: { state: null, replaceState: () => {} },
    })
    expect(readSearchReturn({ cariReturn: payload })?.filter.min_ch).toBe('50')
    expect(searchReturnQuery(payload)).toBe('?q=Solo+Leveling&status=Completed&min_ch=50')
  })
})
