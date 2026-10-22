/**
 * Logika murni auto-fullscreen (dipisah agar bisa diuji tanpa React/DOM).
 * Trigger: 3 gestur scroll-bawah (tiap turun melewati threshold 40px);
 * arah naik mereset hitungan.
 */
export const THRESHOLD_PX = 40
export const GESTURE_COUNT = 3

export interface GestureStep {
  count: number
  fire: boolean
}

export function gestureStep(count: number, delta: number): GestureStep {
  if (Math.abs(delta) < THRESHOLD_PX) return { count, fire: false }
  if (delta < 0) return { count: 0, fire: false } // naik → reset
  const next = count + 1
  if (next >= GESTURE_COUNT) return { count: 0, fire: true }
  return { count: next, fire: false }
}
