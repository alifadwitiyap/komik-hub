import { useEffect, useRef, useState, type RefObject } from 'react'
import { Link } from 'react-router-dom'
import { useSheetPresence } from '../hooks/useSheetPresence'
import { useSheetDrag } from '../hooks/useSheetDrag'
import { chapterResumeHref } from '../readerSource'
import { resolveResumeTarget } from '../progressResume'
import type { ProgressEntry } from '../hooks/useProgress'
import type { MarathonPosition } from '../marathonMemory'
import type { Manga } from '../types'
import * as rakStore from '../rakStore'
import { chapterNumberFromKey } from './ContinueReading'
import { showToast } from './Toast'
import '../styles/sheets.css'

export const LONG_PRESS_MS = 350
export const LONG_PRESS_SLOP_PX = 10

/** Aksi baca pertama: progres tersimpan menang, kalau tidak mulai dari Ch. 01. */
export function quickReadAction(
  manga: Pick<Manga, 'handle' | 'id'>,
  entry: ProgressEntry | null,
  marathonPos: MarathonPosition | null = null,
): { label: string; href: string | null } {
  if (entry) {
    const target = resolveResumeTarget(entry, marathonPos)
    if (target) {
      const number = chapterNumberFromKey(target.chapterId)
      return { label: `Lanjut Ch. ${number || '01'}`, href: target.href }
    }
  }
  const handle = manga.handle ?? String(manga.id)
  return { label: 'Baca Ch. 01', href: chapterResumeHref(`${handle}:01`) }
}

/** Salin dengan fallback execCommand untuk browser tanpa Clipboard API. */
export async function copySeriesLink(url: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(url)
      return true
    }
  } catch {
    /* lanjut ke fallback */
  }
  try {
    const ta = document.createElement('textarea')
    ta.value = url
    ta.setAttribute('readonly', '')
    ta.style.position = 'fixed'
    ta.style.opacity = '0'
    document.body.appendChild(ta)
    ta.select()
    const ok = document.execCommand?.('copy') ?? false
    ta.remove()
    return ok
  } catch {
    return false
  }
}

export interface QuickActionSheetProps {
  open: boolean
  onClose: () => void
  manga: Manga
  /** Progres tersimpan untuk judul ini (satu entri terbaru), atau null. */
  progress: ProgressEntry | null
  /** Elemen yang membuka sheet — fokus dikembalikan ke sini saat tutup. */
  openerRef?: RefObject<HTMLElement | null>
}

export default function QuickActionSheet({
  open,
  onClose,
  manga,
  progress,
  openerRef,
}: QuickActionSheetProps) {
  const mounted = useSheetPresence(open)
  const panelRef = useRef<HTMLDivElement>(null)
  const drag = useSheetDrag({ panelRef, onClose, enabled: open })
  const titleKey = manga.title_key ?? null
  const [favorite, setFavorite] = useState(() => Boolean(titleKey && rakStore.isFavorite(titleKey)))

  useEffect(() => {
    if (open) setFavorite(Boolean(titleKey && rakStore.isFavorite(titleKey)))
  }, [open, titleKey])

  useEffect(() => {
    if (!open) return
    const previous = openerRef?.current ?? (document.activeElement as HTMLElement | null)
    panelRef.current?.focus({ preventScroll: true })
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      e.stopPropagation()
      onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('keydown', onKey)
      previous?.focus?.({ preventScroll: true })
    }
  }, [open, onClose, openerRef])

  const handle = manga.handle ?? String(manga.id)
  const detailHref = `/manga/${handle}`
  const read = quickReadAction(manga, progress)
  const shareUrl = new URL(detailHref, window.location.origin).toString()

  const copy = async () => {
    const ok = await copySeriesLink(shareUrl)
    showToast(ok ? 'Tautan disalin' : 'Gagal menyalin tautan')
    onClose()
  }

  const toggleFavorite = () => {
    if (!titleKey) return
    rakStore.toggleFavorite({
      title_key: titleKey,
      title: manga.title,
      cover_url: manga.cover ?? manga.thumbnail ?? null,
      handle,
      source: manga.source ?? 'komiku',
    })
    setFavorite(rakStore.isFavorite(titleKey))
    onClose()
  }

  if (!mounted) return null
  return (
    <div
      className={`sheet-backdrop fixed inset-0 z-30 flex items-end justify-center bg-black/60 ${open ? '' : 'sheet-backdrop-closing'}`}
      onClick={onClose}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label={`Aksi cepat ${manga.title}`}
        data-testid="quick-action-sheet"
        tabIndex={-1}
        className={`sheet-panel w-full max-w-md rounded-t-2xl border-t border-ink-700 bg-ink-900 pb-[calc(1.5rem+env(safe-area-inset-bottom))] outline-none ${open ? '' : 'sheet-closing'}`}
        onClick={(e) => e.stopPropagation()}
      >
        <div {...drag} aria-hidden="true" className="pointer-events-auto flex h-11 touch-none select-none items-start justify-center">
          <span className="h-1 w-9 rounded-full bg-white/20" />
        </div>
        <div {...drag} className="sticky top-0 z-20 flex items-center justify-between gap-2 bg-ink-900 px-4 py-2 pointer-events-auto touch-none select-none">
          <p className="min-w-0 truncate font-display text-[14px] font-semibold text-ink-100">{manga.title}</p>
          <button
            type="button"
            onClick={onClose}
            aria-label="Tutup"
            className="grid min-h-11 min-w-11 shrink-0 place-items-center rounded-lg text-[12px] font-semibold text-ink-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-amber focus-visible:ring-offset-2"
          >
            Tutup
          </button>
        </div>
        <div className="space-y-1.5 px-3">
          {read.href && (
            <Link
              to={read.href}
              onClick={onClose}
              className="flex min-h-11 items-center gap-3 rounded-xl border border-brand-amber-dim bg-brand-amber-dim/10 px-3.5 py-3 text-left text-[13px] font-semibold text-ink-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-amber"
            >
              <span aria-hidden="true">▶</span>{read.label}
            </Link>
          )}
          {titleKey && (
            <button
              type="button"
              onClick={toggleFavorite}
              className="flex min-h-11 w-full items-center gap-3 rounded-xl border border-ink-700 px-3.5 py-3 text-left text-[13px] font-semibold text-ink-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-amber"
            >
              <span aria-hidden="true">{favorite ? '♥' : '♡'}</span>
              {favorite ? 'Hapus dari Rak' : 'Simpan ke Rak'}
            </button>
          )}
          <Link
            to={detailHref}
            onClick={onClose}
            className="flex min-h-11 items-center gap-3 rounded-xl border border-ink-700 px-3.5 py-3 text-left text-[13px] font-semibold text-ink-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-amber"
          >
            <span aria-hidden="true">↗</span>Buka Detail Komik
          </Link>
          <button
            type="button"
            onClick={() => void copy()}
            className="flex min-h-11 w-full items-center gap-3 rounded-xl border border-ink-700 px-3.5 py-3 text-left text-[13px] font-semibold text-ink-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-amber"
          >
            <span aria-hidden="true">⧉</span>Salin Tautan
          </button>
        </div>
      </div>
    </div>
  )
}
