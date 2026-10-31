import { useEffect, useRef, useState } from 'react'
import { getRuns, runBusy, subscribeRuns } from '../downloadStore'
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
): { run: DlRun | null; busy: boolean } {
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
  return { run, busy }
}
