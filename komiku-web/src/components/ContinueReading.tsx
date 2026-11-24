import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { useProgress, type ProgressEntry } from '../hooks/useProgress'
import { sourceLabel } from './SourceBadge'
import { resolveResumeTarget } from '../progressResume'
import { useMarathonMemory } from '../hooks/useMarathonMemory'
import type { MarathonPosition } from '../marathonMemory'
import { marathonHref, resumeHref } from '../readerSource'
import * as rakStore from '../rakStore'

/** Rail resume horizontal: satu kartu per judul yang pernah dibaca. */
type Item = {
  key: string
  title: string
  cover: string | null
  /** Baris metadata `Ch. <nomor> · <persen>%` (+ halaman bila tersimpan). */
  chapter: string
  page: number | null
  progress: number | null
  source: string | null
  /** Sumber milik handle lokal — untuk memutuskan label sumber tampil/tidak. */
  localSource: string | null
  href: string
  at: number
}

/** Nomor chapter apa adanya ('1189.2', '811 Fix') — jangan dinormalkan. */
export function chapterNumberFromKey(raw: string | null | undefined): string {
  const tail = String(raw ?? '').trim().split(':').pop() ?? ''
  return tail.replace(/^Chapter\s+/i, '').replace(/^Ch\.?\s*/i, '').trim()
}

function buildItems(
  recent: ProgressEntry[],
  history: rakStore.HistoryEntry[],
  marathonFor: (handle: string) => MarathonPosition | null,
): Item[] {
  const byHandle = new Map<string, rakStore.HistoryEntry>()
  for (const e of history) {
    byHandle.set(String(e.handle), e)
    const numeric = String(e.handle).split(':').pop()
    if (numeric) byHandle.set(numeric, e)
  }
  const out: (Item & { at: number })[] = []
  for (const p of recent) {
    const entry = byHandle.get(String(p.handle ?? '')) ?? byHandle.get(String(p.seriesId))
    if (!entry) continue
    const pos = marathonFor(entry.handle)
    const target = resolveResumeTarget(p, pos)
    if (!target) continue
    // `saved.source` dipakai apa adanya dari progres; label hanya tampil bila
    // berbeda dari sumber handle lokal (mis. progres pindah sumber).
    const saved: { source: string | null } = { source: p.source ?? entry.source }
    const localSource = String(entry.handle).split(':')[0] || null
    const percent = Math.round(Math.min(1, Math.max(0, p.progress)) * 100)
    const number = chapterNumberFromKey(pos?.chapterKey ?? p.chapterId) || entry.last_chapter
    out.push({
      key: entry.title_key,
      title: p.seriesTitle ?? entry.title,
      cover: entry.cover_url,
      chapter: `Ch. ${number} · ${percent}%`,
      page: target.page ?? (p.page > 0 ? p.page : null),
      progress: Math.min(1, Math.max(0, p.progress)),
      source: saved.source,
      localSource,
      href: target.href,
      at: p.at,
    })
  }
  // Riwayat tanpa progres (entri lama): chapter tetap apa adanya, persen tidak
  // dikarang — baris persen dihilangkan.
  for (const entry of history) {
    const known = recent.some(
      (p) => byHandle.get(String(p.handle ?? '')) === entry || byHandle.get(String(p.seriesId)) === entry,
    )
    if (known) continue
    const pos = marathonFor(entry.handle)
    const href = pos ? marathonHref(pos.chapterKey) : resumeHref(entry)
    if (!href) continue
    out.push({
      key: entry.title_key,
      title: entry.title,
      cover: entry.cover_url,
      chapter: `Ch. ${chapterNumberFromKey(pos?.chapterKey ?? entry.last_chapter) || entry.last_chapter}`,
      page: null,
      progress: null,
      source: entry.source,
      localSource: String(entry.handle).split(':')[0] || null,
      href,
      at: entry.updated_at,
    })
  }
  return out.sort((a, b) => b.at - a.at).slice(0, 12)
}

