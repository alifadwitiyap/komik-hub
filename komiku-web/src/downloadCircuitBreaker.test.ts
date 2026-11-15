/**
 * downloadCircuitBreaker.test.ts — circuit breaker 5xx untuk batch unduhan.
 *
 * Node env, pola sama dengan downloadIntegrity.test.ts: `./api` di-mock
 * (unifiedApi.downloadPdf / chapter jadi vi.fn), fetch di-stub global.
 *
 * Determinisme: rejection dari mock diproses FIFO (microtask queue).
 * Dengan rejection instan semua item 503: ketiga worker awal menarik item 0-2
 * sinkron, breaker trip pada kegagalan ke-3, worker yang loop setelahnya
 * melihat shouldStop=true → tidak ada overshoot (downloadPdf dipanggil 3x).
 * Uji overshoot (item ditarik saat failure 1 & 2 tercatat) pakai deferred
 * Promise di skenario (ii). Sisanya ditandai 'Dihentikan: server bermasalah'
 * oleh sweep akhir.
 *
 * Run: npx vitest run src/downloadCircuitBreaker.test.ts
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const mocks = vi.hoisted(() => ({
  downloadPdf: vi.fn(),
  chapter: vi.fn(),
}))

vi.mock('./api', () => ({
  unifiedApi: {
    downloadPdf: mocks.downloadPdf,
    chapter: mocks.chapter,
    downloadFileUrl: (id: string, f: string) => `/api/unified/downloads/${id}/${f}`,
  },
  accountHeaders: () => ({}),
}))

const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]
const pdfOk = (n: string) => ({ id: `h:${n}`, filename: `c${n}.pdf`, title: '', series_title: '', size_bytes: 1 })
const chapter503 = () => Promise.reject(new Error('HTTP 503 Service Unavailable'))
const pdf503 = () => Promise.reject(new Error('HTTP 503 Service Unavailable'))

function bytesResponse(bytes: number[]) {
  const buf = new Uint8Array(bytes).buffer
  return {
    ok: true,
    headers: { get: () => null },
    arrayBuffer: async () => buf.slice(0),
  } as unknown as Response
}

const flush = () => new Promise((r) => setTimeout(r, 0))

let mod: typeof import('./downloadBatch')
let updates: Array<[number, Record<string, unknown>]>
const list = (n: number) =>
  Array.from({ length: n }, (_, i) => ({ handle: 'komiku:test', number: String(i + 1) }))
const onUpdate = (i: number, patch: Record<string, unknown>) => updates.push([i, patch])
const statesFor = (idx: number) =>
  updates.filter(([i]) => i === idx).map(([, p]) => p)
/** patch terminal terakhir untuk indeks. */
const last = (idx: number) => statesFor(idx).at(-1)

beforeEach(async () => {
  updates = []
  mocks.downloadPdf.mockReset()
  mocks.chapter.mockReset()
  vi.stubGlobal('fetch', vi.fn(async () => bytesResponse(PNG)))
  vi.resetModules()
  mod = await import('./downloadBatch')
})
afterEach(() => {
  vi.unstubAllGlobals()
  vi.resetModules()
})

describe('isServerError5xx', () => {
  it('mengenali 500/502/503/504, menolak 404 & error jaringan', () => {
    expect(mod.isServerError5xx(new Error('HTTP 500 Internal Server Error'))).toBe(true)
    expect(mod.isServerError5xx(new Error('HTTP 502 Bad Gateway'))).toBe(true)
    expect(mod.isServerError5xx(new Error('HTTP 503 Service Unavailable'))).toBe(true)
    expect(mod.isServerError5xx(new Error('HTTP 504 Gateway Timeout'))).toBe(true)
    expect(mod.isServerError5xx(new Error('HTTP 404 Not Found'))).toBe(false)
    expect(mod.isServerError5xx(new TypeError('fetch failed'))).toBe(false)
    expect(mod.isServerError5xx('HTTP 503')).toBe(true) // error non-Error pun terbaca
    // pesan partial-failure bisa mengandung angka 500-599 — JANGAN dianggap 5xx
    expect(mod.isServerError5xx(new Error('550 dari 1200 halaman gagal disimpan (1150 tersimpan)'))).toBe(false)
    expect(mod.isServerError5xx(new Error('12 dari 1500 halaman gagal disimpan (488 tersimpan)'))).toBe(false)
    // error send()/get() membawa status asli — teks anyhow server tetap terbaca 5xx
    expect(mod.isServerError5xx(Object.assign(new Error('unduhan PDF melebihi batas 120 detik'), { status: 502 }))).toBe(true)
    expect(mod.isServerError5xx(Object.assign(new Error('create pdf'), { status: 500 }))).toBe(true)
    expect(mod.isServerError5xx(Object.assign(new Error('not found'), { status: 404 }))).toBe(false)
  })
})

