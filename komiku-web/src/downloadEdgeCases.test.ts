/**
 * downloadEdgeCases — cek perilaku helper unduhan untuk edge case:
 * progres (jobTally/progressPct), run "lambat"/"macet" (isRunSlow/isRunStale),
 * indeks di luar daftar (outOfRangeCount), dan retry chapter gagal (retryRun).
 *
 * Node env — tanpa DOM. Store di-mock lewat `vi.doMock('./downloadBatch')`
 * dengan perilaku batch yang bisa diatur per tes.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { outOfRangeCount } from './components/DownloadRangePicker'
import type { DlRun } from './downloadStore'

/**
 * Store TIDAK di-import statis (import statis dimuat sebelum vi.doMock jalan,
 * sehingga startRun akan memakai downloadBatch asli). Semua akses store lewat
 * dynamic import di beforeEach, setelah mock terdaftar.
 */
let store: typeof import('./downloadStore')

beforeEach(async () => {
  vi.resetModules()
  store = await import('./downloadStore')
})

const job = (state: 'wait' | 'run' | 'ok' | 'fail', number = '1') => ({ number, state })
const runOf = (jobs: DlRun['jobs']): DlRun =>
  ({ handle: 'komiku:test', seriesTitle: 'T', mode: 'pdf', jobs, startedAt: 0, saved: 0, saveFailed: 0 }) as DlRun
const ageRun = (jobs: DlRun['jobs'], startedAt: number): DlRun =>
  ({ handle: 'komiku:test', seriesTitle: 'T', mode: 'pdf', jobs, startedAt, saved: 0, saveFailed: 0 }) as DlRun

describe('jobTally', () => {
  it('menghitung keempat state secara terpisah', () => {
    expect(
      store.jobTally(runOf([job('wait', 'a'), job('run', 'b'), job('run', 'c'), job('ok', 'd'), job('fail', 'e')])),
    ).toEqual({ wait: 1, run: 2, ok: 1, fail: 1 })
  })
  it('daftar kosong → semua 0', () => {
    expect(store.jobTally(runOf([]))).toEqual({ wait: 0, run: 0, ok: 0, fail: 0 })
  })
})

describe('progressPct', () => {
  it('3 dari 4 terminal (ok+fail) → 75', () => {
    expect(store.progressPct(runOf([job('ok', 'a'), job('ok', 'b'), job('fail', 'c'), job('wait', 'd')]))).toBe(75)
  })
  it('0 dari 0 → 0 (bukan NaN)', () => {
    expect(store.progressPct(runOf([]))).toBe(0)
  })
  it('semua terminal → 100', () => {
    expect(store.progressPct(runOf([job('ok', 'a'), job('fail', 'b')]))).toBe(100)
  })
})

describe('isRunStale', () => {
  const mixed = [job('ok', 'a'), job('run', 'b')]
  it('batas atas (STALE_RUN_MS - 1) → false', () => {
    expect(store.isRunStale(ageRun(mixed, 0), store.STALE_RUN_MS - 1)).toBe(false)
  })
  it('tepat di STALE_RUN_MS dan masih aktif → true', () => {
    expect(store.isRunStale(ageRun(mixed, 0), store.STALE_RUN_MS)).toBe(true)
  })
  it('tua tapi semua job terminal → false', () => {
    expect(store.isRunStale(ageRun([job('ok', 'a'), job('fail', 'b')], 0), store.STALE_RUN_MS)).toBe(false)
  })
  it('tua tapi jobs kosong → false', () => {
    expect(store.isRunStale(ageRun([], 0), store.STALE_RUN_MS)).toBe(false)
  })
})

describe('isRunSlow', () => {
  it('di bawah SLOW_RUN_MS → false', () => {
    expect(store.isRunSlow(ageRun([job('wait', 'a'), job('wait', 'b')], 0), store.SLOW_RUN_MS - 1)).toBe(false)
  })
  it('tepat di SLOW_RUN_MS, belum ada yang selesai → true', () => {
    expect(store.isRunSlow(ageRun([job('wait', 'a'), job('run', 'b')], 0), store.SLOW_RUN_MS)).toBe(true)
  })
  it('ada yang selesai → false', () => {
    expect(store.isRunSlow(ageRun([job('ok', 'a'), job('wait', 'b')], 0), store.SLOW_RUN_MS)).toBe(false)
  })
})

