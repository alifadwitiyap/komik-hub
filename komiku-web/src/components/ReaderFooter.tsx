import { useState } from 'react'
import { Link } from 'react-router-dom'
import { IconArrowLeft, IconArrowRight } from '../icons'

interface ReaderFooterProps {
  /** chapter sebelumnya (null = chapter pertama) */
  prevName?: string | null
  prevHref?: string | null
  /** chapter berikutnya (null = chapter terakhir) */
  nextName?: string | null
  nextHref?: string | null
  /** buka sheet pemilih chapter */
  onPickChapter: () => void
  /** false = sembunyi saat pembaca scroll turun (geser keluar layar) */
  visible?: boolean
  /** jumlah panel di chapter; >1 menampilkan scrubber */
  pageCount?: number
  /** halaman aktif (1-based) */
  activePage?: number
  /** dipanggil saat scrubber dilepas */
  onSeek?: (page: number) => void
}

/**
 * Footer reader — SATU baris navigasi: Sebelumnya, Chapter, Berikutnya.
 *
 * Tombol "Sebelumnya" dan "Berikutnya" SELALU dirender (disabled kalau tak
 * tersedia) supaya posisinya tidak berpindah-pindah antar chapter. Chapter
 * terakhir memperlihatkan label "Chapter berikutnya" (disabled), BUKAN
 * "Chapter terbaru".
 */
export default function ReaderFooter({
  prevName,
  prevHref,
  nextName,
  nextHref,
  onPickChapter,
  visible = true,
  pageCount = 0,
  activePage = 1,
  onSeek,
}: ReaderFooterProps) {
  const [preview, setPreview] = useState<number | null>(null)
  const max = Math.max(1, pageCount)
  const shown = Math.min(Math.max(preview ?? activePage, 1), max)
  const percent = max > 1 ? Math.round(((shown - 1) / (max - 1)) * 100) : 100
  const commit = () => {
    if (preview === null) return
    onSeek?.(preview)
    setPreview(null)
  }
  return (
    <footer
      data-reader-chrome="footer"
      className={`pointer-events-none fixed inset-x-0 bottom-0 z-30 bg-gradient-to-t from-black/95 via-black/80 to-transparent pb-[env(safe-area-inset-bottom)] reader-chrome-fade reader-hud-bottom ${
        visible ? 'opacity-100' : 'opacity-0'
      }`}
      data-hidden={!visible}
      aria-hidden={!visible}
      inert={!visible}
    >
      {pageCount > 1 && onSeek && (
        <div className="pointer-events-auto relative flex items-center gap-3 px-4 pb-1 [padding-left:max(1rem,env(safe-area-inset-left))] [padding-right:max(1rem,env(safe-area-inset-right))]">
          <span className="shrink-0 text-[11px] font-semibold text-white/80">Hal</span>
          <input
            type="range"
            min={1}
            max={max}
            step={1}
            value={shown}
            data-reader-scrubber=""
            aria-label="Pilih halaman"
            aria-valuetext={`Hal. ${shown} · ${percent}%`}
            onChange={(e) => setPreview(Number(e.target.value))}
            onPointerUp={commit}
            onPointerCancel={() => setPreview(null)}
            onKeyUp={commit}
            onBlur={commit}
            className="reader-scrubber min-h-11 flex-1 touch-manipulation"
          />
          <span className="w-11 shrink-0 text-right text-[11px] font-semibold text-white/85">
            {max}
          </span>
          {preview !== null && (
            <span className="reader-scrubber-preview pointer-events-none absolute -top-8 left-1/2 -translate-x-1/2 whitespace-nowrap rounded-full bg-black/85 px-3 py-1 text-[11px] font-bold text-white shadow">
              Hal. {shown} · {percent}%
            </span>
          )}
        </div>
      )}
      <nav
        aria-label="Navigasi chapter"
        className="pointer-events-auto grid grid-cols-3 gap-2 px-4 py-2.5 [padding-left:max(1rem,env(safe-area-inset-left))] [padding-right:max(1rem,env(safe-area-inset-right))]"
      >
        <FooterButton
          to={prevHref}
          disabled={!prevHref}
          ariaLabel={prevName ? `Baca Chapter Sebelumnya ${prevName}` : 'Chapter Sebelumnya'}
          className="border border-white/40 bg-black/70 active:bg-black/85"
        >
          <IconArrowLeft className="size-3.5 shrink-0" aria-hidden="true" />
          <span>Sebelumnya</span>
        </FooterButton>
        <button
          type="button"
          onClick={onPickChapter}
          aria-label="Pilih Chapter"
          className="pointer-events-auto flex min-h-11 min-w-0 touch-manipulation items-center justify-center gap-2 rounded-xl border border-white/40 bg-black/70 px-2 py-3 text-[13px] font-bold text-white backdrop-blur-sm active:bg-black/85 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/80"
        >
          <IconChapterList className="size-4 shrink-0" />
          <span className="truncate">Chapter</span>
        </button>
        <FooterButton
          to={nextHref}
          disabled={!nextHref}
          ariaLabel={nextHref
            ? (nextName ? `Baca Chapter Berikutnya ${nextName}` : 'Baca Chapter Berikutnya')
            : 'Chapter berikutnya'}
          className={nextHref
            ? 'bg-brand-amber active:bg-[#005f92]'
            : 'border border-white/25 bg-black/50 text-white/70'}
        >
          <span className="truncate">{nextHref ? 'Berikutnya' : 'Chapter berikutnya'}</span>
          {nextHref ? <IconArrowRight className="size-3.5 shrink-0" aria-hidden="true" /> : null}
        </FooterButton>
      </nav>
    </footer>
  )
}

/** Link aktif atau tombol disabled dengan tinggi target sentuh yang sama. */
function FooterButton({
  to,
  disabled,
  ariaLabel,
  className,
  children,
}: {
  to?: string | null
  disabled?: boolean
  ariaLabel: string
  className: string
  children: React.ReactNode
}) {
  const base = `pointer-events-auto flex min-h-11 min-w-0 touch-manipulation items-center justify-center gap-1.5 rounded-xl px-2 py-3 text-[13px] font-bold text-white backdrop-blur-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white ${className}`
  if (disabled || !to) {
    return (
      <button
        type="button"
        disabled
        aria-label={ariaLabel}
        className={`${base} cursor-not-allowed opacity-70`}
      >
        {children}
      </button>
    )
  }
  return (
    <Link to={to} replace aria-label={ariaLabel} className={base}>
      {children}
    </Link>
  )
}

/** Ikon daftar chapter — inline supaya icons.tsx (ikon APK asli) tak diubah. */
function IconChapterList({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      className={className}
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M4 6h16M4 12h16M4 18h10" />
    </svg>
  )
}
