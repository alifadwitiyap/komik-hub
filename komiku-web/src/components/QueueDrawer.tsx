import { useEffect, useRef } from 'react'
import type { QueueItem } from '../readingQueue'

interface Props {
  open: boolean
  items: QueueItem[]
  currentIndex: number
  onClose: () => void
  onPick: (index: number) => void
  onExit: () => void
}

/** Bottom sheet daftar antrean — fokus terjaga, Escape menutup. */
export default function QueueDrawer({ open, items, currentIndex, onClose, onPick, onExit }: Props) {
  const sheetRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    if (!open) return
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null
    sheetRef.current?.querySelector<HTMLElement>('button')?.focus()
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        onClose()
        return
      }
      if (event.key !== 'Tab') return
      const focusables = Array.from(
        sheetRef.current?.querySelectorAll<HTMLElement>('button:not([disabled])') ?? [],
      )
      if (focusables.length === 0) return
      const first = focusables[0]
      const last = focusables[focusables.length - 1]
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault()
        first.focus()
      }
    }
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('keydown', onKey)
      if (previous?.isConnected) previous.focus()
    }
  }, [open, onClose])

  return (
    <div
      className={`fixed inset-0 z-50 ${open ? '' : 'pointer-events-none'}`}
      aria-hidden={!open}
      inert={!open}
    >
      <button
        type="button"
        aria-label="Tutup daftar antrean"
        onClick={onClose}
        className="absolute inset-0 size-full bg-black/60"
      />
      <div
        ref={sheetRef}
        role="dialog"
        aria-modal="true"
        aria-label="Daftar antrean baca"
        data-open={open}
        className="kh-sheet absolute inset-x-0 bottom-0 max-h-[75dvh] overflow-y-auto overscroll-contain rounded-t-2xl border-t border-ink-700 bg-night-dark px-4 pb-[calc(16px+env(safe-area-inset-bottom))] pt-4 text-white"
      >
        <div className="mb-3 flex items-center justify-between gap-3">
          <h2 className="text-[14px] font-bold">Sisa antrean</h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Tutup"
            className="kh-tap min-h-11 rounded-lg px-3 text-[13px] font-semibold text-neutral-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-amber"
          >
            Tutup
          </button>
        </div>
        <ul className="space-y-1">
          {items.map((item, index) => (
            <li key={`${item.titleKey}:${item.targetChapter}`}>
              <button
                type="button"
                onClick={() => onPick(index)}
                aria-current={index === currentIndex ? 'step' : undefined}
                className={`kh-tap flex min-h-11 w-full items-center gap-3 rounded-lg px-3 text-left text-[13px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-amber ${
                  index === currentIndex ? 'bg-brand-amber/15 font-bold' : 'font-medium'
                }`}
              >
                <span className="w-6 shrink-0 text-neutral-400">{index + 1}</span>
                <span className="min-w-0 flex-1 truncate">{item.title}</span>
                <span className="shrink-0 text-[11px] text-neutral-400">Ch. {item.targetChapter}</span>
              </button>
            </li>
          ))}
        </ul>
        <button
          type="button"
          onClick={onExit}
          className="kh-tap mt-3 flex min-h-11 w-full items-center justify-center rounded-xl border border-ink-700 text-[13px] font-semibold text-neutral-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-amber"
        >
          Keluar dari mode antrean
        </button>
      </div>
    </div>
  )
}
