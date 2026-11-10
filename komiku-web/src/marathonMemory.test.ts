import { describe, it, expect } from 'vitest'
import type { MarathonPosition } from './marathonMemory'
import {
  handleOf,
  marathonStoreKey,
  usablePosition,
  findPosition,
  upsertPosition,
  removePosition,
  seriesKeyOf,
  latestForHandle,
  removeHandle,
  parsePositions,
  serializePositions,
  MARATHON_TTL_MS,
} from './marathonMemory'

const NOW = 1_800_000_000_000

function pos(over: Partial<MarathonPosition> = {}): MarathonPosition {
  return {
    chapterKey: 'komiku:1284:121',
    activeKey: 'komiku:1284:121',
    pageId: 'https://a/1.jpg',
    offsetRatio: 0.5,
    blocks: 3,
    chapterIdx: 1,
    at: NOW,
    ...over,
  }
}

describe('handleOf', () => {
  it('mengekstrak handle dari chapterKey', () => {
    expect(handleOf('komiku:1284:121')).toBe('komiku:1284')
    expect(handleOf('komiku:1284:121:99')).toBe('komiku:1284:121')
  })
  it('null tanpa tanda titik dua / di posisi 0', () => {
    expect(handleOf('6427')).toBeNull()
    expect(handleOf(':121')).toBeNull()
    expect(handleOf('')).toBeNull()
  })
})

describe('marathonStoreKey', () => {
  it('menambahkan username bila ada', () => {
    expect(marathonStoreKey('budi')).toBe('komiku.web.marathon.v1:budi')
    expect(marathonStoreKey(null)).toBe('komiku.web.marathon.v1')
  })
})

describe('usablePosition', () => {
  it('validasi: null/entri cacat', () => {
    expect(usablePosition(null)).toBeNull()
    expect(usablePosition(undefined)).toBeNull()
    expect(usablePosition(pos({ chapterKey: '' }))).toBeNull()
    expect(usablePosition(pos({ pageId: '' }))).toBeNull()
    expect(usablePosition(pos({ offsetRatio: NaN }))).toBeNull()
    expect(usablePosition(pos({ at: Number.POSITIVE_INFINITY }))).toBeNull()
  })
  it('TTL 90 hari', () => {
    expect(usablePosition(pos({ at: NOW }), NOW + MARATHON_TTL_MS)).not.toBeNull()
    expect(usablePosition(pos({ at: NOW }), NOW + MARATHON_TTL_MS + 1)).toBeNull()
  })
  it('menormalkan offsetRatio ke [0,1]', () => {
    expect(usablePosition(pos({ offsetRatio: -2 }))!.offsetRatio).toBe(0)
    expect(usablePosition(pos({ offsetRatio: 3 }))!.offsetRatio).toBe(1)
  })
  it('clampInt: blocks/chapterIdx diperbaiki', () => {
    expect(usablePosition(pos({ blocks: 0 }))!.blocks).toBe(1)
    expect(usablePosition(pos({ blocks: 500 }))!.blocks).toBe(200)
    expect(usablePosition(pos({ chapterIdx: -5 }))!.chapterIdx).toBe(0)
    expect(usablePosition(pos({ chapterIdx: NaN }))!.chapterIdx).toBe(0)
    expect(usablePosition(pos({ chapterIdx: 999 }))!.chapterIdx).toBe(199)
  })
  it('seriesKey diisi dari handle bila tidak ada', () => {
    expect(usablePosition(pos({ seriesKey: undefined }))!.seriesKey).toBe('komiku:1284')
    expect(usablePosition(pos({ seriesKey: 'komiku:999' }))!.seriesKey).toBe('komiku:999')
  })
  it('activeKey jatuh ke chapterKey bila kosong', () => {
    expect(usablePosition(pos({ activeKey: '' }))!.activeKey).toBe('komiku:1284:121')
  })
})

describe('findPosition', () => {
  it('mengambil entri terbaru per chapterKey', () => {
    const e = [
      pos({ chapterKey: 'k:1:1', at: NOW - 200 }),
      pos({ chapterKey: 'k:2:2', at: NOW - 100 }),
      pos({ chapterKey: 'k:1:1', at: NOW }),
    ]
    const found = findPosition(e, 'k:1:1')
    expect(found).not.toBeNull()
    expect(found!.at).toBe(NOW)
  })
  it('null bila tidak ada', () => {
    expect(findPosition([pos({ at: 0 })], 'k:missing:9')).toBeNull()
  })
})

