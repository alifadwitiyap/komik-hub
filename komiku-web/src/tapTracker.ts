/**
 * Pure, framework-neutral tap tracker shared by Reader & ReaderMarathon.
 *
 * A "tap" toggles reader chrome; scroll and pinch must never count as taps.
 * - scroll/drag: start-to-click displacement > 12px or held > 900ms
 * - scroll cancel: pointercancel invalidates the gesture
 * - pinch: >1 simultaneous touch invalidates the gesture
 * - double tap: two center taps within 300ms toggle zoom at the touch point
 *
 * Kept free of React types so it is unit-testable under the node vitest env.
 */
export type TapPoint = { x: number; y: number; t: number }

export type TapAction =
  | { type: 'none' }
  | { type: 'hud' }
  | { type: 'zoom'; x: number; y: number }
  | { type: 'scroll'; direction: -1 | 1 }

const DOUBLE_TAP_MS = 300
const DOUBLE_TAP_SLOP = 32

export function createTapTracker(isControl?: (x: number, y: number) => boolean) {
  const activeTouches = new Set<number>()
  let start: TapPoint | null = null
  let invalid = false
  let lastTap: TapPoint | null = null

  function finish(x: number, y: number, now: number): boolean {
    const s = start
    const wasInvalid = invalid
    start = null
    invalid = false
    if (!s || wasInvalid) {
      lastTap = null
      return false
    }
    const moved = Math.hypot(x - s.x, y - s.y)
    if (moved > 12 || now - s.t > 900) {
      lastTap = null
      return false
    }
    return !(isControl?.(x, y) ?? false)
  }

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
      lastTap = null
    },
    up(id: number) {
      activeTouches.delete(id)
    },
    /** Legacy HUD-only check; kept for callers/tests that only need chrome. */
    shouldToggle(x: number, y: number, now: number): boolean {
      return finish(x, y, now)
    },
    /**
     * Zone-aware resolution. `width` is viewport width; `tapScroll` opts into
     * the left/right 20% tap-to-scroll zones (default OFF, HUD stays center).
     */
    resolve(
      x: number,
      y: number,
      now: number,
      width: number,
      tapScroll = false,
    ): TapAction {
      if (!finish(x, y, now)) return { type: 'none' }
      const double =
        lastTap !== null &&
        now - lastTap.t <= DOUBLE_TAP_MS &&
        Math.hypot(x - lastTap.x, y - lastTap.y) <= DOUBLE_TAP_SLOP
      const current = { x, y, t: now }
      lastTap = double ? null : current
      if (double) return { type: 'zoom', x, y }
      const ratio = width > 0 ? x / width : 0.5
      if (ratio < 0.2) return tapScroll ? { type: 'scroll', direction: 1 } : { type: 'none' }
      if (ratio > 0.8) return tapScroll ? { type: 'scroll', direction: -1 } : { type: 'none' }
      return { type: 'hud' }
    },
  }
}
