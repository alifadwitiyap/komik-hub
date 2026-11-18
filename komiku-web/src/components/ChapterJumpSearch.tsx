import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { useReadMarks } from '../hooks/useReadMarks'
import { chapterNumberOf } from '../readMarks'
import { readerHref, unifiedKey } from '../readerSource'
import type { Chapter, UnifiedChapterOut } from '../types'
import { sourceLabel } from './SourceBadge'

/**
 * Pencarian + daftar nomor chapter untuk halaman detail (P1 search-ux).
 *
 * Komponen ini sengaja mandiri: Series.tsx / SeriesUnified.tsx adalah milik
 * subagent lain. Cara mount ada di ringkasan implementasi — terima `chapters`
 * (UnifiedChapterOut[] ATAU Chapter[] legacy) + `titleKey`, render tepat di
 * atas daftar chapter, sebelum logika `showAll`.
 *
 * Aturan penting:
 * - NOMOR chapter adalah STRING mentah. Pencarian memakai `includes` pada
 *   string trim, TANPA `Number()` / normalisasi desimal: `00.1` harus cocok
 *   persis `00.1`, bukan `0.1` / `0` / `1`. Label ditampilkan apa adanya.
 * - Urutan "lama" / "terbaru" hanya memakai perbandingan numerik untuk
 *   sorting; tie-break localeCompare(numeric) + nomor mentah menjaga dua
 *   entri dengan nilai numerik sama tetap stabil.
 * - Status baca memakai `useReadMarks(titleKey)` (sumber kebenaran yang sama
 *   dengan halaman detail/reader).
 */

export type ChapterJumpItem = UnifiedChapterOut | Chapter

export interface ChapterJumpSearchProps {
  chapters: ChapterJumpItem[]
  /** title_key series, dipakai useReadMarks untuk status baca. */
  titleKey?: string | null
  /** Urutan awal daftar. Default 'terbaru'. */
  defaultSort?: 'lama' | 'terbaru'
  /** Judul kecil di atas kotak pencarian. Default 'Cari nomor chapter'. */
  label?: string
}

type Row = {
  key: string
  number: string
  title: string
  href: string
  source: string | null
}

/** Ambil nomor mentah (string) dari chapter unified maupun legacy. */
export function chapterNumberRaw(c: ChapterJumpItem): string {
  const raw = chapterNumberOf(c)
  return raw ?? ''
}

/**
 * Cocokkan query ke nomor chapter mentah. Diekspor supaya bisa diuji tanpa
 * render (vitest default node, tanpa jsdom).
 *
 * `00.1` tetap `00.1`: tidak ada parseInt/Number di jalur ini.
 */
export function matchChapterNumber(number: string, query: string): boolean {
  const needle = query.trim().toLowerCase()
  if (!needle) return true
  return number.trim().toLowerCase().includes(needle)
}

/**
 * Urutkan baris chapter. `lama` = menaik, `terbaru` = menurun.
 * Nomor bukan angka (mis. 'extra-9') ditempatkan di akhir untuk 'lama',
 * di awal untuk 'terbaru' sebelum entri bernomor.
 */
export function sortChapterRows<T extends { number: string }>(rows: T[], order: 'lama' | 'terbaru'): T[] {
  const sign = order === 'lama' ? 1 : -1
  return [...rows].sort((a, b) => {
    const an = Number(a.number)
    const bn = Number(b.number)
    const aNum = Number.isFinite(an) && a.number.trim() !== ''
    const bNum = Number.isFinite(bn) && b.number.trim() !== ''
    if (aNum !== bNum) return sign * (aNum ? -1 : 1)
    if (aNum && bNum && an !== bn) return sign * (an - bn)
    return sign * a.number.localeCompare(b.number, 'id', { numeric: true })
  })
}

/** Bangun baris + href reader. Nomor tidak pernah diparse. */
export function toChapterRows(chapters: ChapterJumpItem[]): Row[] {
  return chapters.map((c, i) => {
    const number = chapterNumberRaw(c)
    const isUnified = 'handle' in c && Boolean(c.handle) && number !== ''
    const key = isUnified
      ? unifiedKey((c as UnifiedChapterOut).handle, number)
      : String((c as Chapter).id ?? i)
    const title =
      ('title' in c && c.title) ||
      ('name' in c && c.name) ||
      (number ? `Chapter ${number}` : `Chapter ${i + 1}`)
    const source = ('source' in c && c.source) || null
    return { key, number, title, href: readerHref(key), source }
  })
}

