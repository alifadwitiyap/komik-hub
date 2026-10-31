import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { imgUrl } from '../imgUrl'
import * as rakStore from '../rakStore'
import { marathonHref, resumeHref } from '../readerSource'
import { useProgress } from '../hooks/useProgress'
import { useMarathonMemory } from '../hooks/useMarathonMemory'
import type { ProgressEntry } from '../hooks/useProgress'

/**
 * Section "Lanjut membaca" di Home — paritas `item_index_history` app:
 * satu RecyclerView grid spanCount=2 kartu riwayat baca. Sumber data =
 * rakStore.listHistory() (cover/judul/handle, urut updated_at desc) digabung
 * dengan progress terakhir per series dari useProgress. Kartu tanpa target
 * (handle kosong) tidak bisa diklik → dibuang agar tidak ada link mati.
 * Riwayat kosong → section tidak dirender sama sekali (tanpa placeholder).
 */
const MAX_CARDS = 6

export default function ContinueReading() {
  const [history, setHistory] = useState(() => rakStore.listHistory())
  const { recent } = useProgress()
  const marathon = useMarathonMemory()

  // re-render saat rak berubah — pola sama seperti FAB "Lanjut baca" di Home
  useEffect(() => {
    const onRak = () => setHistory(rakStore.listHistory())
    window.addEventListener('rak-change', onRak)
    return () => window.removeEventListener('rak-change', onRak)
  }, [])

  const items = history
    .flatMap((e) => {
      // Sesi maraton terakhir untuk series ini (kalau ada) menang: kartu harus
      // mengembalikan pembaca ke RANTAI yang sedang dia baca, bukan melemparnya
      // ke reader satu chapter yang membuat maraton terasa "hilang".
      const pos = marathon.forHandle(e.handle)
      const href = pos ? marathonHref(pos.chapterKey) : resumeHref(e)
      return href ? [{ entry: e, href }] : []
    })
    .slice(0, MAX_CARDS)

  if (items.length === 0) return null

  return (
    <section className="mt-5">
      <div className="flex items-baseline justify-between px-4">
        <h2 className="font-display text-[14.5px] font-semibold text-ink-100">
          Lanjut membaca
        </h2>
        <Link to="/rak" className="text-[12px] font-semibold text-brand-amber">
          Lihat semua
        </Link>
      </div>
      <div className="mt-3 grid grid-cols-2 gap-3 px-4">
        {items.map(({ entry, href }) => {
          // progress per series: seriesId = handle (Reader unified);
          // entri tanpa progress → chapter terakhir dari riwayat
          const p = recent.find(
            (r: ProgressEntry) => String(r.seriesId) === String(entry.handle),
          )
          const progress =
            p == null ? null : Math.max(0, Math.min(1, p.progress))
          return (
            <Card
              key={entry.title_key}
              to={href}
              cover={entry.cover_url}
              title={entry.title}
              chapter={p?.chapterName ?? `Chapter ${entry.last_chapter}`}
              progress={progress}
            />
          )
        })}
      </div>
    </section>
  )
}

function Card({
  to,
  cover,
  title,
  chapter,
  progress,
}: {
  to: string
  cover: string | null
  title: string
  chapter: string
  progress: number | null
}) {
  const [failed, setFailed] = useState(false)
  const src = cover ? imgUrl(cover) : ''

  return (
    <Link to={to} className="group block">
      {/* cover replika item_trend: rasio sampul 62/82, rounded-xl */}
      <div className="relative aspect-[62/82] overflow-hidden rounded-xl border border-ink-800 bg-ink-850">
        {src && !failed ? (
          <img referrerPolicy="no-referrer"
            src={src}
            alt={title}
            loading="lazy"
            decoding="async"
            onError={() => setFailed(true)}
            className="size-full object-cover transition-transform duration-300 group-hover:scale-[1.03]"
          />
        ) : (
          <span className="grid size-full place-items-center px-2 text-center text-[12px] font-bold text-ink-500">
            {title.slice(0, 1)}
          </span>
        )}
      </div>
      <p className="mt-2 line-clamp-2 font-display text-[12.5px] font-medium leading-snug text-ink-100">
        {title}
      </p>
      <p className="mt-0.5 truncate text-[11.5px] text-ink-400">{chapter}</p>
      {progress != null && (
        <div className="mt-1.5 h-1 w-full overflow-hidden rounded-full bg-ink-800">
          <div
            className="h-full rounded-full bg-brand-amber"
            style={{ width: `${Math.round(progress * 100)}%` }}
          />
        </div>
      )}
    </Link>
  )
}
