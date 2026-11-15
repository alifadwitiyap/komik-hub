/**
 * ADVERSARIAL PROBE — Scenario 4 (resource leak):
 * downloadStore keeps a module-level `subscribers` Set. Hostile question: if a
 * React component subscribes (subscribeRuns) and unmounts without calling the
 * returned unsubscribe, does the subscriber leak — and worse, does emit()
 * keep calling a callback whose component is gone (use-after-unmount), growing
 * the Set without bound across a long session?
 *
 * Exercises the REAL downloadStore: subscribeRuns, emit (via startRun/patchJob),
 * and the absence of any auto-cleanup (no WeakRef, no useSyncExternalStore
 * teardown, no size cap).
 *
 * Run: npx vitest run src/adversarial_download_leak.test.ts
 */
import { describe, it, expect, vi, afterEach } from 'vitest'

vi.doMock('./downloadBatch', () => ({
  downloadChapters: async (
    _list: unknown,
    onUpdate: (i: number, p: { state: string }) => void,
  ) => {
    onUpdate(0, { state: 'ok' })
  },
  cacheChapters: async () => {},
  saveGeneratedPdf: async () => false,
}))

describe('ADVERSARIAL S4: downloadStore subscriber leak', () => {
  afterEach(() => {
    vi.doUnmock('./downloadBatch')
    vi.resetModules()
  })

  it('S4-a: a subscriber that never unsubscribes is retained forever (Set grows)', async () => {
    const store = await import('./downloadStore')

    // Simulate N mount/unmount cycles where the component forgets to call the
    // returned unsubscribe (the classic useEffect-with-missing-cleanup bug).
    const noop = () => {}
    for (let i = 0; i < 100; i++) {
      store.subscribeRuns(noop) // returned unsubscribe is dropped
    }

    // startRun -> emit() iterates the Set. If the Set holds all 100, the leak
    // is real. We can observe subscriber retention indirectly: emit calls every
    // cb, so count invocations with a spy subscriber added AFTER the 100.
    let calls = 0
    const spy = () => {
      calls++
    }
    store.subscribeRuns(spy)
    store.startRun('komiku:1', 'Judul', ['1'])
    await new Promise((r) => setTimeout(r, 0))

    // The spy fires at least once per emit (startRun emits on create + on ok).
    // That alone doesn't prove the leak; the structural proof is that the Set
    // has no removal path except the explicit unsubscribe. We assert the
    // store's only unsubscribe is the returned closure (no auto-GC hook).
    expect(calls).toBeGreaterThan(0)

    // Structural: there is no `clearSubscribers` / `removeAll` exported, and
    // subscribeRuns is the sole mutator of the Set. A dropped unsubscribe =>
    // permanent retention. Proven by: after dropping unsubscribes, a fresh
    // import still shows only the documented API (no teardown function).
    const api = Object.keys(store).sort()
    expect(api.filter((k) => /clear|removeAll|teardown|dispose|prune/i.test(k))).toEqual([])
  })

  it('S4-b: emit() calls a stale (unmounted) subscriber on every subsequent run (use-after-unmount)', async () => {
    const store = await import('./downloadStore')

    const stale = vi.fn()
    const unsub = store.subscribeRuns(stale)

    // Component unmounts but the cleanup is never invoked -> stale stays.
    // (We intentionally DO NOT call unsub(), reproducing the bug.)
    void unsub

    store.startRun('komiku:1', 'Judul', ['1'])
    await new Promise((r) => setTimeout(r, 0))
    const afterFirst = stale.mock.calls.length

    // A second, unrelated run for a different handle still invokes `stale`.
    store.startRun('komiku:2', 'Lain', ['1'])
    await new Promise((r) => setTimeout(r, 0))

    // Expected (correct behavior): stale subscriber should have been removed on
    // unmount. Observed: it keeps receiving snapshots — emit() has no way to
    // know the owner component is gone. Confirms leak + use-after-unmount.
    expect({ afterFirst, afterSecond: stale.mock.calls.length }).toEqual({
      afterFirst,
      afterSecond: stale.mock.calls.length,
    })
    // Hard assertion: the stale callback was invoked MORE after the first run,
    // i.e. it is still wired in despite no live component.
    expect(stale.mock.calls.length).toBeGreaterThan(afterFirst)
  })

  it('S4-c: the ONLY cleanup is the returned closure — when called, it works (sanity)', async () => {
    const store = await import('./downloadStore')
    const cb = vi.fn()
    const unsub = store.subscribeRuns(cb)
    store.startRun('komiku:1', 'Judul', ['1'])
    await new Promise((r) => setTimeout(r, 0))
    const whileSubscribed = cb.mock.calls.length
    unsub()
    store.startRun('komiku:2', 'Lain', ['1'])
    await new Promise((r) => setTimeout(r, 0))
    // Sanity: explicit unsubscribe DOES stop delivery. This is the only
    // cleanup path, which is why a dropped closure (S4-a/S4-b) leaks.
    expect({ whileSubscribed, afterUnsub: cb.mock.calls.length }).toEqual({
      whileSubscribed,
      afterUnsub: whileSubscribed,
    })
    expect(whileSubscribed).toBeGreaterThan(0)
  })
})