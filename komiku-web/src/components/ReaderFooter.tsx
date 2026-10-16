import { Link } from 'react-router-dom'
import {
  IconThumbsUp,
  IconHeartCirclePlus,
  IconLightbulb,
  IconMessageDots,
  IconArrowRight,
  IconArrowLeft,
} from '../icons'

interface ReaderFooterProps {
  /** chapter berikutnya (null = terbaru) */
  nextName?: string | null
  nextHref?: string | null
  /** chapter sebelumnya (null = chapter pertama) */
  prevName?: string | null
  prevHref?: string | null
  onOpenComments: () => void
  /** false = sembunyi saat pembaca scroll turun (geser keluar layar) */
  visible?: boolean
}

/**
 * Footer reader — replika item_reader_footer APK:
 * baris reaksi (3 ikon ring + jumlah), baris komentar, lalu navigasi chapter.
 *
 * Navigasi = DUA tombol berdampingan (grid 2 kolom): "Sebelumnya" sekunder
 * (outline) dan "Berikutnya" solid brand. Kalau hanya satu sisi yang ada
 * (chapter pertama / terbaru), tombol yang tinggal melebar penuh. Teks
 * "Chapter terbaru" dipertahankan untuk tepi terbaru.
 *
 * `visible=false` = geser ke bawah keluar layar + `inert` supaya chrome
 * tersembunyi benar-benar tidak bisa difokus saat dibaca.
 */
export default function ReaderFooter({
  nextName,
  nextHref,
  prevName,
  prevHref,
  onOpenComments,
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
      <div className="flex items-center justify-around px-4 pt-2">
        <Reaction icon={<IconThumbsUp className="size-4" />} n={0} />
        <Reaction icon={<IconHeartCirclePlus className="size-4" />} n={0} />
        <Reaction icon={<IconLightbulb className="size-4" />} n={0} />
      </div>
      <button
        onClick={onOpenComments}
        className="mx-4 mt-2 flex w-[calc(100%-2rem)] items-center gap-2 rounded-full border border-white/25 px-3.5 py-2 text-left"
      >
        <IconMessageDots className="size-4 text-white/70" />
        <span className="text-[12px] text-white/60">Tambahkan komentar…</span>
      </button>
      <div className={`mx-4 my-2.5 grid gap-2 ${both ? 'grid-cols-2' : 'grid-cols-1'}`}>
        {prevHref && (
          <Link
            to={prevHref}
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

function Reaction({ icon, n }: { icon: React.ReactNode; n: number }) {
  return (
    <button className="flex items-center gap-1.5 rounded-full px-3 py-1.5 text-white/80 active:bg-white/10">
      {icon}
      <span className="text-[11px]">{n}</span>
    </button>
  )
}
