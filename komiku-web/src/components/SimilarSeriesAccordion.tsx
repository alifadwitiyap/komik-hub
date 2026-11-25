import { useEffect, useId, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { unifiedApi, usableCoverUrl } from '../api'
import { imgUrl } from '../imgUrl'
import type { SimilarItem } from '../types'

interface SimilarSeriesAccordionProps {
  handle: string
}

function storageKey(handle: string): string {
  return `komik:similar-series:${handle}`
}

function readCached(handle: string): SimilarItem[] | null {
  try {
    const raw = sessionStorage.getItem(storageKey(handle))
    if (!raw) return null
    const value: unknown = JSON.parse(raw)
    if (!Array.isArray(value)) return null
    return value as SimilarItem[]
  } catch {
    return null
  }
}

function writeCached(handle: string, items: SimilarItem[]): void {
  try {
    sessionStorage.setItem(storageKey(handle), JSON.stringify(items))
  } catch {
    // Storage may be disabled or full; the in-memory result remains usable.
  }
}

export default function SimilarSeriesAccordion({ handle }: SimilarSeriesAccordionProps) {
  const panelId = useId()
  const [isOpen, setIsOpen] = useState(false)
  const [items, setItems] = useState<SimilarItem[] | null>(() => readCached(handle))
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(false)
  const controllerRef = useRef<AbortController | null>(null)
  const requestedRef = useRef(false)

  const request = () => {
    if (controllerRef.current) return
    const controller = new AbortController()
    controllerRef.current = controller
    setLoading(true)
    setError(false)
    unifiedApi.similar(handle, controller.signal)
      .then((response) => {
        const items = response.items.map((item) => ({
          ...item,
          cover_url: usableCoverUrl(item.cover_url),
        }))
        setItems(items)
        writeCached(handle, items)
      })
      .catch((reason: unknown) => {
        if (reason instanceof Error && reason.name === 'AbortError') return
        setError(true)
      })
      .finally(() => {
        controllerRef.current = null
        setLoading(false)
      })
  }

  useEffect(() => {
    if (isOpen && items === null && !requestedRef.current) {
      requestedRef.current = true
      request()
    }
  }, [isOpen, items, handle])

  useEffect(() => () => controllerRef.current?.abort(), [])

  const retry = () => {
    requestedRef.current = true
    request()
  }

  return (
    <section className="mt-2 border-y border-ink-800 bg-ink-950" aria-label="Komik sejenis">
      <button
        type="button"
        className="similar-trigger flex min-h-12 w-full items-center justify-between gap-3 px-4 py-2.5 text-left"
        aria-expanded={isOpen}
        aria-controls={panelId}
        onClick={() => setIsOpen((open) => !open)}
      >
        <span className="min-w-0">
          <span className="block text-[13px] font-semibold text-ink-100">Komik Sejenis</span>
          <span className="mt-0.5 block truncate text-[11.5px] text-ink-500">Lihat judul dengan genre &amp; nuansa serupa</span>
        </span>
        <svg className="similar-chevron size-[18px] shrink-0 text-ink-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="m6 9 6 6 6-6" />
        </svg>
      </button>

      <div id={panelId} className="similar-panel" data-open={isOpen} aria-hidden={!isOpen}>
        <div className="similar-panel-inner min-h-0">
          {loading && (
            <div className="flex gap-3 overflow-hidden px-4 pb-4 pt-1" aria-label="Memuat saran sejenis" role="status">
              {Array.from({ length: 4 }, (_, index) => (
                <div key={index} className="w-[118px] shrink-0" aria-hidden="true">
                  <div className="skeleton-shimmer aspect-[2/3] rounded-[10px]" />
                  <div className="skeleton-shimmer mt-2 h-8 rounded" />
                  <div className="skeleton-shimmer mt-1 h-4 w-4/5 rounded" />
                </div>
              ))}
            </div>
          )}

          {!loading && error && (
            <div className="px-4 pb-4 pt-1 text-center">
              <p className="text-[12px] text-ink-400">Belum ada saran sejenis untuk judul ini</p>
              <button type="button" onClick={retry} className="mt-2 min-h-11 rounded-lg px-3 text-[12px] font-semibold text-brand-amber focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-amber">
                Coba lagi
              </button>
            </div>
          )}

          {!loading && !error && items !== null && items.length === 0 && (
            <p className="px-4 pb-4 pt-1 text-center text-[12px] text-ink-400">Belum ada saran sejenis untuk judul ini</p>
          )}

          {!loading && !error && items !== null && items.length > 0 && (
            <div className="no-bar flex snap-x snap-mandatory gap-3 overflow-x-auto px-4 pb-4 pt-1">
              {items.map((item) => (
                <Link key={item.handle} to={`/manga/${encodeURIComponent(item.handle)}`} className="similar-card w-[118px] shrink-0 snap-start focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-amber">
                  <div className="relative aspect-[2/3] overflow-hidden rounded-[10px] bg-ink-850">
                    {item.cover_url ? <img src={imgUrl(item.cover_url)} alt="" loading="lazy" className="size-full object-cover" /> : <span className="grid size-full place-items-center p-2 text-center text-[11px] text-ink-500">{item.title}</span>}
                    {item.last_chapter && <span className="absolute right-1 top-1 rounded bg-black/70 px-1 py-0.5 text-[9px] font-semibold text-white">Ch. {item.last_chapter}</span>}
                  </div>
                  <p className="mt-2 min-h-[2.5em] line-clamp-2 text-[13.5px] font-semibold leading-snug text-ink-100">{item.title}</p>
                  <p className="line-clamp-1 text-[12px] text-[#4A5260] dark:text-[#A8B1C2]">{item.reason}</p>
                </Link>
              ))}
            </div>
          )}
        </div>
      </div>
    </section>
  )
}
