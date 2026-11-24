import { useEffect, useRef, useState } from 'react'
import { imgUrl } from '../imgUrl'
import type { QueueItem } from '../readingQueue'

interface Props {
  item: QueueItem
  index: number
  total: number
  onNext: () => void
  onOpenDrawer: () => void
  onFinish: () => void
}

/** Kartu transisi antar-seri: murni 1 ketuk, TANPA auto-redirect. */
export default function QueueNextCard({ item, index, total, onNext, onOpenDrawer, onFinish }: Props) {
  const cover = item.coverUrl ? imgUrl(item.coverUrl) : ''
  const imgRef = useRef<HTMLImageElement | null>(null)
  const [coverFailed, setCoverFailed] = useState(false)

  useEffect(() => {
    setCoverFailed(false)
    if (!cover) return
    // CDN bisa menggantung tanpa error event — timer jaring pengaman.
    const timer = window.setTimeout(() => {
      if (!imgRef.current?.complete || imgRef.current.naturalWidth === 0) setCoverFailed(true)
    }, 4000)
    return () => window.clearTimeout(timer)
  }, [cover])

  return (
    <section className="relative z-20 mx-auto w-full max-w-3xl px-4 pt-5" aria-label="Antrean baca berikutnya">
      <div className="rounded-2xl border border-ink-700/60 bg-night-dark/80 p-4 text-white">
        <p className="mb-3 text-[11px] font-semibold uppercase tracking-wide text-neutral-400">
          Selesai di seri ini · Antrean {index + 1} dari {total}
        </p>
        <div className="flex items-start gap-3">
          {cover && !coverFailed ? (
            <img
              ref={imgRef}
              src={cover}
              alt=""
              width={48}
              height={72}
              referrerPolicy="no-referrer"
              onError={() => setCoverFailed(true)}
              className="h-[72px] w-12 shrink-0 rounded object-cover"
            />
          ) : (
            <div
              aria-hidden="true"
              className="flex h-[72px] w-12 shrink-0 items-center justify-center rounded bg-ink-800 text-lg font-bold text-neutral-200"
            >
              {item.title.slice(0, 1).toUpperCase()}
            </div>
          )}
          <div className="min-w-0 flex-1">
            <p className="line-clamp-2 text-[14px] font-bold leading-snug">{item.title}</p>
            <p className="mt-1 text-[12px] text-neutral-300">
              Ch. {item.targetChapter} (+{item.unreadCount} baru)
            </p>
          </div>
        </div>

        <button
          type="button"
          onClick={onNext}
          className="kh-tap mt-4 flex min-h-12 w-full items-center justify-center rounded-xl bg-brand-amber px-4 text-center text-[14px] font-bold text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-amber focus-visible:ring-offset-2 focus-visible:ring-offset-night-dark"
        >
          Lanjut ke {item.title} →
        </button>
        <div className="mt-2 flex items-center justify-center gap-4">
          <button
            type="button"
            onClick={onOpenDrawer}
            className="kh-tap min-h-11 rounded px-2 text-[12px] font-semibold text-neutral-200 underline-offset-2 active:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-amber"
          >
            Lihat sisa antrean ({total - index - 1})
          </button>
          <button
            type="button"
            onClick={onFinish}
            className="kh-tap min-h-11 rounded px-2 text-[12px] font-semibold text-neutral-300 underline-offset-2 active:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-amber"
          >
            Selesai
          </button>
        </div>
      </div>
    </section>
  )
}
