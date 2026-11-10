import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type * as PageMemory from './pageMemory'

let pm: typeof PageMemory

function makeLocalStorage(): Storage {
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

beforeEach(async () => {
  vi.resetModules()
  vi.useFakeTimers()
  vi.stubGlobal('localStorage', makeLocalStorage())
  pm = await import('./pageMemory')
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('pageMemory', () => {
  it('clamp01 memotong ke [0,1]', () => {
    expect(pm.clamp01(-1)).toBe(0)
    expect(pm.clamp01(0.5)).toBe(0.5)
    expect(pm.clamp01(2)).toBe(1)
  })

  it('aspectOf null saat kosong', () => {
    expect(pm.aspectOf('https://a/1.jpg')).toBeNull()
  })

  it('aspectOf membaca nilai tersimpan', () => {
    globalThis.localStorage.setItem(
      'komiku.web.page-aspect.v1',
      JSON.stringify([['https://a/1.jpg', 1.5]]),
    )
    expect(pm.aspectOf('https://a/1.jpg')).toBe(1.5)
    expect(pm.aspectOf('https://a/missing.jpg')).toBeNull()
  })

  it('storage rusak diabaikan', () => {
    globalThis.localStorage.setItem('komiku.web.page-aspect.v1', '{oops')
    expect(pm.aspectOf('https://a/1.jpg')).toBeNull()
    globalThis.localStorage.setItem('komiku.web.page-aspect.v1', JSON.stringify('bukan-array'))
    expect(pm.aspectOf('https://a/1.jpg')).toBeNull()
  })

  it('rememberAspect menolak nilai tak wajar', () => {
    pm.rememberAspect('', 1, 1)
    pm.rememberAspect('x', 0, 1)
    pm.rememberAspect('x', 1, -1)
    vi.advanceTimersByTime(500)
    expect(globalThis.localStorage.getItem('komiku.web.page-aspect.v1')).toBeNull()
  })

  it('rememberAspect menyimpan (debounce) dan bisa dimuat ulang', async () => {
    pm.rememberAspect('https://a/1.jpg', 800, 400)
    pm.rememberAspect('https://a/2.jpg', 300, 600)
    expect(globalThis.localStorage.getItem('komiku.web.page-aspect.v1')).toBeNull()
    vi.advanceTimersByTime(500)
    const raw = globalThis.localStorage.getItem('komiku.web.page-aspect.v1')
    expect(raw).toContain('https://a/1.jpg')
    expect(raw).toContain('https://a/2.jpg')
    expect(raw).toContain('2')
    vi.resetModules()
    const fresh = await import('./pageMemory')
    expect(fresh.aspectOf('https://a/1.jpg')).toBe(2)
    expect(fresh.aspectOf('https://a/2.jpg')).toBeCloseTo(0.5)
  })

  it('anchorFrom memilih halaman terdekat ke tengah viewport', () => {
    vi.setSystemTime(1_000_000)
    const anchor = pm.anchorFrom(7, ['p1', 'p2', 'p3'], 100, 200, [0, 500, 1000], [500, 500, 500])
    expect(anchor).not.toBeNull()
    expect(anchor!.chapterId).toBe(7)
    expect(anchor!.pageId).toBe('p1')
    expect(anchor!.at).toBe(1_000_000)
  })

  it('anchorFrom null saat input tidak lengkap', () => {
    expect(pm.anchorFrom(1, [], 0, 200, [], [])).toBeNull()
    expect(pm.anchorFrom(1, ['a'], 0, 0, [0], [10])).toBeNull()
    expect(pm.anchorFrom(1, ['a', 'b'], 0, 200, [0], [10, 10])).toBeNull()
  })

  it('round-trip anchor: anchorFrom → scrollYForAnchor → usableAnchor', () => {
    vi.setSystemTime(1_000_000)
    const anchor = pm.anchorFrom(7, ['p1', 'p2'], 120, 200, [0, 500], [500, 500])
    expect(anchor).not.toBeNull()
    const y = pm.scrollYForAnchor(anchor!.offsetRatio, 0, 500, 200)
    expect(y).toBeCloseTo(120, 5)
    expect(pm.usableAnchor(anchor!)).toEqual(anchor)
  })

  it('scrollYForAnchor clamp offsetRatio', () => {
    const h = 500
    const vp = 200
    expect(pm.scrollYForAnchor(-999, 10, h, vp)).toBe(10 + 0 * h - vp / 2)
    expect(pm.scrollYForAnchor(999, 10, h, vp)).toBe(10 + 1 * h - vp / 2)
  })

  it('usableAnchor menolak entri cacat / kedaluwarsa', () => {
    const at = 1_800_000_000_000
    const base = { chapterId: 1, pageId: 'p', offsetRatio: 0.5, at }
    expect(pm.usableAnchor(base, at + pm.ANCHOR_TTL_MS)).not.toBeNull()
    expect(pm.usableAnchor(base, at + pm.ANCHOR_TTL_MS + 1)).toBeNull()
    expect(pm.usableAnchor(null)).toBeNull()
    expect(pm.usableAnchor(undefined)).toBeNull()
    expect(pm.usableAnchor({ ...base, pageId: '' })).toBeNull()
    expect(pm.usableAnchor({ ...base, pageId: 'p' })).not.toBeNull()
    expect(pm.usableAnchor({ ...base, offsetRatio: NaN })).toBeNull()
    expect(pm.usableAnchor({ ...base, offsetRatio: Number.POSITIVE_INFINITY })).toBeNull()
    expect(pm.usableAnchor({ ...base, chapterId: null as unknown as string | number })).toBeNull()
  })
})
