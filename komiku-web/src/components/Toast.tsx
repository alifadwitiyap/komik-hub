import { useRef, useSyncExternalStore } from 'react'

/**
 * Toast ringan: satu pesan tampil, pesan baru menggantikan yang lama.
 * Animasi ada di reader.css; store ini cuma state + timer (tanpa dependensi).
 */
export const TOAST_AUTO_DISMISS_MS = 2500
export const TOAST_EXIT_MS = 120

export type ToastState = {
  message: string | null
  id: number
  phase: 'in' | 'out'
  action?: { label: string; onClick: () => void }
}

export type ToastAction =
  | { type: 'show'; message: string; action?: ToastState['action'] }
  | { type: 'dismiss' }
  | { type: 'clear' }

export const initialToastState: ToastState = { message: null, id: 0, phase: 'in' }

export function reduceToast(state: ToastState, action: ToastAction): ToastState {
  switch (action.type) {
    case 'show':
      return { message: action.message, id: state.id + 1, phase: 'in', action: action.action }
    case 'dismiss':
      return state.message && state.phase === 'in' ? { ...state, phase: 'out' } : state
    case 'clear':
      return state.message ? { ...state, message: null, phase: 'in' } : state
  }
}

let state = initialToastState
const listeners = new Set<() => void>()
let hideTimer: ReturnType<typeof setTimeout> | undefined
let clearTimer: ReturnType<typeof setTimeout> | undefined

function emit(next: ToastState) {
  if (next === state) return
  state = next
  for (const listener of listeners) listener()
}

export function subscribe(listener: () => void) {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function getToastSnapshot() {
  return state
}

export function dismissToast() {
  if (hideTimer) clearTimeout(hideTimer)
  const next = reduceToast(state, { type: 'dismiss' })
  if (next === state) return
  emit(next)
  clearTimer = setTimeout(() => {
    emit(reduceToast(state, { type: 'clear' }))
  }, TOAST_EXIT_MS)
}

export function showToast(message: string) {
  showToastWithAction(message)
}

/** Pesan dengan satu aksi (mis. "Ke awal"). API lama showToast tetap valid. */
export function showToastWithAction(
  message: string,
  label?: string,
  onClick?: () => void,
) {
  if (clearTimer) clearTimeout(clearTimer)
  const action = label && onClick ? { label, onClick } : undefined
  emit(reduceToast(state, { type: 'show', message, action }))
  if (hideTimer) clearTimeout(hideTimer)
  hideTimer = setTimeout(dismissToast, TOAST_AUTO_DISMISS_MS)
}

export default function Toast() {
  const current = useSyncExternalStore(subscribe, getToastSnapshot, getToastSnapshot)
  const startY = useRef<number | null>(null)

  if (!current.message) return null
  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-[calc(11rem+env(safe-area-inset-bottom))] z-50 flex justify-center px-4">
      <div
        className="pointer-events-auto flex max-w-[90vw] touch-pan-y items-center gap-2"
        role="status"
        aria-live="polite"
        onPointerDown={(e) => {
          if ((e.target as HTMLElement).closest('button')) return
          startY.current = e.clientY
          e.currentTarget.setPointerCapture(e.pointerId)
        }}
        onPointerMove={(e) => {
          if (startY.current === null) return
          const dy = Math.max(0, e.clientY - startY.current)
          e.currentTarget.style.transform = `translateY(${dy}px)`
        }}
        onPointerUp={(e) => {
          const dy = startY.current === null ? 0 : e.clientY - startY.current
          startY.current = null
          e.currentTarget.style.transform = ''
          if (dy > 56) dismissToast()
        }}
        onPointerCancel={(e) => {
          startY.current = null
          e.currentTarget.style.transform = ''
        }}
      >
        <div
          key={current.id}
          data-phase={current.phase}
          className="reader-toast flex max-w-full items-center gap-2 rounded-full bg-black/85 px-4 py-2 text-[12px] font-medium text-white shadow-lg"
        >
          <span className="truncate">{current.message}</span>
          {current.action && (
            <button
              type="button"
              data-reader-toast-action=""
              className="-my-2 min-h-11 shrink-0 rounded-full px-2 text-[12px] font-bold text-brand-amber focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/80"
              onClick={() => {
                current.action?.onClick()
                dismissToast()
              }}
            >
              {current.action.label}
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
