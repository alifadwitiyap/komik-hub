/**
 * ADVERSARIAL PROBE — Scenario 2 (durability):
 * Download batch partially completes, then the browser tab is closed (the
 * JS heap is torn down). Hostile question: does the in-module downloadStore
 * persist any "completed" progress durably, or is the module singleton the
 * ONLY record — so a closed tab silently loses the fact that N chapters
 * already succeeded and the user re-downloads the whole range?
 *
 * The store doc-comment claims "run lives outside React, survives page
 * navigation." We verify the claim against the real code: the store is a
 * module-level `recs` array with no localStorage/IndexedDB write. Closing the
 * tab destroys `recs`; the server-side generated PDFs survive (TTL 24h) but
 * the client's notion of "what already completed" does not.
 *
 * Exercises the REAL module state (downloadStore.startRun) plus a simulated
 * "tab close" = re-importing the module fresh (which resets `recs`).
 *
 * Run: npx vitest run src/adversarial_download_abort.test.ts
 */
import { describe, it, expect, vi, afterEach } from 'vitest'

/** Make downloadChapters resolvable-but-observable so startRun drives real state. */
vi.doMock('./downloadBatch', () => ({
  downloadChapters: async (
    _list: unknown,
    onUpdate: (i: number, p: { state: string }) => void,
  ) => {
    // Simulate: chapters 0 and 1 complete, then the "tab closes" mid-batch.
    onUpdate(0, { state: 'ok' })
    onUpdate(1, { state: 'ok' })
    // Never resolves further — the batch is interrupted by tab close.
    return new Promise<void>(() => {})
  },
  cacheChapters: async () => new Promise<void>(() => {}),
  saveGeneratedPdf: async () => false,
}))

describe('ADVERSARIAL S2: partial batch then tab close (durability)', () => {
  afterEach(() => {
    vi.doUnmock('./downloadBatch')
    vi.resetModules()
  })

  it('S2-a: after a simulated tab close, completed progress is GONE (no durable record)', async () => {
    // Fresh module instance = "new tab session".
    const store = await import('./downloadStore')

    store.startRun('komiku:1', 'Judul', ['1', '2', '3'])
    // Let the first two jobs reach 'ok'.
    await new Promise((r) => setTimeout(r, 0))

    const beforeClose = store.getRuns()
    const doneBeforeClose = beforeClose[0]?.jobs.filter((j) => j.state === 'ok').length ?? 0

    // --- SIMULATED TAB CLOSE: tear down the module graph entirely. ---
    // A real tab close destroys the singleton; the only way to prove nothing
    // durable was written is to reset the module registry and re-import.
    vi.resetModules()
    const afterTab = await import('./downloadStore')

    const afterClose = afterTab.getRuns()

    // What the server knows (PDFs generated, TTL 24h) is not modelled here —
    // the hostile claim is specifically about CLIENT durability: the store is
    // a pure module singleton. Evidence:
    //   1. Before close: 2 jobs had reached 'ok'.
    //   2. After close: a fresh import starts with ZERO runs.
    //   3. No localStorage / indexedDB / sessionStorage write exists anywhere
    //      in downloadStore.ts (grep target: none).
    expect({ doneBeforeClose }).toEqual({ doneBeforeClose: 2 })
    expect({ runsAfterClose: afterClose.length }).toEqual({ runsAfterClose: 0 })
  })

  it('S2-b: store exposes no persistence hook (grep-equivalent structural check)', async () => {
    const store = await import('./downloadStore')
    // The public surface is exactly: getRuns, subscribeRuns, startRun,
    // startRunCache, cancelRun, runBusy. No persist/restore/hydrate.
    const api = Object.keys(store).sort()
    // Persisture surface would mean any persist/restore/hydrate export.
    expect(api.filter((k) => /persist|restore|hydrate|save|load|sync/i.test(k))).toEqual([])
    // And there is no storage write in the surface — proven by absence: no
    // function accepts or returns a serialized snapshot.
    expect(typeof (store as Record<string, unknown>).persist).toBe('undefined')
  })
})