describe('outOfRangeCount', () => {
  it('semua indeks valid → 0', () => {
    expect(outOfRangeCount([0, 3, 4], 5)).toBe(0)
  })
  it('satu indeks di atas daftar → 1', () => {
    expect(outOfRangeCount([0, 5], 5)).toBe(1)
  })
  it('indeks negatif ikut dihitung', () => {
    expect(outOfRangeCount([-1, 2], 5)).toBe(1)
  })
  it('daftar kosong → semua indeks dihitung di luar jangkauan', () => {
    expect(outOfRangeCount([0, 1, 2], 0)).toBe(3)
  })
  it('daftar kosong dan tanpa indeks → 0', () => {
    expect(outOfRangeCount([], 0)).toBe(0)
  })
})

// --- retryRun (butuh store sungguhan dengan downloadBatch yang di-mock) ---

// Perilaku downloadChapters bisa diatur per tes; default: 2 job, satu ok satu fail.
let chaptersMock: (
  list: unknown,
  onUpdate: (i: number, p: { state: string; error?: string }) => void,
) => Promise<void> = async (_list, onUpdate) => {
  onUpdate(0, { state: 'ok' })
  onUpdate(1, { state: 'ok' })
}

vi.doMock('./downloadBatch', () => ({
  downloadChapters: (
    list: unknown,
    onUpdate: (i: number, p: { state: string; error?: string }) => void,
  ) => chaptersMock(list, onUpdate),
  cacheChapters: () => new Promise<void>(() => {}), // tidak pernah selesai
  saveGeneratedPdf: async () => false,
}))

const flush = () => new Promise((r) => setTimeout(r, 0))

const mixedOutcome: typeof chaptersMock = async (_list, onUpdate) => {
  onUpdate(0, { state: 'ok' })
  onUpdate(1, { state: 'fail', error: 'Server bermasalah' })
}
const allOk: typeof chaptersMock = async (_list, onUpdate) => {
  onUpdate(0, { state: 'ok' })
  onUpdate(1, { state: 'ok' })
}
const cancelled: typeof chaptersMock = async (_list, onUpdate) => {
  onUpdate(0, { state: 'fail', error: 'Dibatalkan' })
  onUpdate(1, { state: 'ok' })
}

describe('retryRun', () => {
  it('run pdf selesai dengan job gagal → retry hanya menyisakan chapter gagal', async () => {
    chaptersMock = mixedOutcome
    const handle = 'komiku:retry-mixed'
    store.startRun(handle, 'Judul', ['1', '2'])
    await flush()
    await flush()

    store.retryRun(handle)
    await flush()
    await flush()

    const run = store.getRuns().find((r) => r.handle === handle)
    // Run baru (retry) hanya berisi chapter '2' — yang gagal.
    expect(run?.jobs.map((j) => j.number)).toEqual(['2'])
  })

  it('run masih busy → retry no-op', async () => {
    chaptersMock = () => new Promise<void>(() => {}) // tidak pernah selesai
    const handle = 'komiku:retry-busy'
    store.startRun(handle, 'Judul', ['1', '2'])
    await flush()

    store.retryRun(handle)
    const run = store.getRuns().find((r) => r.handle === handle)
    // Tidak ada run pengganti; job tetap 'wait'.
    expect(run?.jobs.map((j) => j.state)).toEqual(['wait', 'wait'])
  })

  it('run semua ok → tidak ada retry', async () => {
    chaptersMock = allOk
    const handle = 'komiku:retry-allock'
    store.startRun(handle, 'Judul', ['1', '2'])
    await flush()
    await flush()

    store.retryRun(handle)
    const run = store.getRuns().find((r) => r.handle === handle)
    expect(run?.jobs.map((j) => j.state)).toEqual(['ok', 'ok'])
  })

  it('job gagal dengan error "Dibatalkan" tidak di-retry', async () => {
    chaptersMock = cancelled
    const handle = 'komiku:retry-cancelled'
    store.startRun(handle, 'Judul', ['1', '2'])
    await flush()
    await flush()

    store.retryRun(handle)
    const run = store.getRuns().find((r) => r.handle === handle)
    // Tidak dibuat run baru: masih dua job asli, job pertama tetap 'Dibatalkan'.
    expect(run?.jobs.length).toBe(2)
    expect(run?.jobs[0]?.error).toBe('Dibatalkan')
  })
})
