import { describe, it, expect } from 'vitest'
import type { DlRun } from './downloadStore'
import { runBusy, getRuns, isRunStale, STALE_RUN_MS } from './downloadStore'

function run(jobs: DlRun['jobs'], saved = 0, lastProgressAt = 0): DlRun {
  return { handle: 'komiku:1', seriesTitle: 'Judul', mode: 'pdf', jobs, startedAt: 0, lastProgressAt, saved, saveFailed: 0 }
}

describe('downloadStore', () => {
  it('runBusy true selama ada job wait/run', () => {
    expect(runBusy(run([{ number: '1', state: 'wait' }]))).toBe(true)
    expect(runBusy(run([{ number: '1', state: 'run' }]))).toBe(true)
    expect(
      runBusy(run([{ number: '1', state: 'ok' }, { number: '2', state: 'run' }])),
    ).toBe(true)
  })

  it('runBusy false bila semua job terminal', () => {
    expect(runBusy(run([]))).toBe(false)
    expect(runBusy(run([{ number: '1', state: 'ok' }, { number: '2', state: 'fail', error: 'x' }]))).toBe(false)
  })

  it('getRuns dimulai kosong', () => {
    expect(getRuns()).toEqual([])
  })

  it('isRunStale false bila progres terakhir baru walau run sudah tua', () => {
    const now = STALE_RUN_MS * 10
    expect(isRunStale(run([{ number: '1', state: 'run' }], 0, now - 10_000), now)).toBe(false)
  })

  it('isRunStale true bila 15+ menit tanpa progres dan masih ada job aktif', () => {
    const now = STALE_RUN_MS * 10
    expect(isRunStale(run([{ number: '1', state: 'run' }], 0, now - STALE_RUN_MS), now)).toBe(true)
  })

  it('isRunStale false bila run terminal walau progres terakhir sudah 15+ menit', () => {
    const now = STALE_RUN_MS * 10
    const done = run([{ number: '1', state: 'ok' }, { number: '2', state: 'fail', error: 'x' }], 0, 0)
    expect(isRunStale(done, now)).toBe(false)
  })

  it('isRunStale fallback ke startedAt bila lastProgressAt absen (record lama)', () => {
    const legacy = { startedAt: 0, jobs: [{ number: '1', state: 'run' as const }] }
    expect(isRunStale(legacy, STALE_RUN_MS)).toBe(true)
    expect(isRunStale(legacy, STALE_RUN_MS - 1)).toBe(false)
  })
})
