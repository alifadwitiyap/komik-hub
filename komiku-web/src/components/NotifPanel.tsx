import { useEffect, useMemo, useRef } from 'react'
import type { RefObject } from 'react'
import { useNavigate } from 'react-router-dom'
import { IconXmark } from '../icons'
import type { NotifItem } from '../api'
import { groupNotifsByTitle } from '../hooks/useNotifications'

/**
 * NotifPanel — dropdown notifikasi di bawah tombol lonceng.
 * Dirender absolut (tidak menggeser layout), z di atas konten, daftar
 * scroll sendiri. Tutup saat klik di luar atau tekan Escape.
 */
export default function NotifPanel({
  open,
  items,
  unread,
  loading,
  onClose,
  onMarkRead,
  onDismiss,
  boundaryRef,
}: {
  open: boolean
  items: NotifItem[]
  unread: number
  loading: boolean
  onClose: () => void
  onMarkRead: (ids?: string[] | 'all') => void
  onDismiss: (id: string) => void
  /** elemen pembungkus (lonceng + panel): klik di dalamnya bukan "luar". */
  boundaryRef?: RefObject<HTMLElement | null>
}) {
  const ref = useRef<HTMLDivElement>(null)
  const navigate = useNavigate()

  // satu baris per series (title_key), bukan per notifikasi
  const groups = useMemo(() => groupNotifsByTitle(items), [items])

  // tutup: klik di luar + Escape
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node
      const inside =
        (ref.current?.contains(t) ?? false) ||
        (boundaryRef?.current?.contains(t) ?? false)
      if (!inside) onClose()
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open, onClose, boundaryRef])

  if (!open) return null

  return (
    <div
      ref={ref}
      role="dialog"
      aria-label="Notifikasi"
      className="absolute right-0 top-full z-50 mt-2 w-[min(22rem,calc(100vw-1.5rem))] overflow-hidden rounded-xl border border-ink-800 bg-ink-950 shadow-xl shadow-black/40"
    >
      <div className="flex items-center gap-2 border-b border-ink-800 px-3.5 py-2.5">
        <h2 className="font-display text-[13px] font-bold text-ink-100">Notifikasi</h2>
        {unread > 0 && (
          <span className="rounded-full bg-brand-amber px-1.5 py-px text-[10.5px] font-bold text-ink-950">
            {unread} baru
          </span>
        )}
      </div>

      <ul className="max-h-[60vh] overflow-y-auto overscroll-contain">
        {groups.length === 0 ? (
          <li className="px-3.5 py-8 text-center text-[12.5px] text-ink-500">
            {loading ? 'Memuat…' : 'Belum ada notifikasi'}
          </li>
        ) : (
          groups.map((g) => (
            <li key={g.title_key} className="border-b border-ink-800 last:border-0">
              <div className="flex items-start gap-2.5 px-3 py-2.5">
                <button
                  onClick={() => {
                    navigate(`/manga/${g.latest.handle}`)
                    // API markRead menerima daftar id → kirim SEMUA id title ini
                    onMarkRead(g.ids)
                    onClose()
                  }}
                  className="min-w-0 flex-1 text-left"
                >
                  <span className="flex items-center gap-1.5">
                    {g.unread > 0 && (
                      <span
                        aria-hidden="true"
                        className="size-1.5 shrink-0 rounded-full bg-brand-amber"
                      />
                    )}
                    <span
                      className={`truncate text-[13px] ${
                        g.unread > 0 ? 'font-semibold text-ink-100' : 'text-ink-400'
                      }`}
                    >
                      {g.latest.title}
                    </span>
                  </span>
                  <span className="mt-0.5 block truncate text-[11.5px] text-ink-400">
                    {g.unread > 0
                      ? `${g.unread} chapter baru · ${g.latest.sources.join(', ')}`
                      : `Terakhir: Chapter ${g.latest.chapter} · ${g.latest.sources.join(', ')}`}
                  </span>
                  <span className="mt-0.5 block text-[11px] text-ink-500">
                    {relativeId(g.latest.at)}
                  </span>
                </button>
                <button
                  onClick={() => {
                    // satu baris = semua notif title ini → hapus semuanya
                    for (const id of g.ids) onDismiss(id)
                  }}
                  aria-label={`Hapus notifikasi ${g.latest.title}`}
                  className="-mr-1 shrink-0 rounded-lg p-1.5 text-ink-500 transition-colors hover:bg-ink-850 hover:text-ink-200"
                >
                  <IconXmark className="size-3.5" />
                </button>
              </div>
            </li>
          ))
        )}
      </ul>

      {groups.length > 0 && (
        <div className="flex items-center border-t border-ink-800 px-3 py-2">
          <button
            onClick={() => onMarkRead('all')}
            disabled={unread === 0}
            className="flex-1 rounded-xl py-2 text-[12px] font-bold text-brand-amber transition-colors hover:bg-ink-900 disabled:text-ink-500 disabled:hover:bg-transparent"
          >
            Tandai semua dibaca
          </button>
          <button
            onClick={() => {
              navigate('/notifikasi')
              onClose()
            }}
            className="shrink-0 rounded-xl py-2 pl-2 pr-1 text-[12px] font-bold text-ink-300 transition-colors hover:text-ink-100"
          >
            Lihat semua
          </button>
        </div>
      )}
    </div>
  )
}

const rtf = new Intl.RelativeTimeFormat('id-ID', { numeric: 'auto' })

/** Waktu relatif id-ID: "2 jam lalu". */
function relativeId(at: number): string {
  if (!at) return ''
  const diffSec = Math.round((at - Date.now()) / 1000)
  const abs = Math.abs(diffSec)
  if (abs < 60) return rtf.format(diffSec, 'second')
  if (abs < 3600) return rtf.format(Math.round(diffSec / 60), 'minute')
  if (abs < 86400) return rtf.format(Math.round(diffSec / 3600), 'hour')
  if (abs < 2592000) return rtf.format(Math.round(diffSec / 86400), 'day')
  if (abs < 31536000) return rtf.format(Math.round(diffSec / 2592000), 'month')
  return rtf.format(Math.round(diffSec / 31536000), 'year')
}
