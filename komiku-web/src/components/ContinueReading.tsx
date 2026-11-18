import { memo, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { imgUrl } from '../imgUrl'
import * as rakStore from '../rakStore'
import { resolveResumeTarget } from '../progressResume'
import { useProgress, type ProgressEntry } from '../hooks/useProgress'
import { useMarathonMemory } from '../hooks/useMarathonMemory'
import { marathonHref, resumeHref } from '../readerSource'

/** Lanjut membaca memakai progres kanonik yang sama dengan Rak/detail. */
const MAX_CARDS = 6

type Item = {
  key: string
  title: string
  cover: string | null
  chapter: string
  page: number | null
  progress: number | null
  href: string
}

const ContinueReading = memo(function ContinueReading() {
  const [history, setHistory] = useState(() => rakStore.listHistory())
  const { recent } = useProgress()
  const marathon = useMarathonMemory()

  useEffect(() => {
    const onRak = () => setHistory(rakStore.listHistory())
    window.addEventListener('rak-change', onRak)
    return () => window.removeEventListener('rak-change', onRak)
  }, [])

  // Index both source handles ("source:id") and legacy numeric IDs.
  const byHandle = new Map<string, rakStore.HistoryEntry>()
  for (const entry of history) {
    byHandle.set(String(entry.handle), entry)
    const suffix = String(entry.handle).split(':').pop()
    if (suffix) byHandle.set(suffix, entry)
  }

  const items: Item[] = recent
    .flatMap((p: ProgressEntry): Array<Item & { at: number }> => {
      const handle = String(p.handle ?? p.seriesId)
      const entry = byHandle.get(handle) ?? byHandle.get(String(p.seriesId))
      if (!entry) return []
      const pos = marathon.forHandle(entry.handle)
      const target = resolveResumeTarget(p, pos)
      if (!target) return []
      const href = target.mode === 'marathon' && pos
        ? marathonHref(pos.chapterKey)
        : target.href
      return [{
        key: entry.title_key,
        title: entry.title,
        cover: entry.cover_url,
        chapter: pos?.activeKey
          ? `Chapter ${pos.activeKey.split(':').pop()}`
          : p.chapterName || `Chapter ${target.chapterId}`,
        page: target.page,
        progress: Math.max(0, Math.min(1, p.progress || 0)),
        href,
        at: p.at,
      }]
    })
    .sort((a, b) => b.at - a.at)
    .slice(0, MAX_CARDS)
    .map(({ at: _at, ...item }) => item)

  // Riwayat lama tanpa catatan progres tetap bisa dilanjutkan dari chapter terakhir.
  if (items.length < MAX_CARDS) {
    for (const entry of history) {
      if (items.some((item) => item.key === entry.title_key)) continue
      const pos = marathon.forHandle(entry.handle)
      const href = pos ? marathonHref(pos.chapterKey) : resumeHref(entry)
      if (!href) continue
      items.push({
        key: entry.title_key,
        title: entry.title,
        cover: entry.cover_url,
        chapter: `Chapter ${entry.last_chapter}`,
        page: null,
        progress: null,
        href,
      })
      if (items.length >= MAX_CARDS) break
    }
  }

  if (items.length === 0) return null

  return (
    <section className="mt-5">
      <div className="flex items-baseline justify-between px-4">
        <h2 className="font-display text-[14.5px] font-semibold text-ink-100">Lanjut membaca</h2>
        <Link to="/rak?tab=sejarah" className="grid min-h-11 min-w-11 place-items-center px-2 py-3 -mx-2 text-[12px] font-semibold text-brand-amber">
          Lihat semua
        </Link>
      </div>
      <div className="mt-3 grid grid-cols-2 gap-3 px-4">
        {items.map((item) => <Card key={item.key} item={item} />)}
      </div>
    </section>
  )
})

export default ContinueReading

function Card({ item }: { item: Item }) {
  const [failed, setFailed] = useState(false)
  const src = item.cover ? imgUrl(item.cover) : ''

  return (
    <Link to={item.href} className="group block">
      <div className="relative aspect-[62/82] overflow-hidden rounded-xl border border-ink-800 bg-ink-850">
        {src && !failed ? (
          <img referrerPolicy="no-referrer" src={src} alt={item.title} loading="lazy" decoding="async" onError={() => setFailed(true)} className="size-full object-cover card-cover" />
        ) : (
          <span className="grid size-full place-items-center px-2 text-center text-[12px] font-bold text-ink-500">{item.title.slice(0, 1)}</span>
        )}
      </div>
      <p className="mt-2 line-clamp-2 font-display text-[12.5px] font-medium leading-snug text-ink-100">{item.title}</p>
      <p className="mt-0.5 truncate text-[11.5px] text-ink-400">{item.chapter}</p>
      <p className="mt-0.5 truncate text-[11px] text-ink-500">
        {item.page == null ? <span className="font-semibold text-brand-amber">Lanjut</span> : <>Halaman {item.page + 1} · <span className="font-semibold text-brand-amber">Lanjut</span></>}
      </p>
      {item.progress != null && (
        <div className="mt-1.5 h-1 w-full overflow-hidden rounded-full bg-ink-800">
          <div className="h-full rounded-full bg-brand-amber" style={{ width: `${Math.round(item.progress * 100)}%` }} />
        </div>
      )}
    </Link>
  )
}