describe('upsertPosition', () => {
  it('mengganti chapterKey sama, urut terbaru dulu', () => {
    const out = upsertPosition([pos({ at: 500 })], pos({ at: 900 }))
    expect(out).toHaveLength(1)
    expect(out[0].at).toBe(900)
    const out2 = upsertPosition([], pos({ at: 1 }))
    expect(out2).toHaveLength(1)
  })
  it('mengusir entri tertua di luar MAX=24', () => {
    let entries: MarathonPosition[] = []
    for (let i = 0; i < 25; i++) {
      entries = upsertPosition(entries, pos({ chapterKey: `k:${i}:${i}`, at: i }))
    }
    expect(entries).toHaveLength(24)
    expect(entries.some((e) => e.at === 0)).toBe(false)
    expect(entries[0].at).toBe(24)
  })
})

describe('removePosition', () => {
  it('menghapus semua posisi sesi tsb', () => {
    const out = removePosition([pos(), pos({ chapterKey: 'k:2:2' })], 'komiku:1284:121')
    expect(out).toHaveLength(1)
    expect(out[0].chapterKey).toBe('k:2:2')
  })
})

describe('seriesKeyOf', () => {
  it('seriesKey eksplisit menang', () => {
    expect(seriesKeyOf(pos({ seriesKey: 'komiku:999' }))).toBe('komiku:999')
    expect(seriesKeyOf(pos({ seriesKey: undefined }))).toBe('komiku:1284')
  })
})

describe('latestForHandle', () => {
  it('mengambil terbaru milik series', () => {
    const e = [
      pos({ chapterKey: 'k:1:1', at: NOW - 200 }),
      pos({ chapterKey: 'k:2:2', at: NOW - 100 }),
      pos({ chapterKey: 'k:1:9', at: NOW }),
    ]
    const found = latestForHandle(e, 'k:1')
    expect(found).not.toBeNull()
    expect(found!.at).toBe(NOW)
  })
  it('null saat seriesKey falsy / tidak kecocokan', () => {
    expect(latestForHandle([pos()], null)).toBeNull()
    expect(latestForHandle([pos()], 'k:zzz')).toBeNull()
  })
})

describe('removeHandle', () => {
  it('menghapus semua sesi series', () => {
    const out = removeHandle([pos(), pos({ chapterKey: 'k:2:2' })], 'komiku:1284')
    expect(out).toHaveLength(1)
    expect(out[0].chapterKey).toBe('k:2:2')
  })
  it('seriesKey falsy → salinan tak berubah', () => {
    const src = [pos()]
    const out = removeHandle(src, undefined)
    expect(out).toEqual(src)
  })
})

describe('parsePositions', () => {
  it('null/string kosong → []', () => {
    expect(parsePositions(null)).toEqual([])
    expect(parsePositions('')).toEqual([])
  })
  it('JSON rusak / bukan array → []', () => {
    expect(parsePositions('{oops')).toEqual([])
    expect(parsePositions('"bukan-array"')).toEqual([])
    expect(parsePositions('{"a":1}')).toEqual([])
  })
  it('memfilter entri cacat, urut terbaru dulu, potong 24', () => {
    const raw = JSON.stringify([
      pos({ at: NOW - 30 }),
      { ...pos({ at: NOW - 20 }), pageId: '' },
      pos({ at: NOW }),
      pos({ at: NOW - 5 }),
    ])
    const out = parsePositions(raw)
    expect(out).toHaveLength(3)
    expect(out.map((e) => e.at)).toEqual([NOW, NOW - 5, NOW - 30])
  })
  it('menormalkan lewat usablePosition (seriesKey diisi)', () => {
    const out = parsePositions(JSON.stringify([pos({ seriesKey: undefined })]))
    expect(out[0].seriesKey).toBe('komiku:1284')
  })
})

describe('serializePositions', () => {
  it('round-trip JSON', () => {
    const entries = [
      pos({ seriesKey: 'komiku:1284' }),
      pos({ chapterKey: 'k:2:2', at: NOW + 1, seriesKey: 'k:2' }),
    ]
    const sorted = [...entries].sort((a, b) => b.at - a.at)
    expect(parsePositions(serializePositions(entries))).toEqual(sorted)
  })
  it('memotong ke 24', () => {
    const many = Array.from({ length: 30 }, (_, i) => pos({ chapterKey: `k:${i}:${i}`, at: i }))
    expect(JSON.parse(serializePositions(many))).toHaveLength(24)
  })
})