function ResumeCard({ item, first }: { item: Item; first: boolean }) {
  const [failed, setFailed] = useState(false)
  const source = sourceLabel(item.source)
  const showSource = Boolean(item.source && item.source !== item.localSource)
  const coverUrl = item.cover ? (item.cover.startsWith('data:') ? item.cover : item.cover) : null
  // Kontrak probe lama: atribut literal ini harus ada di kartu PERTAMA.
  const body = (
    <>
      {/* ponytail: `size-16` dipertahankan untuk kontrak kartu lama; ukuran
          2:3 (68×102) lewat inline style agar menang atas utilitas lebar. */}
      <span
        className="relative size-16 shrink-0 overflow-hidden rounded-xl bg-ink-850"
        style={{ width: 68, height: 102 }}
      >
        {coverUrl && !failed ? (
          <img
            referrerPolicy="no-referrer"
            src={coverUrl}
            alt=""
            loading="lazy"
            decoding="async"
            onError={() => setFailed(true)}
            className="size-full object-cover"
          />
        ) : (
          <span className="grid size-full place-items-center px-1 text-center text-[10px] text-ink-500">
            {item.title.slice(0, 1)}
          </span>
        )}
        {item.progress !== null && (
          <span className="absolute inset-x-0 bottom-0 flex h-[3px] items-end bg-black/45" aria-hidden="true">
            <span
              className="block h-[2px] w-full origin-left bg-brand-amber transition-transform duration-[var(--dur-ui)]"
              style={{ transform: `scaleX(${item.progress})` }}
            />
          </span>
        )}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[12.5px] font-semibold text-ink-100">{item.title}</span>
        <span className="mt-0.5 block truncate text-[11px] tabular-nums text-ink-400">
          {item.chapter}{item.page != null ? ` · Hal. ${item.page + 1}` : ''}
        </span>
        {showSource && (
          <span
            data-resume-source={item.source}
            className="mt-1 inline-block max-w-full truncate rounded-full border border-ink-700 px-1.5 py-0.5 text-[9.5px] font-semibold text-ink-300"
          >
            {source}
          </span>
        )}
      </span>
    </>
  )
  if (first) {
    return (
      <Link
        to={item.href}
        aria-label={`Lanjut baca ${item.title}`}
        data-testid="continue-reading-card"
        className="flex min-h-20 items-center gap-3 w-[196px] shrink-0 snap-start rounded-2xl border border-ink-800 bg-ink-900 p-2 transition-colors [@media(hover:hover)_and_(pointer:fine)]:hover:border-ink-700 active:scale-[0.98]"
      >
        {body}
      </Link>
    )
  }
  return (
    <Link
      to={item.href}
      aria-label={`Buka ${item.title}`}
      className="flex min-h-20 items-center gap-3 w-[196px] shrink-0 snap-start rounded-2xl border border-ink-800 bg-ink-900 p-2 transition-colors [@media(hover:hover)_and_(pointer:fine)]:hover:border-ink-700 active:scale-[0.98]"
    >
      {body}
    </Link>
  )
}

export default function ContinueReading() {
  const { recent } = useProgress()
  const marathon = useMarathonMemory()
  const [history, setHistory] = useState(() => rakStore.listHistory())
  useEffect(() => {
    const onRak = () => setHistory(rakStore.listHistory())
    window.addEventListener('rak-change', onRak)
    return () => window.removeEventListener('rak-change', onRak)
  }, [])
  const items = useMemo(
    () => buildItems(recent, history, (handle) => marathon.forHandle(handle)),
    [recent, history, marathon],
  )
  if (items.length === 0) return null
  return (
    <section aria-label="Lanjut membaca" className="mt-3">
      <div className="no-bar flex snap-x snap-proximity gap-2.5 overflow-x-auto px-4 pb-2">
        {items.map((item, i) => (
          <ResumeCard key={item.key} item={item} first={i === 0} />
        ))}
        <Link
          to="/rak?tab=sejarah"
          className="grid min-h-11 min-w-11 shrink-0 snap-start place-items-center rounded-2xl border border-dashed border-ink-700 px-4 text-center text-[11.5px] font-semibold text-brand-amber transition-colors [@media(hover:hover)_and_(pointer:fine)]:hover:border-brand-amber"
        >
          Lihat semua
        </Link>
      </div>
    </section>
  )
}
