import { useEffect, useRef, useState } from 'react'
import { getRuns, runBusy, isRunSlow, isRunStale, subscribeRuns } from '../downloadStore'
import type { DlRun } from '../downloadStore'

/**
 * Wiring unduhan batch bersama (Series.tsx & SeriesUnified.tsx).
 *
 * Subscribe store module-level untuk handle ini, menampilkan run aktif +
 * status sibuknya, dan memanggil `onFinish(run)` TEPAT SEKALI saat run yang
 * disaksikan instance ini transisi busy → selesai (dibatalkan pun dihitung
 * selesai). Unduhan tidak pernah di-abort saat unmount — batch jalan di
 * store-nya sendiri dan hasilnya tetap masuk store server + Rak.
 */
export function useDownloadRun(
  handle: string | null,
  onFinish?: (run: DlRun) => void,
): { run: DlRun | null; busy: boolean; slow: boolean; stale: boolean } {
  const [run, setRun] = useState<DlRun | null>(null)
  // callback terbaru lewat ref supaya subscription tidak re-mount tiap render
  const onFinishRef = useRef(onFinish)
  useEffect(() => {
    onFinishRef.current = onFinish
  })
  const mountedRef = useRef(true)
  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])
  // hanya instance yang MENYAKSIKAN run sibuk yang boleh mengumumkan hasilnya —
  // kunjungan baru ke halaman yang menemukan run sudah selesai tidak menyebut.
  const watchingRef = useRef(false)
  const handledRef = useRef<number | null>(null)

  useEffect(() => {
    if (!handle) return
    const sync = (runs: DlRun[]) => {
      const cur = runs.find((r) => r.handle === handle) ?? null
      setRun(cur)
      if (cur && runBusy(cur)) {
        watchingRef.current = true
        return
      }
      if (!cur || !watchingRef.current || handledRef.current === cur.startedAt) return
      handledRef.current = cur.startedAt
      watchingRef.current = false
      if (mountedRef.current) onFinishRef.current?.(cur)
    }
    const unsub = subscribeRuns(sync)
    sync(getRuns())
    return unsub
  }, [handle])

  const busy = run ? runBusy(run) : false
  // Nilai untuk UX koneksi lambat — dihitung ulang setiap 30 detik selagi
  // sibuk. `now` di-state supaya interval memicu re-count lambat/macet.
  // `stale` berbasis `lastProgressAt` (progres terakhir), bukan umur run.
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!busy) return
    const t = setInterval(() => setNow(Date.now()), 30_000)
    return () => clearInterval(t)
  }, [busy])
  const slow = run ? busy && isRunSlow(run, now) : false
  const stale = run ? busy && isRunStale(run, now) : false
  return { run, busy, slow, stale }
}

/** Endpoint ringan untuk membuktikan server benar-benar bisa dijangkau. */
const REACHABILITY_URL = '/api/health'
const REACHABILITY_TIMEOUT_MS = 2_500

/**
 * Apakah server masih bisa dijangkau? `navigator.onLine` saja sering basi
 * (WiFi putus / proxy mati tapi browser masih lapor "online") — probe kecil
 * dengan cache `no-store` dan timeout ±2,5 detik jadi bukti nyata.
 */
export async function isReachable(signal?: AbortSignal): Promise<boolean> {
  if (typeof fetch === 'undefined') {
    return typeof navigator !== 'undefined' ? navigator.onLine : false
  }
  const ctrl = new AbortController()
  const onAbort = () => ctrl.abort()
  if (signal?.aborted) ctrl.abort()
  else signal?.addEventListener('abort', onAbort, { once: true })
  const timer = setTimeout(
    () => ctrl.abort(new DOMException('Waktu habis', 'TimeoutError')),
    REACHABILITY_TIMEOUT_MS,
  )
  try {
    const res = await fetch(REACHABILITY_URL, { cache: 'no-store', signal: ctrl.signal })
    return res.ok
  } catch {
    return false
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', onAbort)
  }
}

/**
 * Offline status hook — `navigator.onLine` diverifikasi dengan probe nyata
 * sebelum peringatan ditampilkan, supaya status basi tidak memblokir unduhan
 * yang sebenarnya masih bisa jalan.
 */
export function useOffline(): boolean {
  // Jangan langsung percaya `navigator.onLine`: nilai basi sering bikin
  // peringatan offline palsu. Status menunggu hasil probe di effect.
  const [offline, setOffline] = useState(false)
  useEffect(() => {
    let alive = true
    const verify = async () => {
      const reachable = await isReachable()
      if (alive) setOffline(!reachable)
    }
    void verify()
    const onOffline = () => setOffline(true)
    const onOnline = () => void verify()
    window.addEventListener('offline', onOffline)
    window.addEventListener('online', onOnline)
    return () => {
      alive = false
      window.removeEventListener('offline', onOffline)
      window.removeEventListener('online', onOnline)
    }
  }, [])
  return offline
}

/** Re-ekspor retryRun dari store supaya import lama tetap valid (single implementation). */
export { retryRun } from '../downloadStore'
