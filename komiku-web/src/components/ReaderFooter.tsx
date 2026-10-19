import { Link } from 'react-router-dom'
import { IconArrowRight, IconArrowLeft } from '../icons'

interface ReaderFooterProps {
  /** chapter berikutnya (null = terbaru) */
  nextName?: string | null
  nextHref?: string | null
  /** chapter sebelumnya (null = chapter pertama) */
  prevName?: string | null
  prevHref?: string | null
  /** buka sheet pemilih chapter */
  onPickChapter: () => void
  /** false = sembunyi saat pembaca scroll turun (geser keluar layar) */
  visible?: boolean
}

/**
 * Footer reader — navigasi chapter + pemilih chapter.
 *
 * Baris "Tambahkan komentar…" dan baris reaksi (ikon sosial) DIHAPUS:
 * keduanya fitur mati di versi web. Penggantinya satu tombol "Pilih
 * Chapter" yang membuka sheet daftar chapter series yang sedang dibaca.
 *
 * Navigasi tetap DUA tombol berdampingan (grid 2 kolom): "Sebelumnya"
 * sekunder (outline) dan "Berikutnya" solid brand. Kalau hanya satu sisi
 * yang ada (chapter pertama / terbaru), tombol yang tinggal melebar penuh.
 * Teks "Chapter terbaru" dipertahankan untuk tepi terbaru.
 *
 * `visible=false` = geser ke bawah keluar layar + `inert` supaya chrome
 * tersembunyi benar-benar tidak bisa difokus saat dibaca.
 */
export default function ReaderFooter({
  nextName,
  nextHref,
  prevName,
  prevHref,
  onPickChapter,
  visible = true,
}: ReaderFooterProps) {
  const both = !!prevHref && !!nextHref
  return (
    <footer
      data-reader-chrome="footer"
      className={`fixed inset-x-0 bottom-0 z-30 bg-gradient-to-t from-black/85 to-transparent transition-transform duration-200 ${
        visible ? 'translate-y-0' : 'translate-y-full'
      }`}
      aria-hidden={!visible}
      inert={!visible}
    >
      <div className="mx-4 mt-2 grid gap-2">
        <button
          type="button"
          onClick={onPickChapter}
          aria-label="Pilih Chapter"
          className="flex w-full items-center justify-center gap-2 rounded-xl border border-white/40 bg-black/70 py-3 text-[13px] font-bold text-white backdrop-blur-sm active:bg-black/85"
        >
          <IconChapterList className="size-4 shrink-0" />
          Pilih Chapter
        </button>
      </div>
      <div className={`mx-4 my-2.5 grid gap-2 ${both ? 'grid-cols-2' : 'grid-cols-1'}`}>
        {prevHref && (
          <Link
            to={prevHref}
            replace
            aria-label={prevName ? `Chapter Sebelumnya ${prevName}` : 'Chapter Sebelumnya'}
            className="flex items-center justify-center gap-1.5 rounded-xl border border-white/35 py-3 text-[13px] font-bold text-white/90"
          >
            <IconArrowLeft className="size-3.5 shrink-0" />
            <span className="truncate">Sebelumnya</span>
            {prevName ? (
              <span className="truncate font-medium opacity-70">· {prevName}</span>
            ) : null}
          </Link>
        )}
        {nextHref ? (
          <Link
            to={nextHref}
            replace
            aria-label={nextName ? `Baca Chapter Berikutnya ${nextName}` : 'Baca Chapter Berikutnya'}
            className="flex items-center justify-center gap-2 rounded-xl bg-brand-amber py-3 text-[13px] font-bold text-white"
          >
            Berikutnya
            <IconArrowRight className="size-3.5 shrink-0" />
            {nextName ? (
              <span className="truncate font-medium opacity-80">· {nextName}</span>
            ) : null}
          </Link>
        ) : (
          <p className="rounded-xl border border-white/15 py-3 text-center text-[12.5px] text-white/60">
            Chapter terbaru
          </p>
        )}
      </div>
      <div className="h-[env(safe-area-inset-bottom)]" />
    </footer>
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
