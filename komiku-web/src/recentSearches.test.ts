import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  forgetRecent,
  listRecent,
  RECENT_MAX,
  rememberSearch,
} from './recentSearches'

function storage(): Storage {
  const data = new Map<string, string>()
  return {
    get length() { return data.size },
    clear: () => data.clear(),
    getItem: (k: string) => data.get(k) ?? null,
    key: (i: number) => [...data.keys()][i] ?? null,
    removeItem: (k: string) => { data.delete(k) },
    setItem: (k: string, v: string) => { data.set(k, v) },
  }
}

describe('riwayat pencarian', () => {
  beforeEach(() => vi.stubGlobal('localStorage', storage()))

  it('maksimal 6 entri, terbaru di depan', () => {
    expect(RECENT_MAX).toBe(6)
    for (let i = 1; i <= 8; i++) rememberSearch(`q${i}`)
    expect(listRecent()).toEqual(['q8', 'q7', 'q6', 'q5', 'q4', 'q3'])
  })

  it('hapus satu entri tidak menghapus yang lain', () => {
    rememberSearch('action')
    rememberSearch('drama')
    expect(forgetRecent('ACTION')).toEqual(['drama'])
    expect(listRecent()).toEqual(['drama'])
  })

  it('hapus entri terakhir menyisakan daftar kosong', () => {
    rememberSearch('solo')
    expect(forgetRecent('solo')).toEqual([])
    expect(listRecent()).toEqual([])
  })
})
