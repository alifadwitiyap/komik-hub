import { useEffect, useLayoutEffect, useRef } from 'react'
import type { PointerEvent as ReactPointerEvent, RefObject } from 'react'
import {
  DUR_SHEET_MS,
  SHEET_DISMISS_DISTANCE_PX,
  SHEET_DISMISS_VELOCITY_PX_S,
} from '../lib/motion'

/** Ambang flick: motion.ts menyimpan px/s, sampel pointer memakai px/ms. */
const DISMISS_VELOCITY_PX_MS = SHEET_DISMISS_VELOCITY_PX_S / 1000
/** Hanya sampel 100ms terakhir yang dihitung — jari diam lalu dilepas = velocity 0. */
const VELOCITY_WINDOW_MS = 100
/** Sama dengan default exitMs useSheetPresence (panel di-unmount setelah ini). */
const EXIT_MS = 160
/** Elemen interaktif di header tetap klik normal; drag hanya dari area kosong. */
const INTERACTIVE = 'button, a, input, select, textarea, [role="switch"], [data-no-sheet-drag]'

/**
 * Keputusan dismiss murni (tanpa DOM) supaya bisa dites di vitest env node.
 * `dy` = jarak tarik ke bawah dalam px (>=0), `velocityPxPerMs` = kecepatan
 * ke bawah saat lepas (positif = turun). Salah satu ambang cukup.
 */
export function decideDismiss(dy: number, velocityPxPerMs: number): boolean {
  return dy > SHEET_DISMISS_DISTANCE_PX || velocityPxPerMs > DISMISS_VELOCITY_PX_MS
}

/** translateY aktual dari computed matrix (matrix2d → indeks 5, matrix3d → 13). */
function currentTranslateY(panel: HTMLElement): number {
  const t = getComputedStyle(panel).transform
  const m = t && t !== 'none' ? /matrix(3d)?\(([^)]+)\)/.exec(t) : null
  if (!m) return 0
  const n = m[2].split(',').map(Number)
  const y = m[1] ? n[13] : n[5]
  return Number.isFinite(y) ? y : 0
}

function velocity(samples: { y: number; t: number }[], y: number, t: number): number {
  const first = samples.find((s) => t - s.t <= VELOCITY_WINDOW_MS)
  if (!first || t === first.t) return 0
  return (y - first.y) / (t - first.t)
}

export interface SheetDragHandlers {
  onPointerDown: (e: ReactPointerEvent<HTMLElement>) => void
  onPointerMove: (e: ReactPointerEvent<HTMLElement>) => void
  onPointerUp: (e: ReactPointerEvent<HTMLElement>) => void
  onPointerCancel: (e: ReactPointerEvent<HTMLElement>) => void
}

/**
 * Drag-to-dismiss bottom sheet (plan 3.4). Pasang handlers ini HANYA di handle
 * pill + header (area drag); body sheet tetap scroll normal (touch-action none
 * cuma di area drag). Transform ditulis langsung ke panel per frame — tanpa
 * setState, jadi tidak ada render React selama gesture.
 *
 * Interruptible: pointerdown saat animasi enter masih jalan membaca computed
 * transform sebagai titik awal dan membatalkan transisi enter.
 */
