import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import * as rakStore from '../rakStore'
import { useNotifCounts } from '../notifCounts'
import { collectQueueItems, queueReaderHref, saveReadingQueue } from '../readingQueue'

/** Strip零-prop: dipasang induk di Rak (tab Favorit) dan Home bila perlu. */
export default function UpdateQueueStrip() {
  const navigate = useNavigate()
  const { unreadByTitle, latestByTitle } = useNotifCounts()
  const [favorites, setFavorites] = useState(() => rakStore.listFavorites())

  useEffect(() => {
    const onChange = () => setFavorites(rakStore.listFavorites())
    window.addEventListener('rak-change', onChange)
    return () => window.removeEventListener('rak-change', onChange)
  }, [])

  // Hitung dari context + rak langsung (bukan snapshot provider yang perlu
  // satu commit tambahan) supaya strip tidak ketinggalan satu render.
  const queueItems = useMemo(
    () => collectQueueItems(favorites, unreadByTitle, latestByTitle),
    [favorites, unreadByTitle, latestByTitle],
  )
  if (queueItems.length === 0) return null

  const today = queueItems.filter((it) => it.isToday).length
  const others = queueItems.length - today

  return (
    <section
      aria-label="Update favorit"
      className="flex flex-wrap items-center gap-3 border-y border-ink-700/60 px-4 py-2"
    >
      <div className="min-w-0 flex-1">
        <p className="text-[13px] font-semibold text-ink-100">
          {queueItems.length} komik favorit ada update
        </p>
        {today > 0 && others > 0 && (
          <p className="text-[11px] text-ink-300">
            {today} rilis hari ini · {others} lainnya
          </p>
        )}
      </div>
      <button
        type="button"
        className="kh-tap inline-flex min-h-11 shrink-0 items-center rounded-xl bg-brand-amber px-4 text-[13px] font-bold text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-amber"
        onClick={() => {
          const state = { active: true, items: queueItems, currentIndex: 0 }
          saveReadingQueue(state)
          navigate(queueReaderHref(queueItems[0]))
        }}
      >
        Baca Antrean →
      </button>
    </section>
  )
}
