import { readFileSync } from 'node:fs'
import { join } from 'node:path'
// Adversarial probes of komik-hub's client-side download state machine.
// Each test uses its OWN handle because `recs` is a module singleton with no
// reset API (downloadStore exports no clearRuns) — see S2c/S4d.
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('./api', () => {
  return {
    unifiedApi: {
      // Resolves after 10ms so in-flight races are observable. The signal is
      // deliberately ignored: the real unifiedApi.downloadPdf only forwards it
      // to fetch(), so the batch layer's own abort checks are what stop work.
      downloadPdf: (handle: string, number: string, _signal?: AbortSignal) =>
        new Promise((resolve) => {
          setTimeout(
            () =>
              resolve({
                id: `${handle}:${number}`,
                filename: `c${number}.pdf`,
                title: '',
                series_title: '',
                size_bytes: 1,
              }),
            10,
          )
        }),
    },
    accountHeaders: () => ({}),
  }
})

vi.mock('./chapterOffline', () => ({
  downloadChapterImages: () => Promise.resolve({ ok: 1, fail: 0 }),
}))

import { startRun, cancelRun, getRuns, runBusy, subscribeRuns } from './downloadStore'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const recOf = (h: string) => getRuns().find((r) => r.handle === h)
const nums = (h: string) => recOf(h)?.jobs.map((j) => j.number)
const states = (h: string) => recOf(h)?.jobs.map((j) => j.state)
const okCount = (h: string) => recOf(h)?.jobs.filter((j) => j.state === 'ok').length ?? -1

async function until(pred: () => boolean, maxMs = 2000): Promise<boolean> {
  const t0 = Date.now()
  while (!pred()) {
    if (Date.now() - t0 > maxMs) return false
    await sleep(5)
  }
  return true
}

beforeEach(async () => {
  for (const r of getRuns()) cancelRun(r.handle)
  await sleep(25)
})

// ---------------------------------------------------------------------------
describe('S1 — rapid double-tap on download button (race condition)', () => {
  it('S1a: 2nd startRun in the same tick emits nothing — second batch silently LOST', async () => {
    const h = 's1a'
    startRun(h, 'T', ['1', '2', '3'])
    const seen: string[] = []
    const unsub = subscribeRuns((runs) => {
      const r = runs.find((x) => x.handle === h)
      if (r) seen.push(r.jobs.map((j) => j.state).join(','))
    })

    const r2 = startRun(h, 'T', ['4', '5', '6']) // double-tap, same tick
    unsub()

    expect(r2).toBeUndefined() // void return: caller cannot detect rejection
    expect(seen).toEqual([]) // dedupe path returns BEFORE emit() — tap dropped in silence
    expect(getRuns().filter((r) => r.handle === h)).toHaveLength(1)
    expect(nums(h)).toEqual(['1', '2', '3']) // FIRST batch kept, second dropped
    await until(() => !runBusy(recOf(h)!))
  })

  it('S1b: after the first run COMPLETES a new startRun for the same handle succeeds', async () => {
    const h = 's1b'
    startRun(h, 'T', ['1'])
    expect(await until(() => !runBusy(recOf(h)!))).toBe(true)

    startRun(h, 'T', ['2'])
    expect(nums(h)).toEqual(['2'])
    expect(getRuns().filter((r) => r.handle === h)).toHaveLength(1)
    await until(() => !runBusy(recOf(h)!))
  })

  it('S1c: different handles run in parallel (dedupe is per-handle, not global)', async () => {
    startRun('s1c-a', 'A', ['1'])
    startRun('s1c-b', 'B', ['1'])
    expect(getRuns().filter((r) => r.handle.startsWith('s1c-'))).toHaveLength(2)
    await until(() => !runBusy(recOf('s1c-a')!) && !runBusy(recOf('s1c-b')!))
  })
})

