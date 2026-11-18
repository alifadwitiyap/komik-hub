import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

let mod: typeof import('./searchReturn')

function memStorage(): Storage {
  const m = new Map<string, string>()
  return {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, v),
    removeItem: (k: string) => void m.delete(k),
    clear: () => m.clear(),
    key: (i: number) => [...m.keys()][i] ?? null,
    get length() {
      return m.size
    },
  } as Storage
}

function fakeWindow() {
  const s = memStorage()
  let historyState: unknown = null
  return {
    sessionStorage: s,
    get history() {
      return {
        get state() {
          return historyState
        },
        replaceState: (next: unknown) => {
          historyState = next
        },
      }
    },
  }
}

const payload = {
  query: 'Solo Leveling',
  filter: { source: 'mangaku', sort: 'rating', tipe: 'Manhwa', status: '', genre: 'action' },
  scrollY: 1234,
  href: '/manga/mangaku:123',
}

beforeEach(async () => {
  vi.resetModules()
  vi.stubGlobal('window', fakeWindow())
  mod = await import('./searchReturn')
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('searchReturn', () => {
  it('state navigasi dibaca utuh dan lebih utama dari sessionStorage', () => {
    mod.writeSearchReturn({ ...payload, query: 'lama', scrollY: 1 })
    expect(mod.readSearchReturn({ cariReturn: payload })).toEqual(payload)
  })

  it('jatuh ke sessionStorage saat state tidak ada', () => {
    mod.writeSearchReturn(payload)
    expect(mod.readSearchReturn(null)).toEqual(payload)
    mod.clearSearchReturn()
    expect(mod.readSearchReturn(null)).toBeNull()
  })

  it('query string-menu q + filter non-default', () => {
    expect(mod.searchReturnQuery(payload)).toBe(
      '?q=Solo+Leveling&source=mangaku&sort=rating&tipe=Manhwa&genre=action',
    )
    expect(
      mod.searchReturnQuery({
        ...payload,
        query: '',
        filter: { source: 'semua', sort: 'terbaru', tipe: '', status: '', genre: '' },
      }),
    ).toBe('')
  })

  it('payload rusak ditolak', () => {
    expect(mod.readSearchReturn({ cariReturn: { query: 'x' } })).toBeNull()
    expect(mod.readSearchReturn({ cariReturn: { ...payload, scrollY: NaN } })?.scrollY).toBe(0)
  })
})
