/**
 * Notifikasi — halaman feed penuh "Chapter baru" favorit.
 *
 * Ringkasan harian: item dikelompokkan per hari (Hari ini / Kemarin / tanggal
 * lengkap), lalu di dalam tiap hari dikelompokkan per judul (title_key) —
 * satu baris per series, sama seperti dropdown NotifPanel.
 *
 * Aksi (klik baris / hapus / tandai semua) memakai instance store yang SAMA
 * dengan lonceng (`useNotifCounts`), jadi badge bell ikut ter-update.
 */

import { useMemo } from 'react'
import { useNavigate } from 'react-router-dom'
import { IconAngleLeft, IconXmark } from '../icons'
import { useNotifCounts } from '../notifCounts'
import { groupNotifsByTitle, type NotifTitleGroup } from '../hooks/useNotifications'
import type { NotifItem } from '../api'

export default function Notifikasi() {
  const navigate = useNavigate()
  const notif = useNotifCounts()

  // ringkasan harian: bucket ITEM per hari dulu, lalu grup per judul di tiap hari
  const days = useMemo(() => {
    const byDay = new Map<string, NotifItem[]>()
    for (const it of notif.items) {
      const label = dayLabel(it.at)
      const list = byDay.get(label)
      if (list) list.push(it)
      else byDay.set(label, [it])
    }
    const out: [string, NotifTitleGroup[]][] = []
    for (const [label, items] of byDay) {
      out.push([label, groupNotifsByTitle(items)])
    }
    return out
  }, [notif.items])

  return (
    <div className="mx-auto max-w-3xl px-4 py-5">
      <div className="mb-4 flex items-center gap-2">
        <button
          onClick={() => navigate(-1)}
          aria-label="Kembali"
          className="-ml-2 rounded-lg p-1.5 text-ink-400 transition-colors hover:bg-ink-850 hover:text-ink-200"
        >
          <IconAngleLeft className="size-5" />
        </button>
        <h1 className="text-lg font-semibold text-ink-100">Notifikasi</h1>
        {notif.unread > 0 && (
          <span className="rounded-full bg-brand-amber px-2 py-px text-[10.5px] font-bold text-ink-950">
            {notif.unread} belum dibaca
          </span>
        )}
        <button
          onClick={() => notif.markRead('all')}
          disabled={notif.unread === 0}
          className="ml-auto text-[12px] font-bold text-brand-amber transition-colors hover:underline disabled:text-ink-500 disabled:hover:no-underline"
        >
          Tandai semua dibaca
        </button>
      </div>

      {notif.items.length === 0 ? (
        <p className="py-16 text-center text-[13px] text-ink-500">
          {notif.loading ? 'Memuat…' : 'Belum ada notifikasi.'}
        </p>
      ) : (
        <div className="space-y-6">
          {days.map(([label, groups]) => (
            <section key={label}>
              <h2 className="mb-2 px-1 text-[11.5px] font-bold uppercase tracking-wider text-ink-500">
                {label}
              </h2>
              <ul className="overflow-hidden rounded-xl border border-ink-800 bg-ink-950">
                {groups.map((g) => (
                  <li key={g.title_key} className="border-b border-ink-800 last:border-0">
                    <div className="flex items-start gap-2.5 px-3 py-3">
                      <button
                        onClick={() => {
                          navigate(`/manga/${g.latest.handle}`)
                          notif.markRead(g.ids)
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
                            className={`truncate text-[13.5px] ${
                              g.unread > 0 ? 'font-semibold text-ink-100' : 'text-ink-400'
                            }`}
                          >
                            {g.latest.title}
                          </span>
                        </span>
                        <span className="mt-0.5 block truncate text-[12px] text-ink-400">
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
                          for (const id of g.ids) notif.dismiss(id)
                        }}
                        aria-label={`Hapus notifikasi ${g.latest.title}`}
                        className="-mr-1 shrink-0 rounded-lg p-1.5 text-ink-500 transition-colors hover:bg-ink-850 hover:text-ink-200"
                      >
                        <IconXmark className="size-3.5" />
                      </button>
                    </div>
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      )}
    </div>
  )
}

/** Label hari, waktu lokal. "Hari ini" / "Kemarin" / tanggal lengkap id-ID. */
function dayLabel(at: number): string {
  if (!at) return ''
  const d = new Date(at)
  const now = new Date()
  const startOfDay = (t: Date) =>
    new Date(t.getFullYear(), t.getMonth(), t.getDate()).getTime()
  const diffDays = Math.round((startOfDay(now) - startOfDay(d)) / 86_400_000)
  if (diffDays === 0) return 'Hari ini'
  if (diffDays === 1) return 'Kemarin'
  return d.toLocaleDateString('id-ID', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  })
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