export function useSheetDrag({
  panelRef,
  onClose,
  enabled = true,
}: {
  panelRef: RefObject<HTMLElement | null>
  onClose: () => void
  enabled?: boolean
}): SheetDragHandlers {
  const onCloseRef = useRef(onClose)
  onCloseRef.current = onClose
  const drag = useRef<{
    id: number
    startY: number
    startOffset: number
    target: HTMLElement
    samples: { y: number; t: number }[]
  } | null>(null)
  const resetTimer = useRef<number | null>(null)
  // Listener spring disimpan di ref: handler dibuat ulang tiap render, jadi
  // removeEventListener harus memakai fungsi yang BENAR-BENAR dipasang —
  // kalau tidak, listener lama bisa ikut membersihkan inline style saat exit.
  const springEnd = useRef<((e: TransitionEvent) => void) | null>(null)

  const clearResetTimer = () => {
    if (resetTimer.current != null) {
      window.clearTimeout(resetTimer.current)
      resetTimer.current = null
    }
  }

  const detachSpring = (panel: HTMLElement) => {
    if (springEnd.current) {
      panel.removeEventListener('transitionend', springEnd.current)
      springEnd.current = null
    }
  }

  const clearInline = (panel: HTMLElement) => {
    detachSpring(panel)
    clearResetTimer()
    panel.style.removeProperty('transform')
    panel.style.removeProperty('transition')
    panel.style.removeProperty('opacity')
  }

  // Buka lagi (panel masih mounted karena useSheetPresence) → buang sisa
  // transform inline dari exit/drag supaya sheet masuk dari bawah lagi.
  useLayoutEffect(() => {
    if (!enabled) return
    const panel = panelRef.current
    if (panel) clearInline(panel)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled])

  useEffect(() => {
    if (enabled) return
    drag.current = null
    clearResetTimer()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled])

  useEffect(
    () => () => {
      clearResetTimer()
      const panel = panelRef.current
      if (panel) clearInline(panel)
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  )

  const reducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches

  const onPointerDown = (e: ReactPointerEvent<HTMLElement>) => {
    if (!enabled || e.button !== 0 || !e.isPrimary || drag.current) return
    const el = e.target
    if (el instanceof Element && el.closest(INTERACTIVE)) return
    const panel = panelRef.current
    if (!panel) return
    clearResetTimer()
    detachSpring(panel)
    // Ambil posisi visual saat ini (enter mungkin belum selesai) dan bekukan.
    const offset = currentTranslateY(panel)
    panel.style.transition = 'none'
    panel.style.transform = `translateY(${offset}px)`
    try {
      e.currentTarget.setPointerCapture(e.pointerId)
    } catch {
      /* capture tidak didukung → drag tetap jalan selama jari di area drag */
    }
    drag.current = {
      id: e.pointerId,
      startY: e.clientY,
      startOffset: offset,
      target: e.currentTarget,
      samples: [{ y: e.clientY, t: performance.now() }],
    }
  }

  const onPointerMove = (e: ReactPointerEvent<HTMLElement>) => {
    const d = drag.current
    if (!d || e.pointerId !== d.id) return
    const panel = panelRef.current
    if (!panel) return
    // Rubber-band hanya untuk geser naik (rawDy < 0): 20% dari jarak jari.
    // Geser bawah tetap 1:1; velocity/dismiss memakai jarak mentah (tanpa damping).
    const rawDy = d.startOffset + e.clientY - d.startY
    const dy = rawDy < 0 ? rawDy * 0.2 : rawDy
    panel.style.transform = `translateY(${dy}px)`
    const now = performance.now()
    d.samples.push({ y: e.clientY, t: now })
    while (d.samples.length > 2 && now - d.samples[0].t > VELOCITY_WINDOW_MS) d.samples.shift()
  }

  const finish = (e: ReactPointerEvent<HTMLElement>, cancelled: boolean) => {
    const d = drag.current
    if (!d || e.pointerId !== d.id) return
    drag.current = null
    const panel = panelRef.current
    if (!panel) return
    if (d.target.hasPointerCapture(e.pointerId)) d.target.releasePointerCapture(e.pointerId)
    const dy = Math.max(0, d.startOffset + e.clientY - d.startY)
    const v = cancelled ? 0 : velocity(d.samples, e.clientY, performance.now())

    if (!cancelled && decideDismiss(dy, v)) {
      // Lanjutkan dari posisi jari ke luar layar; presence mengurus unmount.
      panel.style.transform = 'translateY(100%)'
      panel.style.transition = reducedMotion()
        ? 'none'
        : `transform ${EXIT_MS}ms var(--ease-drawer), opacity ${EXIT_MS}ms var(--ease-drawer)`
      if (reducedMotion()) panel.style.opacity = '0'
      onCloseRef.current()
      return
    }

    // Batal dismiss → balik ke posisi semula.
    panel.style.transform = 'translateY(0)'
    if (reducedMotion()) {
      panel.style.transition = 'none'
      clearInline(panel)
      return
    }
    panel.style.transition = `transform ${DUR_SHEET_MS}ms var(--ease-drawer)`
    const onSpringEnd = (e: TransitionEvent) => {
      if (e.propertyName === 'transform') clearInline(panel)
    }
    springEnd.current = onSpringEnd
    panel.addEventListener('transitionend', onSpringEnd, { once: true })
    // transitionend bisa tidak datang (tab hidden) → tetap bersihkan inline.
    resetTimer.current = window.setTimeout(() => {
      const p = panelRef.current
      if (p) clearInline(p)
    }, DUR_SHEET_MS + 40)
  }

  return {
    onPointerDown,
    onPointerMove,
    onPointerUp: (e) => finish(e, false),
    onPointerCancel: (e) => finish(e, true),
  }
}
