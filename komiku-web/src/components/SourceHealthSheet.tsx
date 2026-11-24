/**
 * SourceHealthSheet — detail Status Sumber.
 *
 * HP: bottom sheet dari bawah + backdrop. Desktop (>= 640px): popover dengan
 * transform-origin top-right. Tidak ada probe diam-diam saat dibuka; panel
 * di dalam memakai hook biasa (poll 30s) dan tombol Cek ulang yang eksplisit.
 */

import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { useSheetDrag } from '../hooks/useSheetDrag'
import { useSheetPresence } from '../hooks/useSheetPresence'
import SourceHealthPanel from './SourceHealthPanel'

export interface SourceHealthSheetProps {
  open: boolean
  onClose: () => void
}

/** Sufiks class animasi tidak bisa memakai varian `sm:` Tailwind (class sh-*
 *  baru, bukan utility), jadi breakpoint-nya dibaca dari matchMedia. */
function useDesktop(): boolean {
  const [desktop, setDesktop] = useState(
    () => typeof window !== 'undefined' && window.matchMedia('(min-width: 640px)').matches,
  )
  useEffect(() => {
    const mq = window.matchMedia('(min-width: 640px)')
    const onChange = (e: MediaQueryListEvent) => setDesktop(e.matches)
    mq.addEventListener('change', onChange)
    return () => mq.removeEventListener('change', onChange)
  }, [])
  return desktop
}

export default function SourceHealthSheet({ open, onClose }: SourceHealthSheetProps) {
  const mounted = useSheetPresence(open)
  const desktop = useDesktop()
  const panelRef = useRef<HTMLDivElement>(null)
  const backdropRef = useRef<HTMLDivElement>(null)
  const closeRef = useRef(onClose)
  closeRef.current = onClose
  // useSheetDrag memakai pointer capture + ambang 100px / 500px/s dari
  // lib/motion, dan hanya dipasang di grip (mobile).
  const drag = useSheetDrag({ panelRef, onClose, enabled: open && !desktop })

  useEffect(() => {
    if (!open || !mounted) return
    // Backdrop fade-in 180ms memakai WAAPI (native) — tanpa CSS baru.
    backdropRef.current?.animate?.([{ opacity: 0 }, { opacity: 1 }], {
      duration: 180,
      easing: 'ease-out',
    })
  }, [open, mounted])

  useLayoutEffect(() => {
    if (!open || !mounted) return
    const active = document.activeElement
    const opener = active instanceof HTMLElement && active !== document.body ? active : null
    panelRef.current?.focus({ preventScroll: true })
    return () => opener?.focus({ preventScroll: true })
  }, [open, mounted])

  useEffect(() => {
    if (!open || !mounted) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        closeRef.current()
        return
      }
      if (e.key !== 'Tab') return
      const panel = panelRef.current
      if (!panel) return
      const focusables = panel.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), input, select, textarea, [tabindex]:not([tabindex="-1"])',
      )
      if (focusables.length === 0) return
      const first = focusables[0]
      const last = focusables[focusables.length - 1]
      const active = document.activeElement
      if (!active || !panel.contains(active)) {
        e.preventDefault()
        first.focus()
      } else if (e.shiftKey && active === first) {
        e.preventDefault()
        last.focus()
      } else if (!e.shiftKey && active === last) {
        e.preventDefault()
        first.focus()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, mounted])

  if (!mounted) return null

  return (
    <div className="fixed inset-0 z-50" data-source-health-sheet="">
      <div
        ref={backdropRef}
        aria-hidden="true"
        onClick={() => closeRef.current()}
        className={`sheet-backdrop absolute inset-0 bg-black/60 ${open ? '' : 'sheet-backdrop-closing'}`}
      />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label="Status Sumber"
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
        className={`absolute max-h-[85dvh] overflow-y-auto overscroll-contain border-ink-700 bg-ink-900 shadow-2xl outline-none inset-x-0 bottom-0 rounded-t-2xl border-t sm:inset-x-auto sm:bottom-auto sm:right-3 sm:top-14 sm:max-h-[calc(100dvh-4.5rem)] sm:w-[360px] sm:rounded-2xl sm:border ${
          !open
            ? desktop ? 'sh-popover-closing' : 'sh-sheet-closing'
            : desktop ? 'sh-popover-enter' : 'sh-sheet-enter'
        }`}
      >
        {!desktop && (
          <div
            {...drag}
            aria-hidden="true"
            className="flex h-6 touch-none select-none items-start justify-center pt-2"
          >
            <span className="h-1 w-9 rounded-full bg-ink-600" />
          </div>
        )}
        <div className="sticky top-0 z-10 flex min-h-11 items-center justify-end bg-ink-900/95 px-3 backdrop-blur-sm">
          <button
            type="button"
            onClick={() => closeRef.current()}
            className="sh-tap grid h-11 min-w-11 place-items-center rounded-lg px-2 text-[12px] font-semibold text-ink-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-amber"
          >
            Tutup
          </button>
        </div>
        <SourceHealthPanel />
      </div>
    </div>
  )
}
