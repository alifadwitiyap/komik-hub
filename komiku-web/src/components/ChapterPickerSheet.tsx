import { useEffect, useMemo, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { usePickableChapters } from '../hooks/usePickableChapters'
import { useReadMarks } from '../hooks/useReadMarks'
import { marathonHref, readerHref } from '../readerSource'

export interface ChapterPickerSheetProps {
  open: boolean
  onClose: () => void
  /** kunci chapter acuan — menentukan flow (unified/legacy) + series tujuan */
  chapterKey: string | null
  /** id manga legacy (angka) — dipakai kalau flow unified tidak terdeteksi */
  legacySeriesId: number | null
  /**
   * Chapter yang ditandai "sedang dibaca". Default = `chapterKey`. Di mode
   * maraton berbeda: rantai chapter bisa menyeberang sumber, jadi chapter
   * yang sedang dibaca belum tentu chapter pertama (acuan series).
   */
  currentKey?: string | null
  /** judul series, untuk konteks di header */
  seriesTitle?: string | null
  /** title_key series — untuk menandai chapter yang sudah dibaca (abu) */
  titleKey?: string | null
  /** reader biasa atau mode maraton (URL tujuan beda) */
  mode?: 'reader' | 'marathon'
}

/**
 * Sheet "Pilih Chapter" — ganti kolom komentar/reaksi di footer reader.
 *
 * UX:
 *  - daftar chapter milik series yang SEDANG dibaca (bukan daftar global),
 *  - pencarian nomor/judul untuk series panjang (ratusan chapter),
 *  - chapter aktif ditandai + digulir ke tengah layar,
 *  - tombol "Terbaru" buat lompat ke chapter terakhir.
 *
 * Navigasi pakai <Link replace> supaya menumpuk entry history: membaca
 * ch1→ch2→pilih ch3 lalu tekan "kembali" langsung ke halaman series, bukan
 * chapter per chapter.
 */
export default function ChapterPickerSheet({
  open,
  onClose,
  chapterKey,
  legacySeriesId,
  currentKey,
  seriesTitle,
  titleKey = null,
  mode = 'reader',
}: ChapterPickerSheetProps) {
  const [q, setQ] = useState('')
  const { chapters, loading, error } = usePickableChapters({
    enabled: open,
    chapterKey,
    legacySeriesId,
  })
  // Chapter yang sudah pernah dibuka → abu, sama seperti di halaman series.
  const { isRead } = useReadMarks(titleKey)
  const markedKey = currentKey ?? chapterKey
  const listRef = useRef<HTMLUListElement | null>(null)
  const currentRef = useRef<HTMLAnchorElement | null>(null)

  // chapter aktif → digulir ke tengah daftar (bukan cuma ujung)
  useEffect(() => {
    if (!open) return
    const c = listRef.current
    const el = currentRef.current
    if (!c || !el) return
    c.scrollTop +=
      el.getBoundingClientRect().top -
      c.getBoundingClientRect().top -
      c.clientHeight / 2 +
      el.clientHeight / 2
  }, [open, chapters.length])

  // Escape menutup sheet
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase()
    if (!needle) return chapters
    return chapters.filter(
      (c) =>
        c.number.toLowerCase().includes(needle) || c.title.toLowerCase().includes(needle),
    )
  }, [chapters, q])

  if (!open) return null

  const hrefFor = (key: string) => (mode === 'marathon' ? marathonHref(key) : readerHref(key))
  // "terbaru" = chapter terakhir dari daftar PENUH (bukan hasil filter) —
  // kalau ikut ter-filter, tombolnya lompat ke chapter cocok terakhir.
  const latest = chapters.length > 0 ? chapters[chapters.length - 1] : null

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/60"
      onClick={onClose}
      data-chapter-picker
    >
      <div
        className="flex max-h-[85vh] w-full max-w-md flex-col overflow-hidden rounded-t-2xl border-t border-white/10 bg-night-dark/97 backdrop-blur"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start gap-3 px-4 pb-3 pt-3">
          <div className="min-w-0 flex-1">
            <h2 className="font-display text-[15px] font-bold text-white">Pilih Chapter</h2>
            <p className="truncate text-[11.5px] text-white/55">
              {seriesTitle ? seriesTitle : 'Series ini'}
              {chapters.length > 0 ? ` · ${chapters.length} chapter` : ''}
            </p>
          </div>
          <button
            onClick={onClose}
            aria-label="Tutup"
            className="grid size-8 shrink-0 place-items-center rounded-full text-white/70 active:bg-white/10"
          >
            <svg viewBox="0 0 24 24" className="size-4" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M6 6l12 12M18 6L6 18" strokeLinecap="round" />
            </svg>
          </button>
        </div>

        <div className="px-4 pb-3">
          <div className="flex items-center gap-2 rounded-xl border border-white/15 bg-white/5 px-3">
            <svg
              viewBox="0 0 24 24"
              className="size-4 shrink-0 text-white/50"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              aria-hidden="true"
            >
              <circle cx="11" cy="11" r="7" />
              <path d="m20 20-3.5-3.5" strokeLinecap="round" />
            </svg>
            <input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Cari nomor atau judul chapter…"
              aria-label="Cari chapter"
              className="w-full bg-transparent py-2.5 text-[13px] text-white placeholder:text-white/40 focus:outline-none"
            />
            {q && (
              <button
                onClick={() => setQ('')}
                aria-label="Bersihkan pencarian"
                className="text-white/50 active:text-white/80"
              >
                <svg viewBox="0 0 24 24" className="size-4" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M6 6l12 12M18 6L6 18" strokeLinecap="round" />
                </svg>
              </button>
            )}
          </div>
        </div>

        {loading ? (
          <p className="px-4 pb-8 pt-2 text-center text-[12.5px] text-white/50">
            Memuat daftar chapter…
          </p>
        ) : error ? (
          <p className="px-4 pb-8 pt-2 text-center text-[12.5px] text-danger-ink">
            Gagal memuat chapter: {error}
          </p>
        ) : filtered.length === 0 ? (
          <p className="px-4 pb-8 pt-2 text-center text-[12.5px] text-white/50">
            {chapters.length === 0 ? 'Belum ada chapter di series ini.' : 'Tidak ada chapter yang cocok.'}
          </p>
        ) : (
          <ul ref={listRef} className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-2 pb-4">
            {filtered.map((c) => {
              const isCurrent = c.key === markedKey
              const read = !isCurrent && isRead(c.number)
              return (
                <li key={c.key}>
                  <Link
                    ref={isCurrent ? currentRef : undefined}
                    to={hrefFor(c.key)}
                    replace
                    onClick={onClose}
                    aria-current={isCurrent ? 'true' : undefined}
                    aria-label={
                      isCurrent
                        ? undefined
                        : read
                          ? `${c.title} — sudah dibaca`
                          : `${c.title} — belum dibaca`
                    }
                    className={`flex items-center gap-3 rounded-xl px-3 py-2.5 transition-colors ${
                      isCurrent
                        ? 'bg-brand-amber/20 ring-1 ring-inset ring-brand-amber/60'
                        : 'hover:bg-white/5 active:bg-white/10'
                    }`}
                  >
                    <span
                      className={`w-11 shrink-0 text-center text-[12px] font-bold tabular-nums ${
                        isCurrent
                          ? 'text-brand-amber-soft'
                          : read
                            ? 'text-white/30'
                            : 'text-white/60'
                      }`}
                    >
                      {c.number}
                    </span>
                    <span
                      className={`min-w-0 flex-1 truncate text-[13px] ${
                        isCurrent
                          ? 'font-bold text-white'
                          : read
                            ? 'text-white/40'
                            : 'text-white/85'
                      }`}
                    >
                      {c.title}
                    </span>
                    {isCurrent && (
                      <span className="shrink-0 rounded-full bg-brand-amber px-2 py-0.5 text-[9.5px] font-bold text-white">
                        Dip baca
                      </span>
                    )}
                  </Link>
                </li>
              )
            })}
          </ul>
        )}

        {latest && (
          <div className="border-t border-white/10 px-4 py-3">
            <Link
              to={hrefFor(latest.key)}
              replace
              onClick={onClose}
              className="block rounded-xl bg-white/10 py-2.5 text-center text-[13px] font-bold text-white active:bg-white/20"
            >
              Lompat ke chapter terbaru · {latest.number}
            </Link>
          </div>
        )}
      </div>
    </div>
  )
}
