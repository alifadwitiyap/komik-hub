/**
 * Logika murni auto-fullscreen (dipisah agar bisa diuji tanpa React/DOM).
 *
 * Trigger: akumulasi JARAK scroll-turun. Begitu total turun melewati
 * `TRIGGER_PX`, fire. Ini kontinu — satu gerakan scroll cepat (banyak px)
 * langsung masuk, tidak perlu menghitung gestur diskrit. Arah naik
 * me-reset akumulasi.
 */
export const THRESHOLD_PX = 20
export const TRIGGER_PX = 120

export interface GestureStep {
  /** jarak turun terakumulasi (px) */
  pixels: number
  fire: boolean
}

export function gestureStep(pixels: number, delta: number): GestureStep {
  if (Math.abs(delta) < THRESHOLD_PX) return { pixels, fire: false }
  if (delta < 0) return { pixels: 0, fire: false } // naik → reset
  const next = pixels + delta
  if (next >= TRIGGER_PX) return { pixels: 0, fire: true }
  return { pixels: next, fire: false }
}
