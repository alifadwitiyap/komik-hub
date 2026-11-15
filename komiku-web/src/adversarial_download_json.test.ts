/**
 * ADVERSARIAL PROBE — Scenario 5 (malformed server JSON):
 * The download batch JSON response from the server is malformed or missing
 * required fields. Hostile question: when `POST /api/unified/download-pdf`
 * returns 200 with a body that is truncated/garbage JSON, or valid JSON that
 * is missing `id`/`filename` (the fields the store depends on), what happens?
 * Does the code validate, or does it blindly read `res.id`/`res.filename`
 * (undefined) and propagate a phantom "ok"?
 *
 * Exercises the REAL code path:
 *   - api.send<T>()  (the JSON parse / error path used by downloadPdf)
 *   - downloadBatch.downloadChapters (reads res.id/res.filename via onGenerated)
 *
 * We mock global fetch at the boundary so the REAL `send()` and REAL
 * `downloadChapters()` run. The api module's BASE='/api' + accountHeaders are
 * exercised as-is (accountHeaders returns undefined without a logged-in user,
 * which is fine for node).
 *
 * Run: npx vitest run src/adversarial_download_json.test.ts
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

/** Build a fetch Response-like object. `text` is what send() parses. */
function resp(opts: { ok?: boolean; status?: number; text: string }): Response {
  const { ok = true, status = 200, text } = opts
  return {
    ok,
    status,
    text: async () => text,
    json: async () => JSON.parse(text),
  } as unknown as Response
}

describe('ADVERSARIAL S5: malformed / incomplete download-pdf JSON', () => {
  let fetchMock: ReturnType<typeof vi.fn>

  beforeEach(() => {
    fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.resetModules()
  })

  it('S5-a: 200 with truncated JSON -> send() throws SyntaxError (caught, no phantom ok)', async () => {
    const { unifiedApi } = await import('./api')
    // Body is truncated mid-string: not valid JSON.
    fetchMock.mockResolvedValue(resp({ ok: true, status: 200, text: '{"id":"abc","filen' }))

    // send() does JSON.parse(text) with no try/catch -> throws SyntaxError.
    // downloadChapters wraps the call in try/catch and marks the job 'fail'
    // with the SyntaxError message. So a truncated body does NOT become a
    // phantom success at the batch layer — but the error text is a raw
    // "Unexpected end of JSON input", not a friendly message.
    await expect(
      unifiedApi.downloadPdf('komiku:1', '1'),
    ).rejects.toThrowError()
  })

  it('S5-b: 200 valid JSON missing `id` and `filename` -> downloadChapters marks chapter ok with undefined ids', async () => {
    // Body is valid JSON but empty of required fields: {} (missing id/filename).
    fetchMock.mockResolvedValue(resp({ ok: true, status: 200, text: '{}' }))

    const { downloadChapters } = await import('./downloadBatch')
    const updates: Array<{ index: number; state?: string; error?: string }> = []
    let generated: { id: string; filename: string } | null = null

    await downloadChapters(
      [{ handle: 'komiku:1', number: '1' }],
      (index, patch) => updates.push({ index, ...patch }),
      undefined,
      async (id, filename) => {
        generated = { id, filename }
      },
    )

    // NOTE (historical): before the working-tree validation fix, downloadChapters
    // read res.id/res.filename blindly; 200 + '{}' produced phantom-ok with
    // undefined URL. Runtime validation now marks the chapter fail.
    // REMEDIATED since first probe run: downloadChapters now validates
    // res.id/res.filename before marking 'ok' (see downloadBatch.ts:168-175).
    const final = updates[updates.length - 1]
    expect({ state: final.state, generated }).toEqual({
      state: 'fail',
      generated: null,
    })
  })

  it('S5-c: 200 valid JSON with wrong types (id is a number) -> still ok, bad URL downstream', async () => {
    fetchMock.mockResolvedValue(
      resp({ ok: true, status: 200, text: '{"id":123,"filename":456}' }),
    )
    const { downloadChapters } = await import('./downloadBatch')
    const updates: Array<{ index: number; state?: string }> = []
    let seen: { id: unknown; filename: unknown } | null = null

    await downloadChapters(
      [{ handle: 'komiku:1', number: '1' }],
      (index, patch) => updates.push({ index, ...patch }),
      undefined,
      async (id, filename) => {
        seen = { id, filename }
      },
    )

    const final = updates[updates.length - 1]
    // REMEDIATED: runtime validation in downloadChapters rejects non-string
    // id/filename before marking 'ok'.
    expect({ state: final.state, seen }).toEqual({
      state: 'fail',
      seen: null,
    })
  })

  it('S5-d: 500 with JSON {error,hint} -> error surfaced as thrown Error with server text', async () => {
    fetchMock.mockResolvedValue(
      resp({
        ok: false,
        status: 500,
        text: JSON.stringify({ error: 'generate gagal', hint: 'coba lagi' }),
      }),
    )
    const { unifiedApi } = await import('./api')
    // send() reads {error,hint} on !ok and throws "generate gagal — coba lagi".
    await expect(unifiedApi.downloadPdf('komiku:1', '1')).rejects.toThrowError(
      /generate gagal/,
    )
  })
})