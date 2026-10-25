import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { usePickableChapters, type PickableChapter } from '../hooks/usePickableChapters'
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
  const panelRef = useRef<HTMLDivElement | null>(null)
  const searchRef = useRef<HTMLInputElement | null>(null)

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

  // A11Y MODAL: saat sheet dibuka, fokus pindah KE DALAM sheet (kotak
  // pencarian) — tanpa ini, Tab keyboard masih jalan ke tombol di belakang
  // sheet dan screen reader tidak tahu ini dialog. Saat ditutup, fokus
  // kembali ke elemen yang membuka sheet.
  useLayoutEffect(() => {
    if (!open) return
    // activeElement bisa <body> kalau sheet dibuka lewat tap (iOS tidak
    // memfokuskan <button> saat disentuh). Menyimpan <body> bikin
    // "kembali ke pemicu" jadi no-op → fokus pembaca layar jatuh ke awal
    // dokumen. Kalau bukan elemen nyata, jangan diingat.
    const ae = document.activeElement
    const opener = ae instanceof HTMLElement && ae !== document.body ? ae : null
    // Fokus SINKRON (layout effect, bukan setTimeout): iOS hanya membuka
    // keyboard kalau focus() terjadi di task yang sama dengan gesture tap.
    // Dengan setTimeout, keyboard tidak muncul dan sheet "terasa mati".
    searchRef.current?.focus({ preventScroll: true })
    return () => {
      // preventScroll: mengembalikan fokus ke tombol pemicu tidak boleh
      // menggulir halaman (reader sedang menampilkan chapter baru).
      opener?.focus({ preventScroll: true })
    }
  }, [open])

  // Escape menutup sheet + Tab diputar di dalam dialog (focus trap).
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose()
        return
      }
      if (e.key !== 'Tab') return
      const panel = panelRef.current
      if (!panel) return
      const focusables = panel.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), input, [tabindex]:not([tabindex="-1"])',
      )
      if (focusables.length === 0) return
      const first = focusables[0]
      const last = focusables[focusables.length - 1]
      const active = document.activeElement
      // fokus nyasar ke luar dialog (mis. setelah tap area kosong) → tarik
      // kembali ke elemen pertama, jangan biarkan Tab jalan ke halaman di
      // belakang sheet.
      if (!active || !panel.contains(active)) {
        e.preventDefault()
        first.focus()
        return
      }
      if (e.shiftKey && active === first) {
        e.preventDefault()
        last.focus()
      } else if (!e.shiftKey && active === last) {
        e.preventDefault()
        first.focus()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  // SCROLL LOCK: sheet adalah overlay — halaman di belakang tidak boleh
  // ikut ter-scroll (atau chrome reader ikut hilang) saat sheet terbuka.
  //
  // Versi lama cuma memblokir event `wheel`; di HP tidak ada wheel, jadi
  // sentuhan tetap menggulir halaman di belakang sheet. Sekarang scroll
  // dikunci di dokumen (menutup touch + wheel + PageDown sekaligus), dan
  // daftar chapter tetap bisa digulir karena dia scroller sendiri
  // (`overflow-y-auto overscroll-contain`).
  useEffect(() => {
    if (!open) return
    const html = document.documentElement
    const body = document.body
    const prev = {
      htmlOverflow: html.style.overflow,
      htmlOverscroll: html.style.overscrollBehavior,
      bodyOverflow: body.style.overflow,
      bodyPaddingRight: body.style.paddingRight,
    }
    // diukur SEBELUM overflow disembunyikan; tanpa kompensasi ini layout
    // desktop bergeser saat scrollbar hilang.
    const scrollbar = window.innerWidth - html.clientWidth
    html.style.overflow = 'hidden'
    html.style.overscrollBehavior = 'none'
    body.style.overflow = 'hidden'
    if (scrollbar > 0) body.style.paddingRight = `${scrollbar}px`
    return () => {
      html.style.overflow = prev.htmlOverflow
      html.style.overscrollBehavior = prev.htmlOverscroll
      body.style.overflow = prev.bodyOverflow
      body.style.paddingRight = prev.bodyPaddingRight
    }
  }, [open])

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase()
    if (!needle) return chapters
    return chapters.filter(
      (c) =>
        c.number.toLowerCase().includes(needle) || c.title.toLowerCase().includes(needle),
    )
  }, [chapters, q])

  // "terbaru" = chapter dengan nomor TERBESAR dari daftar PENUH (bukan hasil
  // filter, bukan sekadar elemen terakhir — chapter tanpa nomor di-sort ke
  // akhir, jadi elemen terakhir belum tentu yang terbaru).
  const latest = useMemo(() => {
    let best: PickableChapter | null = null
    let bestN = -Infinity
    for (const c of chapters) {
      const n = Number(c.number)
      if (!Number.isFinite(n)) continue
      if (n > bestN) {
        bestN = n
        best = c
      }
    }
    return best
  }, [chapters])

  if (!open) return null

  const hrefFor = (key: string) => (mode === 'marathon' ? marathonHref(key) : readerHref(key))

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/60"
      onClick={onClose}
    >
      {/* dvh (bukan vh): 85vh di browser HP termasuk tinggi bilah alamat,
          jadi sheet bisa lebih tinggi dari layar dan footer-nya ketutup. */}
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="chapter-picker-title"
        aria-describedby="chapter-picker-desc"
        data-chapter-picker
        className="flex max-h-[85dvh] w-full max-w-md flex-col overflow-hidden rounded-t-2xl border-t border-white/10 bg-night-dark/97 backdrop-blur"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex shrink-0 items-start gap-3 px-4 pb-3 pt-3">
          <div className="min-w-0 flex-1">
            <h2 id="chapter-picker-title" className="font-display text-[15px] font-bold text-white">
              Pilih Chapter
            </h2>
            <p id="chapter-picker-desc" className="truncate text-[11.5px] text-white/55">
              {seriesTitle ? seriesTitle : 'Series ini'}
              {chapters.length > 0 ? ` · ${chapters.length} chapter` : ''}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Tutup pilih chapter"
            className="grid size-11 shrink-0 place-items-center rounded-full text-white/70 active:bg-white/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/80"
          >
            <svg viewBox="0 0 24 24" className="size-4" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M6 6l12 12M18 6L6 18" strokeLinecap="round" />
            </svg>
          </button>
        </div>

        <div className="shrink-0 px-4 pb-3">
          <div className="flex items-center gap-2 rounded-xl border border-white/15 bg-white/5 pl-3 pr-1">
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
            {/* text-base (16px) — di bawah 16px iOS Safari auto-zoom saat
                input difokuskan, dan halaman yang sudah ter-zoom bikin sheet
                ini keluar dari layar 390px. */}
            <input
              ref={searchRef}
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Cari nomor atau judul chapter…"
              aria-label="Cari chapter"
              type="text"
              enterKeyHint="search"
              autoComplete="off"
              autoCorrect="off"
              spellCheck={false}
              className="w-full min-w-0 bg-transparent py-3 text-base text-white placeholder:text-white/40 focus:outline-none"
            />
            {q && (
              <button
                type="button"
                onClick={() => setQ('')}
                aria-label="Bersihkan pencarian"
                className="grid size-11 shrink-0 place-items-center rounded-full text-white/60 active:bg-white/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/80"
              >
                <svg viewBox="0 0 24 24" className="size-4" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M6 6l12 12M18 6L6 18" strokeLinecap="round" />
                </svg>
              </button>
            )}
          </div>
        </div>

        {/* Pembaca layar tidak melihat daftar berubah saat mengetik — jumlah
            hasil (dan status muat/gagal) harus bisa didengar. */}
        <p role="status" aria-live="polite" className="sr-only">
          {loading
            ? 'Memuat daftar chapter'
            : error
              ? `Gagal memuat chapter: ${error}`
              : `${filtered.length} chapter ditemukan`}
        </p>

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
                    className={`flex min-h-11 items-center gap-3 rounded-xl px-3 py-2.5 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/80 ${
                      isCurrent
                        ? 'bg-brand-amber/20 ring-1 ring-inset ring-brand-amber/60'
                        : 'hover:bg-white/5 active:bg-white/10'
                    }`}
                  >
                    <span
                      className={`w-11 shrink-0 truncate text-center text-[12px] font-bold tabular-nums ${
                        isCurrent
                          ? 'text-brand-amber-soft'
                          : read
                            ? 'text-white/55'
                            : 'text-white/60'
                      }`}
                      title={c.number || c.title}
                    >
                      {c.number || '—'}
                    </span>
                    <span
                      className={`min-w-0 flex-1 truncate text-[13px] ${
                        isCurrent
                          ? 'font-bold text-white'
                          : read
                            ? 'text-white/65'
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

        {/* Bar aksi di bawah sheet = zona jempol. "Tutup" selalu ada (walau
            belum ada chapter terbaru / daftar gagal dimuat) supaya menutup
            sheet tidak perlu menjangkau X di pojok atas. */}
        <div className="flex shrink-0 items-center gap-2 border-t border-white/10 px-4 pb-[calc(0.75rem+env(safe-area-inset-bottom))] pt-3">
          {latest && (
            <Link
              to={hrefFor(latest.key)}
              replace
              onClick={onClose}
              className="flex min-h-11 min-w-0 flex-1 items-center justify-center rounded-xl bg-brand-amber px-3 text-[13px] font-bold text-white active:bg-brand-amber/80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/80"
            >
              <span className="truncate">Lompat ke chapter terbaru · {latest.number}</span>
            </Link>
          )}
          <button
            type="button"
            onClick={onClose}
            className={`grid min-h-11 shrink-0 place-items-center rounded-xl border border-white/15 px-4 text-[13px] font-bold text-white/85 active:bg-white/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/80 ${
              latest ? '' : 'flex-1'
            }`}
          >
            Tutup
          </button>
        </div>
      </div>
    </div>
  )
}
