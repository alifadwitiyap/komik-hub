import { Link } from 'react-router-dom'
import { IconArrowLeft, IconArrowRight } from '../icons'

interface ReaderFooterProps {
  /** chapter sebelumnya (null = chapter pertama) */
  prevName?: string | null
  prevHref?: string | null
  /** chapter berikutnya (null = terbaru) */
  nextName?: string | null
  nextHref?: string | null
  /** buka sheet pemilih chapter */
  onPickChapter: () => void
  /** false = sembunyi saat pembaca scroll turun (geser keluar layar) */
  visible?: boolean
}

/**
 * Footer reader — pemilih chapter + navigasi chapter.
 *
 * Baris "Tambahkan komentar…" dan baris reaksi (ikon sosial) DIHAPUS: keduanya
 * fitur mati di versi web. Tombol "Sebelumnya" sempat DIHAPUS — digantikan
 * "Pilih Chapter" di atasnya — lalu DIMINTA KEMBALI oleh pemilik situs lewat
 * feedback live page ("tambahkan tombol sebelumnya"); keputusan penghapusan
 * itu dibatalkan. "Pilih Chapter" tetap ada.
 *
 * Jadi isi footer = DUA baris:
 *   1. "Pilih Chapter"    → sheet daftar chapter series ini
 *   2. "Navigasi chapter" → "Sebelumnya" (sekunder, outline) di KIRI +
 *      "Berikutnya" (primer, amber) di KANAN (atau label "Chapter terbaru")
 *
 * ERGONOMI MOBILE (390×844):
 * - tiap target sentuh >= 44 px (min-h-11) dan berjarak 8 px satu sama lain;
 * - kedua target nav sama lebar (grid-cols-2) dan berjarak 8 px (gap-2) — di
 *   layar 390 px "Sebelumnya" dan "Berikutnya" berukuran identik;
 * - kontainer memakai satu ritme flex (gap 8 px) + padding
 *   max(16 px, env(safe-area-inset-*)) di kiri/kanan dan
 *   pb-[env(safe-area-inset-bottom)] di bawah, jadi tombol tidak menempel ke
 *   tepi layar maupun ke home-indicator iPhone;
 * - scrim gelap di footer ini WAJIB: halaman manga bisa putih total, dan teks
 *   putih di atas putih = tak terbaca;
 * - seluruh footer `pointer-events-none` + tiap baris `pointer-events-auto`:
 *   area transparan di gradient tidak lagi "menelan" tap yang seharusnya
 *   men-toggle chrome.
 *
 * `visible=false` = geser ke bawah keluar layar + `inert` supaya chrome
 * tersembunyi benar-benar tidak bisa difokus saat dibaca.
 */
export default function ReaderFooter({
  prevName,
  prevHref,
  nextName,
  nextHref,
  onPickChapter,
  visible = true,
}: ReaderFooterProps) {
  return (
    <footer
      data-reader-chrome="footer"
      className={`pointer-events-none fixed inset-x-0 bottom-0 z-30 bg-gradient-to-t from-black/95 via-black/80 to-transparent pb-[env(safe-area-inset-bottom)] transition-transform duration-200 ${
        visible ? 'translate-y-0' : 'translate-y-full'
      }`}
      aria-hidden={!visible}
      inert={!visible}
    >
      {/**
       * Satu kolom flex untuk KEDUA baris: jarak antar baris jadi 8 px di mana-
       * mana. Padding kiri/kanan = max(16 px, safe-area): di layar 390 px
       * hasilnya tetap 16 px, tapi di perangkat berponi (landscape / iPhone
       * mini notch) tombol tidak lagi masuk ke area tirai.
       */}
      <div className="flex flex-col gap-2 pb-2.5 pt-2.5 [padding-left:max(1rem,env(safe-area-inset-left))] [padding-right:max(1rem,env(safe-area-inset-right))]">
        <button
          type="button"
          onClick={onPickChapter}
          aria-label="Pilih Chapter"
          className="pointer-events-auto flex min-h-11 w-full touch-manipulation items-center justify-center gap-2 rounded-xl border border-white/40 bg-black/70 py-3 text-[14px] font-bold text-white backdrop-blur-sm active:bg-black/85 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/80"
        >
          <IconChapterList className="size-4 shrink-0" />
          Pilih Chapter
        </button>
        <nav aria-label="Navigasi chapter" className={`pointer-events-auto grid gap-2 ${prevHref && nextHref ? 'grid-cols-2' : 'grid-cols-1'}`}>
          {prevHref ? (
            <Link
              to={prevHref}
              replace
              aria-label={prevName ? `Baca Chapter Sebelumnya ${prevName}` : 'Baca Chapter Sebelumnya'}
              className="flex min-h-11 touch-manipulation items-center justify-center gap-2 rounded-xl border border-white/40 bg-black/70 py-3 text-[14px] font-bold text-white backdrop-blur-sm active:bg-black/85 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white"
            >
              <IconArrowLeft className="size-3.5 shrink-0" aria-hidden="true" />
              Sebelumnya
              {prevName ? (
                <span className="hidden truncate font-medium opacity-80 sm:inline">· {prevName}</span>
              ) : null}
            </Link>
          ) : (
            <p className="flex min-h-11 items-center justify-center rounded-xl border border-white/25 py-3 text-center text-[13px] font-medium text-white/85">
              Chapter pertama
            </p>
          )}
          {nextHref ? (
            <Link
              to={nextHref}
              replace
              aria-label={nextName ? `Baca Chapter Berikutnya ${nextName}` : 'Baca Chapter Berikutnya'}
              className="flex min-h-11 touch-manipulation items-center justify-center gap-2 rounded-xl bg-brand-amber py-3 text-[14px] font-bold text-white active:bg-[#005f92] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white"
            >
              Berikutnya
              <IconArrowRight className="size-3.5 shrink-0" aria-hidden="true" />
              {nextName ? (
                <span className="hidden truncate font-medium opacity-80 sm:inline">· {nextName}</span>
              ) : null}
            </Link>
          ) : (
            <p className="flex min-h-11 items-center justify-center rounded-xl border border-white/25 py-3 text-center text-[13px] font-medium text-white/85">
              Chapter terbaru
            </p>
          )}
        </nav>
      </div>
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
