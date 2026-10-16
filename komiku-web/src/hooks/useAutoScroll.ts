import { useEffect } from 'react'

/** Kecepatan Putar Otomatis ala Komiku+: "Pertama" (lambat) & "Kedua" (cepat). */
export const SPEED_PERTAMA = 1
export const SPEED_KEDUA = 2
const PX_PER_TICK: Record<number, number> = {
  [SPEED_PERTAMA]: 1.2,
  [SPEED_KEDUA]: 3.4,
}
const TICK_MS = 16

/**
 * Putar Otomatis — scroll halaman terus-menerus tanpa sentuhan.
 * Dipakai Reader & ReaderMarathon. Non-trivial: rAF-free setInterval supaya
 * tetap jalan saat tab throttling ringan; lepas timer saat nonaktif.
 */
export function useAutoScroll(enabled: boolean, speed: number): void {
  useEffect(() => {
    if (!enabled) return
    const id = window.setInterval(() => {
      window.scrollBy({ top: PX_PER_TICK[speed] ?? PX_PER_TICK[SPEED_PERTAMA] })
    }, TICK_MS)
    return () => window.clearInterval(id)
  }, [enabled, speed])
}
