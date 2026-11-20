import { afterEach, describe, expect, it, vi } from 'vitest'
import { isReachable } from './useDownloadRun'

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('isReachable — probe nyata, bukan navigator.onLine basi', () => {
  it('probe /api/health dengan cache no-store; 2xx → reachable', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true })
    vi.stubGlobal('fetch', fetchMock)

    expect(await isReachable()).toBe(true)
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/health',
      expect.objectContaining({ cache: 'no-store', signal: expect.any(AbortSignal) }),
    )
  })

  it('respon gagal → offline', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false }))
    expect(await isReachable()).toBe(false)
  })

  it('fetch menolak → offline', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network down')))
    expect(await isReachable()).toBe(false)
  })

  it('timeout ~2,5 detik → offline', async () => {
    vi.useFakeTimers()
    vi.stubGlobal(
      'fetch',
      vi.fn(
        (_url: string, init: { signal: AbortSignal }) =>
          new Promise((_resolve, reject) => {
            init.signal.addEventListener('abort', () =>
              reject(init.signal.reason ?? new Error('aborted')),
            )
          }),
      ),
    )
    const pending = isReachable()
    await vi.advanceTimersByTimeAsync(2_500)
    expect(await pending).toBe(false)
  })

  it('tanpa fetch → pakai navigator.onLine sebagai fallback terakhir', async () => {
    vi.stubGlobal('fetch', undefined)
    vi.stubGlobal('navigator', { onLine: false })
    expect(await isReachable()).toBe(false)
    vi.stubGlobal('navigator', { onLine: true })
    expect(await isReachable()).toBe(true)
  })
})
