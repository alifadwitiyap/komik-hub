import { useSearchParams } from 'react-router-dom'

/**
 * Baris filter sumber + urutan (kontrak feature sort-rating / filter-sumber).
 *
 * - Chip sumber: Semua | Komiku | Mangaku | Shinigami | Kiryuu.
 * - Dropdown urut: Terbaru | Rating tertinggi | Trending.
 *
 * State hidup di URL (`?source=&sort=`): refresh tidak kehilangan filter dan
 * back/forward berfungsi. Nilai default (semua/terbaru) TIDAK ditulis ke URL
 * supaya query tetap pendek dan kompatibel dengan server lama yang belum tahu
 * param ini (diabaikan diam-diam oleh serde).
 */

/** Sumber yang dikenal UI (id = nilai query `?source=`). */
export const SOURCES = [
  { id: 'semua', label: 'Semua' },
  { id: 'komiku', label: 'Komiku' },
  { id: 'mangaku', label: 'Mangaku' },
  { id: 'shinigami', label: 'Shinigami' },
  { id: 'kiryuu', label: 'Kiryuu' },
] as const

/** Pilihan urutan (value = nilai query `?sort=`). */
export const SORTS = [
  { value: 'terbaru', label: 'Terbaru' },
  { value: 'rating', label: 'Rating tertinggi' },
  { value: 'trending', label: 'Trending' },
] as const

/** Nilai default — tidak ditulis ke URL (server sudah pakai ini). */
const DEFAULT_SOURCE = 'semua'
const DEFAULT_SORT = 'terbaru'

/** Baca sumber aktif dari URL ('' / 'komiku' / …). */
export function useSourceFilter(): string {
  const [params] = useSearchParams()
  return params.get('source') ?? DEFAULT_SOURCE
}

/** Baca urutan aktif dari URL ('terbaru' / 'rating' / 'trending'). */
export function useSortFilter(): string {
  const [params] = useSearchParams()
  return params.get('sort') ?? DEFAULT_SORT
}

export function SourceSortBar() {
  const [params, setParams] = useSearchParams()
  const source = useSourceFilter()
  const sort = useSortFilter()

  /** Tulis satu field ke URL; nilai default dihapus (query tetap pendek). */
  const setField = (key: string, value: string) => {
    const next = new URLSearchParams(params)
    const isDefault =
      (key === 'source' && value === DEFAULT_SOURCE) ||
      (key === 'sort' && value === DEFAULT_SORT)
    if (isDefault) next.delete(key)
    else next.set(key, value)
    setParams(next)
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      {/* chip sumber */}
      <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label="Filter sumber">
        {SOURCES.map((s) => (
          <button
            key={s.id}
            type="button"
            aria-pressed={source === s.id}
            onClick={() => setField('source', s.id)}
            className={`rounded-full px-3 py-1.5 text-[12px] font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-amber focus-visible:ring-offset-2 ${
              source === s.id
                ? 'bg-brand-amber text-ink-950'
                : 'border border-ink-800 bg-ink-900 text-ink-300 hover:border-ink-700'
            }`}
          >
            {s.label}
          </button>
        ))}
      </div>

      {/* dropdown urutan */}
      <div className="relative ml-auto">
        <select
          aria-label="Urutkan"
          value={sort}
          onChange={(e) => setField('sort', e.target.value)}
          className="appearance-none rounded-full border border-ink-300 bg-ink-900 py-1.5 pl-3.5 pr-8 text-[12px] font-medium text-ink-100 focus:border-brand-amber focus:outline-none"
        >
          {SORTS.map((s) => (
            <option key={s.value} value={s.value}>
              {s.label}
            </option>
          ))}
        </select>
        <svg
          aria-hidden="true"
          viewBox="0 0 20 20"
          fill="currentColor"
          className="pointer-events-none absolute right-2.5 top-1/2 size-3.5 -translate-y-1/2 text-ink-500"
        >
          <path
            fillRule="evenodd"
            d="M5.23 7.21a.75.75 0 011.06.02L10 11.17l3.71-3.94a.75.75 0 111.08 1.04l-4.25 4.5a.75.75 0 01-1.08 0l-4.25-4.5a.75.75 0 01.02-1.06z"
            clipRule="evenodd"
          />
        </svg>
      </div>
    </div>
  )
}
