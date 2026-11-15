/**
 * downloadIntegrity.test.ts — uji integritas & validasi fitur unduhan.
 * Menjalankan KODE SUNGGUHAN (bukan snapshot): byte-cek gambar, range clamp,
 * ledger tahan tab-tutup (downloadHistory), subscribe/unsubscribe strong-Set, dan
 * penanda ledger saat job transisi ke 'ok'.
 *
 * Run: npx vitest run src/downloadIntegrity.test.ts
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('./api', () => ({
  unifiedApi: {
    downloadPdf: async (handle: string, number: string) => ({
      id: `${handle}:${number}`,
      filename: `c${number}.pdf`,
      title: '',
      series_title: '',
      size_bytes: 1,
    }),
    chapter: async () => ({ title: '', number: '1', source: 'komiku', images: [] }),
  },
  accountHeaders: () => ({}),
}))

const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4, 5, 6]
const JPEG = [0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4, 5, 6, 7, 8, 9]
const GARBAGE = [0x3c, 0x68, 0x74, 0x6d, 0x6c, 0x3e, 1, 2, 3, 4, 5, 6, 7] // "<html>"

function bytesResponse(bytes: number[], opts: { ok?: boolean } = {}) {
  const buf = new Uint8Array(bytes).buffer
  return {
    ok: opts.ok ?? true,
    headers: { get: () => null },
    arrayBuffer: async () => buf.slice(0),
    text: async () => new TextDecoder().decode(buf),
  } as unknown as Response
}

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn())
})
afterEach(() => {
  vi.unstubAllGlobals()
  vi.resetModules()
})

describe('integrity — byte-level image validation (chapterOffline)', () => {
  it('isImageBytes: 0-byte body rejected', async () => {
    const { isImageBytes } = await import('./chapterOffline')
    expect(isImageBytes(new ArrayBuffer(0))).toBe(false)
    expect(isImageBytes(new ArrayBuffer(10))).toBe(false) // truncated < 12 bytes
  })
  it('isImageBytes: real magic bytes accepted (png/jpeg), HTML rejected', async () => {
    const { isImageBytes } = await import('./chapterOffline')
    expect(isImageBytes(new Uint8Array(PNG).buffer)).toBe(true)
    expect(isImageBytes(new Uint8Array(JPEG).buffer)).toBe(true)
    expect(isImageBytes(new Uint8Array(GARBAGE).buffer)).toBe(false)
  })
  it('downloadChapterImages: 0-byte 200 counts as failure, valid PNG counts as ok', async () => {
    const fetchMock = vi.mocked(fetch)
    fetchMock.mockImplementation(async () => bytesResponse([]))
    const { downloadChapterImages } = await import('./chapterOffline')
    const zero = await downloadChapterImages(['https://img.komiku.org/p/01.png'])
    expect(zero).toEqual({ ok: 0, fail: 1 })
    fetchMock.mockImplementation(async () => bytesResponse(PNG))
    const good = await downloadChapterImages(['https://img.komiku.org/p/01.png'])
    expect(good).toEqual({ ok: 1, fail: 0 })
  })
})

describe('validation — rangeSlice clamps to list length (DownloadRangePicker)', () => {
  it('no-length call unchanged: 0→99 on empty context = 30 pertama', async () => {
    const { rangeSlice, rangeTap } = await import('./components/DownloadRangePicker')
    const s = rangeTap(rangeTap({ start: null, end: null }, 0), 99)
    expect(rangeSlice(s)).toEqual({ from: 0, to: 29, raw: 100, count: 30, clamped: true })
  })
  it('length-aware: seluruh range di luar daftar → null; sebagian → clamp', async () => {
    const { rangeSlice, rangeTap } = await import('./components/DownloadRangePicker')
    const stale = rangeTap(rangeTap({ start: null, end: null }, 10), 12)
    expect(rangeSlice(stale, 5)).toBeNull() // 10..12 di daftar 5 item → seluruhnya tidak ada
    const huge = rangeTap(rangeTap({ start: null, end: null }, 0), 99)
    expect(rangeSlice(huge, 5)).toEqual({ from: 0, to: 4, raw: 100, count: 5, clamped: true })
    const partial = rangeTap(rangeTap({ start: null, end: null }, 2), 9)
    expect(rangeSlice(partial, 5)).toEqual({ from: 2, to: 4, raw: 8, count: 3, clamped: true })
  })
})

describe('integrity — ledger tahan tab ditutup (downloadHistory)', () => {
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
  it('markDownloadDone/doneNumbers roundtrip + idempotent', async () => {
    const s = memStorage()
    vi.stubGlobal('localStorage', s)
    const { doneNumbers, markDownloadDone } = await import('./downloadHistory')
    expect(doneNumbers('komiku:1')).toEqual([])
    markDownloadDone('komiku:1', ['1', '2', '2'])
    markDownloadDone('komiku:1', ['3'])
    expect(doneNumbers('komiku:1').sort()).toEqual(['1', '2', '3'])
    vi.unstubAllGlobals()
  })
  it('ledger JSON rusak → [] (tidak pernah crash), write tetap jalan', async () => {
    const s = memStorage()
    s.setItem('komik:download-history', '{{{bukan json')
    vi.stubGlobal('localStorage', s)
    const { doneNumbers, markDownloadDone } = await import('./downloadHistory')
    expect(doneNumbers('komiku:1')).toEqual([])
    expect(() => markDownloadDone('komiku:1', ['7'])).not.toThrow()
    expect(doneNumbers('komiku:1')).toEqual(['7'])
    vi.unstubAllGlobals()
  })
  it('ledger korup struktural (nilai bukan string[]) → entri dibuang, tidak crash', async () => {
    const s = memStorage()
    s.setItem('komik:download-history', '{"komiku:1":["3"],"komiku:5685":42,"komiku:7":[1,2],"komiku:9":"bukan-array"}')
    vi.stubGlobal('localStorage', s)
    const { doneNumbers, markDownloadDone } = await import('./downloadHistory')
    expect(doneNumbers('komiku:5685')).toEqual([])
    expect(doneNumbers('komiku:1')).toEqual(['3'])
    expect(doneNumbers('komiku:7')).toEqual([])
    expect(doneNumbers('komiku:9')).toEqual([])
    expect(() => markDownloadDone('komiku:5685', ['42'])).not.toThrow()
    expect(doneNumbers('komiku:5685')).toEqual(['42'])
    vi.unstubAllGlobals()
  })
  it('tanpa localStorage (node) → no-op, tidak throw', async () => {
    vi.stubGlobal('localStorage', undefined)
    const { doneNumbers, markDownloadDone } = await import('./downloadHistory')
    expect(doneNumbers('h')).toEqual([])
    expect(() => markDownloadDone('h', ['1'])).not.toThrow()
    vi.unstubAllGlobals()
  })
})

describe('leak — subscribeRuns (downloadStore)', () => {
  it('unsubscribe menghentikan delivery; emit tanpa subscriber tidak crash', async () => {
    const { startRun, subscribeRuns, cancelRun, getRuns } = await import('./downloadStore')
    const cb = vi.fn()
    const unsub = subscribeRuns(cb)
    startRun('leak-a', 'T', ['1'])
    await new Promise((r) => setTimeout(r, 0))
    unsub()
    const calls = cb.mock.calls.length
    startRun('leak-b', 'T', ['1'])
    await new Promise((r) => setTimeout(r, 0))
    expect(cb.mock.calls.length).toBe(calls)
    for (const r of getRuns()) cancelRun(r.handle)
  })
})

describe('integrity — job transisi ke ok menulis ledger (downloadStore→downloadHistory)', () => {
  it('startRun resolves → chapter masuk ledger untuk handle itu', async () => {
    const s = (() => {
      const m = new Map<string, string>()
      return {
        getItem: (k: string) => m.get(k) ?? null,
        setItem: (k: string, v: string) => void m.set(k, v),
      }
    })()
    vi.stubGlobal('localStorage', s)
    const { startRun, getRuns } = await import('./downloadStore')
    startRun('ledger-h', 'T', ['9'])
    await new Promise((r) => setTimeout(r, 5))
    await new Promise((r) => setTimeout(r, 0))
    const { doneNumbers } = await import('./downloadHistory')
    expect(doneNumbers('ledger-h')).toContain('9')
    expect(getRuns().find((r) => r.handle === 'ledger-h')?.jobs[0]?.state).toBe('ok')
    vi.unstubAllGlobals()
  })
})