// ---------------------------------------------------------------------------
describe('S2 — navigate away mid-download, then return (store persistence)', () => {
  it('S2a: unmount does not abort — rec keeps progressing in the module singleton', async () => {
    const h = 's2a'
    startRun(h, 'T', ['1', '2', '3', '4'])
    const rec = recOf(h)!
    expect(runBusy(rec)).toBe(true)

    // "navigate away" == component unmount. useDownloadRun registers no cleanup
    // that aborts, and nothing here calls cancelRun.
    await sleep(30)
    const mid = okCount(h)
    const done = await until(() => !runBusy(recOf(h)!))

    expect(done).toBe(true)
    expect(recOf(h)!.startedAt).toBe(rec.startedAt) // SAME run (module singleton), not a remount
    expect(okCount(h)).toBe(4)
    expect(okCount(h)).toBeGreaterThanOrEqual(mid)
  })

  it('S2b: a late subscriber (returning to the page) still receives live updates', async () => {
    const h = 's2b'
    startRun(h, 'T', ['1', '2'])
    const seen: number[] = []
    const unsub = subscribeRuns((runs) => {
      if (runs.some((r) => r.handle === h)) seen.push(okCount(h))
    })
    await until(() => !runBusy(recOf(h)!))
    unsub()
    expect(seen.length).toBeGreaterThan(0)
    expect(okCount(h)).toBe(2)
  })

  it('S2c: no persistence layer — a full reload loses all run history', () => {
    const src = readFileSync(join(process.cwd(), 'src', 'downloadStore.ts'), 'utf8')
    expect(src).not.toMatch(/localStorage\s*[.(]|sessionStorage\s*[.(]|indexedDB\s*[.(]/)
    expect(src).toMatch(/const recs: RunRec\[\] = \[\]/) // plain module array
  })
})

// ---------------------------------------------------------------------------
describe('S3 — start a new download while one is running (store replacement)', () => {
  it('S3a: same handle -> new run REJECTED, running rec untouched (no replace)', async () => {
    const h = 's3a'
    startRun(h, 'T', ['1', '2', '3'])
    const first = recOf(h)!

    startRun(h, 'T', ['9'])

    expect(recOf(h)!.startedAt).toBe(first.startedAt) // same run object identity (never spliced out)
    expect(recOf(h)!.startedAt).toBe(first.startedAt)
    expect(nums(h)).toEqual(['1', '2', '3'])
    await until(() => !runBusy(recOf(h)!))
  })

  it('S3b: replacement (findIndex+splice) only happens once the old rec is NOT busy', async () => {
    const h = 's3b'
    startRun(h, 'T', ['1'])
    expect(await until(() => !runBusy(recOf(h)!))).toBe(true)
    const first = recOf(h)!

    startRun(h, 'T', ['7', '8'])

    expect(recOf(h)).not.toBe(first) // replaced by findIndex+splice
    expect(nums(h)).toEqual(['7', '8'])
    expect(getRuns().filter((r) => r.handle === h)).toHaveLength(1)
    await until(() => !runBusy(recOf(h)!))
  })
})

// ---------------------------------------------------------------------------
describe('S4 — cancel a batch then immediately start a new one (state cleanup)', () => {
  it('S4a: cancel is abort-only; jobs stay "run" until the promise chain unwinds', async () => {
    const h = 's4a'
    startRun(h, 'T', ['1', '2', '3', '4', '5', '6', '7', '8'])
    await sleep(15)
    cancelRun(h)

    const immediate = states(h)!
    expect(immediate).toContain('run') // nothing flipped synchronously

    const settled = await until(() => !runBusy(recOf(h)!))
    expect(settled).toBe(true)
    expect(states(h)!.every((s) => s === 'ok' || s === 'fail')).toBe(true)
    expect(recOf(h)!.jobs.some((j) => j.error === 'Dibatalkan')).toBe(true)
  })

  it('S4b: startRun IMMEDIATELY after cancel is dropped (dedupe hits the stale busy rec)', async () => {
    const h = 's4b'
    startRun(h, 'T', ['1', '2', '3'])
    cancelRun(h)
    startRun(h, 'T', ['7', '8']) // user taps "download again" instantly

    expect(nums(h)).toEqual(['1', '2', '3'])
    expect(getRuns().filter((r) => r.handle === h)).toHaveLength(1)

    await until(() => !runBusy(recOf(h)!))
    // never retried: the user must tap a THIRD time
    expect(nums(h)).toEqual(['1', '2', '3'])
  })

  it('S4c: after cancel settles, a new batch starts fine', async () => {
    const h = 's4c'
    startRun(h, 'T', ['1', '2'])
    cancelRun(h)
    expect(await until(() => !runBusy(recOf(h)!))).toBe(true)
    startRun(h, 'T', ['7'])
    expect(nums(h)).toEqual(['7'])
    await until(() => !runBusy(recOf(h)!))
  })

  it('S4d: cancel never prunes recs — unbounded growth of the singleton', async () => {
    const before = getRuns().length
    for (let i = 0; i < 5; i++) {
      const h = `s4d-${i}`
      startRun(h, 'T', ['1'])
      cancelRun(h)
      await until(() => !runBusy(recOf(h)!))
    }
    expect(getRuns().length).toBe(before + 5)
    expect(getRuns().filter((r) => r.handle.startsWith('s4d-')).every((r) => !runBusy(r))).toBe(true)
  })

  it('S4e: cancel on unknown handle / finished run is a safe no-op', async () => {
    expect(() => cancelRun('ghost-xyz')).not.toThrow()
    const h = 's4e'
    startRun(h, 'T', ['1'])
    expect(await until(() => !runBusy(recOf(h)!))).toBe(true)
    expect(() => cancelRun(h)).not.toThrow() // finished: find() misses, no crash
    expect(okCount(h)).toBe(1)
  })
})

// ---------------------------------------------------------------------------
describe('S5 — client side of the same-chapter-from-two-tabs race', () => {
  it('S5a: client has no cross-tab coordination primitive at all', () => {
    const src = readFileSync(join(process.cwd(), 'src', 'downloadStore.ts'), 'utf8')
    expect(src).not.toMatch(/new BroadcastChannel|new SharedWorker|navigator\.locks|localStorage\s*[.(]|sessionStorage\s*[.(]/)
  })

  it('S5b: identical chapter numbers in two tabs become two independent runs', async () => {
    startRun('s5b-a', 'A', ['1'])
    startRun('s5b-b', 'B', ['1'])
    const runs = getRuns().filter((r) => r.handle.startsWith('s5b-'))
    expect(runs).toHaveLength(2) // no dedupe across tabs/handles
    expect(runs.flatMap((r) => r.jobs.map((j) => j.number))).toEqual(['1', '1'])
    await until(() => !runBusy(recOf('s5b-a')!) && !runBusy(recOf('s5b-b')!))
  })
})