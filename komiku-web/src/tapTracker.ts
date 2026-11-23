/**
 * Pure, framework-neutral tap tracker shared by Reader & ReaderMarathon.
 *
 * A "tap" toggles reader chrome; scroll and pinch must never count as taps.
 * - scroll/drag: start-to-click displacement > 12px or held > 900ms
 * - scroll cancel: pointercancel invalidates the gesture
 * - pinch: >1 simultaneous touch invalidates the gesture
 *
 * Kept free of React types so it is unit-testable under the node vitest env.
 */
export type TapPoint = { x: number; y: number; t: number }

export function createTapTracker(isControl?: (x: number, y: number) => boolean) {
  const activeTouches = new Set<number>()
  let start: TapPoint | null = null
  let invalid = false

  return {
    down(id: number, type: string, x: number, y: number, now: number) {
      if (type === 'touch') {
        activeTouches.add(id)
        if (activeTouches.size > 1) invalid = true
      }
      // Only the first pointer defines the tap origin.
      if (activeTouches.size <= 1) start = { x, y, t: now }
    },
    cancel(id: number) {
      activeTouches.delete(id)
      start = null
      invalid = true
    },
    up(id: number) {
      activeTouches.delete(id)
    },
    shouldToggle(x: number, y: number, now: number): boolean {
      const s = start
      const wasInvalid = invalid
      start = null
      invalid = false
      if (!s || wasInvalid) return false
      const moved = Math.hypot(x - s.x, y - s.y)
      if (moved > 12 || now - s.t > 900) return false
      return !(isControl?.(x, y) ?? false)
    },
  }
}
