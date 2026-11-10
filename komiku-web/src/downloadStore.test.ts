import { describe, it, expect } from 'vitest'
import type { DlRun } from './downloadStore'
import { runBusy, getRuns } from './downloadStore'

function run(jobs: DlRun['jobs'], saved = 0): DlRun {
  return { handle: 'komiku:1', seriesTitle: 'Judul', mode: 'pdf', jobs, startedAt: 0, saved }
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
})