describe('circuit breaker — downloadChapters', () => {
  it('(i) trip setelah 3 5xx beruntun: item tersisa ditandai Dihentikan, tanpa network call', async () => {
    mocks.downloadPdf.mockImplementation(pdf503)
    await mod.downloadChapters(list(7), onUpdate)
    // Reject langsung → ketiga worker awal selesai duluan-duluan 503;
    // breaker trip pada kegagalan ketiga. Worker yang loop setelahnya melihat
    // shouldStop=true → TIDAK menarik item baru (tidak ada overshoot).
    expect(mocks.downloadPdf).toHaveBeenCalledTimes(3)
    expect(mocks.downloadPdf.mock.calls.map((c) => c[1])).toEqual(['1', '2', '3'])
    for (const idx of [3, 4, 5, 6]) {
      expect(last(idx)).toEqual({ state: 'fail', error: mod.BREAKER_MESSAGE })
    }
    // item yang memang gagal 5xx berlabel ramah, bukan Dihentikan
    expect(last(0)).toEqual({ state: 'fail', error: 'Server bermasalah' })
  })

  it('(ii) sukses mereset counter: f,f,ok,f,f belum trip, gagal berikutnya yang trip', async () => {
    // Urutan dipaksa lewat deferred agar deterministik:
    // idx0 f, idx1 f, idx2 ok, idx3 f, idx4 f (consec=2, belum trip → idx6/7 tetap diproses),
    // idx5 f (consec=3 → trip → idx8 tidak pernah dipanggil, ditandai Dihentikan).
    const pending = new Map<string, { resolve: (v: unknown) => void; reject: (e: unknown) => void }>()
    mocks.downloadPdf.mockImplementation(
      (_handle: string, number: string) =>
        new Promise((resolve, reject) =>
          pending.set(number, {
            resolve: (v) => { pending.delete(number); resolve(v) },
            reject: (e) => { pending.delete(number); reject(e) },
          }),
        ),
    )
    const run = mod.downloadChapters(list(9), onUpdate)
    await flush()
    expect(pending.size).toBe(3)
    pending.get('1')!.reject(new Error('HTTP 503'))
    await flush() // A menarik idx3
    pending.get('2')!.reject(new Error('HTTP 503'))
    await flush() // B menarik idx4
    pending.get('3')!.resolve(pdfOk('3'))
    await flush() // sukses → reset 0, C menarik idx5
    expect([...pending.keys()].sort()).toEqual(['4', '5', '6'])
    pending.get('4')!.reject(new Error('HTTP 503'))
    await flush() // A menarik idx6
    pending.get('5')!.reject(new Error('HTTP 503'))
    await flush() // consec=2 (belum trip) → B menarik idx7
    expect(mocks.downloadPdf).toHaveBeenCalledTimes(8)
    pending.get('6')!.reject(new Error('HTTP 503'))
    await flush()
    pending.get('7')!.reject(new Error('HTTP 503'))
    await flush()
    pending.get('8')!.reject(new Error('HTTP 503'))
    await flush()
    await run
    // idx6 & idx7 DIPANGGIL (breaker belum trip pada consec 2) — bukti tidak trip prematur
    expect(mocks.downloadPdf.mock.calls.map((c) => c[1])).toEqual(['1', '2', '3', '4', '5', '6', '7', '8'])
    // idx9 (index 8) tidak pernah dipanggil: breaker sudah trip → worker berhenti
    expect(mocks.downloadPdf).not.toHaveBeenCalledWith('komiku:test', '9')
    expect(last(8)).toEqual({ state: 'fail', error: mod.BREAKER_MESSAGE })
  })
})

describe('circuit breaker — cacheChapters', () => {
  it('(iii) trip identik di path cache: chapter 503 beruntun, fetch tidak pernah dipanggil, sisa Dihentikan', async () => {
    mocks.chapter.mockImplementation(chapter503)
    await mod.cacheChapters(list(6), onUpdate)
    expect(mocks.chapter).toHaveBeenCalledTimes(3)
    expect(mocks.chapter.mock.calls.map((c) => c[1])).toEqual(['1', '2', '3'])
    expect(vi.mocked(fetch)).not.toHaveBeenCalled()
    for (const idx of [3, 4, 5]) {
      expect(last(idx)).toEqual({ state: 'fail', error: mod.BREAKER_MESSAGE })
    }
    expect(last(0)).toEqual({ state: 'fail', error: 'Server bermasalah' })
  })

  it('(iii-b) path sukses meneruskan AbortSignal ke fetch (compose 15s)', async () => {
    mocks.chapter.mockResolvedValue({
      title: '', number: '1', source: 'komiku',
      images: ['https://img.komiku.org/p/01.png'],
    })
    const ac = new AbortController()
    await mod.cacheChapters(list(1), onUpdate, ac.signal)
    expect(last(0)).toEqual({ state: 'ok' })
    const fetchMock = vi.mocked(fetch)
    expect(fetchMock).toHaveBeenCalled()
    for (const [, init] of fetchMock.mock.calls) {
      expect((init as RequestInit).cache).toBe('no-cache')
      expect((init as RequestInit).signal).toBeInstanceOf(AbortSignal)
    }
  })
})
