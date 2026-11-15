/**
 * ADVERSARIAL PROBE — Scenario 1 (data integrity):
 * Download batch completes (all jobs 'ok') but some chapter images are
 * corrupted on disk — 0-byte or truncated. The hostile question: does the
 * batch/cache layer actually detect a zero-byte or truncated image body and
 * report the chapter as FAILED, or does it count "HTTP 200 with a 0-byte /
 * truncated body" as success and leave the offline store silently corrupt?
 *
 * Exercises the REAL code: chapterOffline.downloadChapterImages + cachePage
 * (the fetch + `x-komiku-cached` check path) and downloadBatch.cacheChapters
 * (which maps per-page failure -> chapter fail). We stub global fetch so the
 * proxy `/img` endpoint returns 200 with a 0-byte body and 200 with a
 * truncated body, exactly as a dead upstream would.
 *
 * Run: npx vitest run src/adversarial_download_integrity.test.ts
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const OK_IMAGE = 'https://img.komiku.org/p/01.png'

/** A minimal Response stand-in: `ok`, header lookup, and a byte body. */
function fakeResponse(opts: {
  ok?: boolean
  bodyBytes?: number
  cached?: string
}): Response {
  const { ok = true, bodyBytes = 1024, cached } = opts
  const headers = new Map<string, string>()
  if (cached !== undefined) headers.set('x-komiku-cached', cached)
  return {
    ok,
    headers: { get: (k: string) => headers.get(k.toLowerCase()) ?? null },
    // byte body is the number we *would* cache; not read by cachePage itself
    // but kept so a truncated body (0) is explicit in the probe.
    arrayBuffer: async () => new ArrayBuffer(bodyBytes),
  } as unknown as Response
}

describe('ADVERSARIAL S1: batch ok but some image bytes corrupted (0-byte / truncated)', () => {
  let fetchMock: ReturnType<typeof vi.fn>

  beforeEach(() => {
    // Img module imports imgSrc from imgUrl; we stub fetch at the global
    // boundary so cachePage's real `fetch(url, {cache:'no-cache'})` runs.
    fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('S1-a: 0-byte image body -> chapter MUST be reported as FAILED, not ok', async () => {
    // Import the REAL downloadChapterImages.
    const { downloadChapterImages } = await import('./chapterOffline')

    // One image, three proxy widths. All three return HTTP 200 with a
    // ZERO-byte body (classic dead-upstream: 200 OK, Content-Length 0).
    fetchMock.mockResolvedValue(fakeResponse({ ok: true, bodyBytes: 0 }))

    const res = await downloadChapterImages([OK_IMAGE])

    // Expected: a 0-byte page is corrupt and must count as a failure.
    // Observed: downloadChapterImages returns {ok,fail} purely from res.ok
    // + x-komiku-cached — it NEVER inspects the byte length. So a 0-byte
    // 200 is counted as ok, and the chapter is marked 'ok' upstream.
    expect({ ok: res.ok, fail: res.fail }).toEqual({ ok: 0, fail: 1 })
  })

  it('S1-b: truncated image body (Content-Length says 100, bytes shorter) -> MUST fail', async () => {
    const { downloadChapterImages } = await import('./chapterOffline')

    // 200 OK but the body is truncated (declared 1024 bytes, actually 10).
    // fetch's Response.arrayBuffer() resolves; res.ok stays true.
    fetchMock.mockImplementation(async () =>
      fakeResponse({ ok: true, bodyBytes: 10 }),
    )

    const res = await downloadChapterImages([OK_IMAGE])

    // Same blind spot: no content-length vs actual-bytes check, no
    // Image.decode() validation. A truncated 200 counts as success.
    expect({ ok: res.ok, fail: res.fail }).toEqual({ ok: 0, fail: 1 })
  })

  it('S1-c: batch-level — cacheChapters must mark chapter fail when a page is corrupt', async () => {
    // Stub unifiedApi.chapter to return one image; stub fetch so the page
    // body is 0-byte. If the cache layer fails the chapter, the batch reports
    // 'fail' for that index.
    vi.doMock('./api', () => ({
      unifiedApi: {
        chapter: async () => ({
          title: 'Ch 1',
          number: '1',
          source: 'komiku',
          images: [OK_IMAGE],
        }),
      },
      accountHeaders: () => ({}),
    }))
    // Re-import after doMock so downloadBatch sees the stubbed api module.
    vi.resetModules()
    const batch = await import('./downloadBatch')

    fetchMock.mockResolvedValue(fakeResponse({ ok: true, bodyBytes: 0 }))

    const updates: Array<{ index: number; state?: string; error?: string }> = []
    await batch.cacheChapters(
      [{ handle: 'komiku:1', number: '1' }],
      (index, patch) => updates.push({ index, ...patch }),
    )

    // The terminal state for index 0 must be 'fail' because the only page
    // was a 0-byte corrupt body. If the code marks it 'ok', the offline store
    // now holds a corrupt chapter the user thinks is readable.
    const final = updates[updates.length - 1]
    expect({ index: final.index, state: final.state }).toEqual({ index: 0, state: 'fail' })
  })
})