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
 * sekunder (outline + scrim gelap) dan "Berikutnya" solid brand. Sisi yang tidak tersedia
 * (chapter pertama / terbaru) diisi label tepi senada, BUKAN tombol yang
 * melebar — supaya tinggi footer sama di semua chapter dan tidak ada baris
 * ketiga yang menutupi halaman di layar 390×844.
 *
 * ERGONOMI MOBILE (390×844):
 * - tiap target sentuh >= 44 px (min-h-11) dan berjarak 8 px satu sama lain;
 * - kontainer memakai satu ritme flex (gap 8 px) + padding
 *   max(16 px, env(safe-area-inset-*)) di kiri/kanan dan
 *   pb-[env(safe-area-inset-bottom)] di bawah, jadi tombol tidak menempel ke
 *   tepi layar maupun ke home-indicator iPhone;
 * - scrim gelap di footer ini WAJIB: halaman manga bisa putih total, dan teks
 *   putih di atas putih = tak terbaca. Karena itu tombol "Sebelumnya" punya
 *   bg-black/55 (bukan hanya border), bukan cuma "outline";
 * - seluruh footer `pointer-events-none` + tiap baris `pointer-events-auto`:
 *   area transparan di gradient tidak lagi "menelan" tap yang seharusnya
 *   men-toggle chrome.
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
       * mana (dulu baris 1 pakai mt-2 = 8 px, baris 2 pakai my-2.5 = 10 px,
       * jadi ritmenya tidak konsisten dan baris atas terasa "nempel").
       *
       * Padding kiri/kanan = max(16 px, safe-area): di layar 390 px hasilnya
       * tetap 16 px (sama seperti mx-4 sebelumnya), tapi di perangkat berponi
       * (landscape / iPhone mini notch) tombol tidak lagi masuk ke area tirai.
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
        {/**
         * SELALU dua kolom. Dulu `grid-cols-1` dipakai saat salah satu sisi
         * tidak ada — tapi placeholder ("Chapter terbaru") tetap dirender,
         * jadi di chapter terbaru tombol "Sebelumnya" dan placeholder itu
         * BERTUMPUK jadi dua baris penuh (footer ±170 px di layar 844 px).
         * Sekarang kedua sel selalu terisi (tombol atau label tepi), jadi
         * tingginya tetap dua baris di semua chapter.
         */}
        <nav aria-label="Navigasi chapter" className="pointer-events-auto grid grid-cols-2 gap-2">
          {prevHref ? (
            <Link
              to={prevHref}
              replace
              aria-label={prevName ? `Chapter Sebelumnya ${prevName}` : 'Chapter Sebelumnya'}
              className="flex min-h-11 touch-manipulation items-center justify-center gap-1.5 rounded-xl border border-white/35 bg-black/55 py-3 text-[14px] font-bold text-white backdrop-blur-sm active:bg-black/80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/80"
            >
              <IconArrowLeft className="size-3.5 shrink-0" aria-hidden="true" />
              <span className="truncate">Sebelumnya</span>
              {prevName ? (
                <span className="hidden truncate font-medium opacity-70 sm:inline">· {prevName}</span>
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