export default function ChapterJumpSearch({
  chapters,
  titleKey,
  defaultSort = 'terbaru',
  label = 'Cari nomor chapter',
}: ChapterJumpSearchProps) {
  const [query, setQuery] = useState('')
  const [order, setOrder] = useState<'lama' | 'terbaru'>(defaultSort)
  const [unreadOnly, setUnreadOnly] = useState(false)
  const { isRead } = useReadMarks(titleKey)

  const rows = useMemo(() => toChapterRows(chapters), [chapters])
  const visible = useMemo(() => {
    const filtered = rows.filter(
      (r) => matchChapterNumber(r.number, query) && (!unreadOnly || !isRead(r.number)),
    )
    const sorted = sortChapterRows(filtered, order)
    // Nomor yang persis sama dengan query didahulukan: cari "00.1" harus
    // membuka "00.1", bukan "0.1"/"100.1" yang cuma kebetulan mengandungnya.
    const needle = query.trim().toLowerCase()
    if (!needle) return sorted
    return [
      ...sorted.filter((r) => r.number.trim().toLowerCase() === needle),
      ...sorted.filter((r) => r.number.trim().toLowerCase() !== needle),
    ]
  }, [rows, query, unreadOnly, isRead, order])

  return (
    <section data-chapter-jump className="mb-3 rounded-2xl border border-ink-800 bg-ink-900/60 p-3">
      <div className="flex flex-wrap items-center gap-2">
        <label htmlFor="chapter-jump-q" className="text-[12px] font-bold text-ink-300">
          {label}
        </label>
        <input
          id="chapter-jump-q"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="mis. 00.1"
          inputMode="search"
          enterKeyHint="search"
          className="min-h-11 min-w-0 flex-1 rounded-full border border-ink-300 bg-ink-900 px-3.5 text-base text-ink-100 placeholder:text-ink-500 focus:border-brand-amber focus:outline-none"
        />
      </div>

      <div className="mt-2 flex flex-wrap items-center gap-2">
        <button
          type="button"
          aria-pressed={order === 'lama'}
          onClick={() => setOrder('lama')}
          className={`min-h-11 rounded-full px-3 py-1.5 text-[12px] font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-amber ${
            order === 'lama' ? 'bg-brand-amber text-white' : 'border border-ink-800 text-ink-300'
          }`}
        >
          Terlama
        </button>
        <button
          type="button"
          aria-pressed={order === 'terbaru'}
          onClick={() => setOrder('terbaru')}
          className={`min-h-11 rounded-full px-3 py-1.5 text-[12px] font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-amber ${
            order === 'terbaru' ? 'bg-brand-amber text-white' : 'border border-ink-800 text-ink-300'
          }`}
        >
          Terbaru
        </button>
        <button
          type="button"
          aria-pressed={unreadOnly}
          onClick={() => setUnreadOnly((v) => !v)}
          className={`min-h-11 rounded-full px-3 py-1.5 text-[12px] font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-amber ${
            unreadOnly ? 'bg-brand-amber text-white' : 'border border-ink-800 text-ink-300'
          }`}
        >
          Belum dibaca
        </button>
      </div>

      <p data-chapter-jump-count className="mt-2 text-[12px] text-ink-500">
        {visible.length} entri chapter
        {query ? ` untuk “${query}”` : ''}
        {rows.length > 0 && new Set(rows.map((r) => r.source).filter(Boolean)).size > 1
          ? ' · dari beberapa sumber'
          : ''}
      </p>

      {visible.length === 0 ? (
        <p className="py-3 text-center text-[13px] text-ink-500">
          Tidak ada chapter yang cocok.
        </p>
      ) : (
        <ul data-chapter-jump-results className="mt-1 max-h-72 space-y-1 overflow-y-auto">
          {visible.map((r) => (
            <li key={r.key}>
              <Link
                to={r.href}
                className="flex min-h-11 items-center justify-between gap-2 rounded-lg px-2 py-1.5 text-[13px] text-ink-200 transition-colors active:bg-ink-800 [@media(hover:hover)]:hover:bg-ink-800"
              >
                <span className="min-w-0 truncate">
                  <b className="text-ink-100">{r.number || '—'}</b>
                  {r.title && !r.title.includes(r.number) ? ` · ${r.title}` : ''}
                </span>
                <span className="flex shrink-0 items-center gap-1.5">
                  {isRead(r.number) && (
                    <span className="rounded bg-ink-800 px-1.5 py-0.5 text-[10px] text-ink-400">
                      dibaca
                    </span>
                  )}
                  {r.source && <span className="text-[10px] text-ink-500">{sourceLabel(r.source)}</span>}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
