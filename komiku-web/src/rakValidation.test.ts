/**
 * rakValidation.test.ts — rakStore load() memvalidasi ENTRI (bukan hanya top-level)
 * dan groupBySeries menyaring baris unduhan rusak.
 *
 * Run: npx vitest run src/rakValidation.test.ts
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { groupBySeries } from './pages/Rak'
import type { DownloadItem } from './types'

function memStorage() {
  const m = new Map<string, string>()
  return {
    m,
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, v),
    removeItem: (k: string) => void m.delete(k),
    clear: () => m.clear(),
  }
}

const FAV = (over: Record<string, unknown> = {}) => ({
  title_key: 'tk:1',
  title: 'Judul',
  cover_url: null,
  handle: 'komiku:123',
  source: 'komiku',
  loved_at: 1000,
  ...over,
})

const HIST = (over: Record<string, unknown> = {}) => ({
  title_key: 'tk:1',
  title: 'Judul',
  cover_url: null,
  handle: 'komiku:123',
  source: 'komiku',
  last_chapter: '12',
  updated_at: 1000,
  ...over,
})

function seed(payload: unknown) {
  const s = memStorage()
  s.setItem('komik-rak-v1', typeof payload === 'string' ? payload : JSON.stringify(payload))
  vi.stubGlobal('localStorage', s)
}

beforeEach(() => {
  vi.resetModules()
})
afterEach(() => {
  vi.unstubAllGlobals()
})

describe('rakStore load — validasi entri favorit/riwayat', () => {
  it('drop entri null & sampah, tidak throw', async () => {
    seed({
      favorites: {
        good: FAV({ title_key: 'tk:good', loved_at: 5000 }),
        nul: null,
        num: 42,
        str: 'bukan-objek',
        missTitle: FAV({ title: '' }),
      },
      history: {
        good: HIST({ title_key: 'tk:hgood', updated_at: 7000 }),
        nul: null,
        arr: [1, 2, 3],
      },
    })
    const rak = await import('./rakStore')
    expect(rak.listFavorites().map((e) => e.title_key)).toEqual(['tk:good'])
    expect(rak.listHistory().map((e) => e.title_key)).toEqual(['tk:hgood'])
  })

  it('listHistory/listFavorites mengembalikan entri valid, urut desc', async () => {
    seed({
      favorites: {
        a: FAV({ title_key: 'a', loved_at: 100 }),
        b: FAV({ title_key: 'b', loved_at: 900 }),
        c: FAV({ title_key: 'c', loved_at: 500 }),
      },
      history: {
        a: HIST({ title_key: 'a', updated_at: 100 }),
        b: HIST({ title_key: 'b', updated_at: 900 }),
        c: HIST({ title_key: 'c', updated_at: 500 }),
      },
    })
    const rak = await import('./rakStore')
    expect(rak.listFavorites().map((e) => e.loved_at)).toEqual([900, 500, 100])
    expect(rak.listHistory().map((e) => e.updated_at)).toEqual([900, 500, 100])
  })

  it('handle tanpa ":" atau loved_at/updated_at non-finite → drop', async () => {
    // 1e999 lolos JSON.parse sebagai Infinity — mensimulasikan payload lama/rusak
    seed(
      '{"favorites":{' +
        '"badHandle":' + JSON.stringify(FAV({ title_key: 'badHandle', handle: 'tanpa titik dua' })) + ',' +
        '"infLoved":' + JSON.stringify(FAV({ title_key: 'infLoved' })).replace('"loved_at":1000', '"loved_at":1e999') + ',' +
        '"ok":' + JSON.stringify(FAV({ title_key: 'ok', loved_at: 1234 })) +
        '},"history":{' +
        '"badHandle":' + JSON.stringify(HIST({ title_key: 'badHandle', handle: 'noColon' })) + ',' +
        '"infUpdated":' + JSON.stringify(HIST({ title_key: 'infUpdated' })).replace('"updated_at":1000', '"updated_at":1e999') + ',' +
        '"ok":' + JSON.stringify(HIST({ title_key: 'ok', updated_at: 4321 })) +
        '}}',
    )
    const rak = await import('./rakStore')
    expect(rak.listFavorites().map((e) => e.title_key)).toEqual(['ok'])
    expect(rak.listHistory().map((e) => e.title_key)).toEqual(['ok'])
  })

  it('last_chapter number dikoersi ke string; non-string non-number → drop', async () => {
    seed({
      history: {
        num: HIST({ title_key: 'num', last_chapter: 7, updated_at: 100 }),
        ok: HIST({ title_key: 'ok', last_chapter: '8', updated_at: 200 }),
        bad: HIST({ title_key: 'bad', last_chapter: null, updated_at: 300 }),
        obj: HIST({ title_key: 'obj', last_chapter: { n: 1 }, updated_at: 400 }),
      },
    })
    const rak = await import('./rakStore')
    const list = rak.listHistory()
    expect(list.map((e) => e.title_key)).toEqual(['ok', 'num'])
    expect(list.find((e) => e.title_key === 'num')?.last_chapter).toBe('7')
  })

  it('top-level rusak (favorites array / parsed null) → kosong, tidak throw', async () => {
    seed('{"favorites":[1,2],"history":"nope"}')
    let rak = await import('./rakStore')
    expect(rak.listFavorites()).toEqual([])
    expect(rak.listHistory()).toEqual([])
    vi.unstubAllGlobals()
    vi.resetModules()
    seed('null')
    rak = await import('./rakStore')
    expect(rak.listFavorites()).toEqual([])
    expect(rak.listHistory()).toEqual([])
  })

  it('JSON tidak valid → kosong, tidak throw', async () => {
    seed('{{{bukan json')
    const rak = await import('./rakStore')
    expect(rak.listFavorites()).toEqual([])
    expect(rak.listHistory()).toEqual([])
  })
})

const DL = (over: Record<string, unknown> = {}): DownloadItem =>
  ({
    id: 'id1',
    handle: 'komiku:1',
    number: '1',
    title: 'ch 1',
    series_title: 'Series A',
    filename: 'c1.pdf',
    size_bytes: 100,
    downloaded_at: 1000,
    ...over,
  }) as DownloadItem

describe('groupBySeries — filter baris rusak', () => {
  it('campuran valid/invalid: hanya valid yang masuk grup', () => {
    const items = [
      DL({ handle: 'komiku:1', series_title: 'Series A', size_bytes: 100, downloaded_at: 100 }),
      DL({ handle: 'tanpa-titik-dua', series_title: 'Bad', size_bytes: 100 }),
      DL({ handle: 'komiku:2', series_title: 123 as unknown as string, size_bytes: 100 }),
      DL({ handle: 'komiku:3', series_title: 'No size', size_bytes: NaN }),
      null as unknown as DownloadItem,
      DL({ handle: 'komiku:1', series_title: 'Series A', size_bytes: 50, downloaded_at: 200 }),
    ]
    const groups = groupBySeries(items)
    expect(groups).toHaveLength(1)
    expect(groups[0].handle).toBe('komiku:1')
    expect(groups[0].items).toHaveLength(2)
    expect(groups[0].bytes).toBe(150)
  })

  it('size_bytes non-numeric dikoersi via Number(); yang gagal di-skip', () => {
    const items = [
      DL({ handle: 'komiku:1', size_bytes: '250' as unknown as number }),
      DL({ handle: 'komiku:2', series_title: 'BadSize', size_bytes: 'bukan-angka' as unknown as number }),
    ]
    const groups = groupBySeries(items)
    expect(groups.map((g) => g.handle)).toEqual(['komiku:1'])
    expect(groups[0].bytes).toBe(250)
  })

  it('semua invalid → []', () => {
    const items = [
      DL({ handle: 'noColon' }),
      DL({ size_bytes: NaN }),
      null as unknown as DownloadItem,
      42 as unknown as DownloadItem,
    ]
    expect(groupBySeries(items)).toEqual([])
  })
})
