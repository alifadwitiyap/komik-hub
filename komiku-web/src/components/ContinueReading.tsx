import { memo, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { imgUrl } from '../imgUrl'
import { sourceLabel } from './SourceBadge'
import * as rakStore from '../rakStore'
import { resolveResumeTarget } from '../progressResume'
import { useProgress, type ProgressEntry } from '../hooks/useProgress'
import { useMarathonMemory } from '../hooks/useMarathonMemory'
import { marathonHref, resumeHref } from '../readerSource'

/** Lanjut membaca: SATU kartu ringkas di atas carousel + tautan Rak. */
const MAX_CARDS = 6

type Item = {
  key: string
  title: string
  cover: string | null
  chapter: string
  page: number | null
  progress: number | null
  source: string | null
  href: string
}

function buildItems(): Item[] {
  const history = rakStore.listHistory()
  const { recent } = useProgress()
  const marathon = useMarathonMemory()

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
        progress: Math.min(1, Math.max(0, p.progress)),
        source: p.source ?? entry.source,
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
        source: entry.source,
        href,
      })
      if (items.length >= MAX_CARDS) break
    }
  }
  return items
}

const ContinueReading = memo(function ContinueReading() {
  // Bangun ulang saat history berubah (unduhan/bacaan menulis event rak-change).
  const [tick, setTick] = useState(0)
  useEffect(() => {
    const onRak = () => setTick((t) => t + 1)
    window.addEventListener('rak-change', onRak)
    return () => window.removeEventListener('rak-change', onRak)
  }, [])
  void tick

  const items = buildItems()
  if (items.length === 0) return null
  const latest = items[0]

  return (
    <section className="mt-5">
      <div className="flex items-baseline justify-between px-4">
        <h2 className="font-display text-[14.5px] font-semibold text-ink-100">Lanjut membaca</h2>
        <Link
          to="/rak?tab=sejarah"
          aria-label="Lihat semua riwayat baca"
          className="-mx-2 grid min-h-11 min-w-11 place-items-center px-2 py-3 text-[12px] font-semibold text-brand-amber"
        >
          Lihat semua
        </Link>
      </div>
      <div className="mt-3 px-4">
        <ResumeCard item={latest} />
      </div>
    </section>
  )
})

export default ContinueReading

function ResumeCard({ item }: { item: Item }) {
  const [src, setSrc] = useState(() => item.cover ? imgUrl(item.cover) : '')
  const source = sourceLabel(item.source)

  return (
    <Link
      to={item.href}
      data-testid="continue-reading-card"
      className="flex min-h-20 items-center gap-3 rounded-2xl border border-ink-800 bg-ink-900 p-3 active:bg-ink-850 tactile-press"
    >
      <span className="size-16 shrink-0 overflow-hidden rounded-xl relative border border-ink-800 bg-ink-850">
        {src ? (
          <img
            referrerPolicy="no-referrer"
            src={src}
            alt=""
            loading="lazy"
            decoding="async"
            onError={() => setSrc('')}
            className="size-full object-cover card-cover"
          />
        ) : (
          <span className="grid size-full place-items-center text-[18px] font-bold text-ink-500">{item.title.slice(0, 1)}</span>
        )}
        {item.progress != null && (
          <span aria-hidden="true" className="absolute inset-x-0 bottom-0 h-[3px] bg-black/40">
            <span
              className="block size-full origin-left bg-brand-amber transition-transform duration-[var(--dur-ui)] ease-[var(--ease-out-quint)]"
              style={{ transform: `scaleX(${item.progress})` }}
            />
          </span>
        )}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate font-display text-[13px] font-semibold text-ink-100">{item.title}</span>
        <span className="mt-0.5 flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-[11.5px] text-ink-400">
          <span className="truncate">{item.chapter}{item.page != null ? ` · Hal. ${item.page + 1}` : ''}</span>
          {source && (
            <span data-resume-source className="shrink-0 rounded bg-ink-800 px-1.5 py-0.5 text-[10px] font-semibold text-ink-300">
              {source}
            </span>
          )}
        </span>
        <span className="mt-1 inline-flex min-h-7 items-center rounded-lg bg-brand-amber px-2.5 text-[11.5px] font-bold text-white">
          Lanjut baca
        </span>
      </span>
    </Link>
  )
}
