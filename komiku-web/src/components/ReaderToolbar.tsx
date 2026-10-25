import { IconAngleLeft, IconHouse, IconShare, IconEllipsisV } from '../icons'

interface ReaderToolbarProps {
  title: string
  subtitle?: string
  onBack: () => void
  /** Tombol Beranda — kalau diisi, ikon rumah muncul di sebelah "Kembali". */
  onHome?: () => void
  onShare: () => void
  onMore: () => void
  /** chip mode aktif (mis. "Maraton") — tampil di baris meta, biru brand */
  chip?: string | null
  /** badge sumber (muncul hanya untuk manga non-komiku) */
  badge?: React.ReactNode
  /**
   * Node favorit (HeartButton) — Reader menyuntikkannya ketika series membawa
   * title_key (flow unified), supaya heart bisa dipakai tanpa reader tahu
   * bentuk rakStore.
   */
  heart?: React.ReactNode
  /** false = ikut arah scroll sembunyi (geser keluar layar, tidak bisa difokus) */
  visible?: boolean
}

/**
 * Toolbar reader — replika item_reader_header + MaterialToolbar APK:
 * tinggi 45sdp (~48px), ikon back angle-left, judul BR Hendrix semibold,
 * kanan: share + ellipsis (menu). Divider 0.9dp di bawah.
 */
export default function ReaderToolbar({
  title,
  subtitle,
  onBack,
  onHome,
  onShare,
  onMore,
  chip,
  badge,
  heart,
  visible = true,
}: ReaderToolbarProps) {
  return (
    <header
      data-reader-chrome="toolbar"
      className={`fixed inset-x-0 top-0 z-30 bg-gradient-to-b from-black/90 via-black/70 to-transparent pt-[env(safe-area-inset-top)] pl-[env(safe-area-inset-left)] pr-[env(safe-area-inset-right)] backdrop-blur-[2px] transition-transform duration-200 ${
        visible ? 'translate-y-0' : '-translate-y-full'
      }`}
      aria-hidden={!visible}
      inert={!visible}
    >
      <div className="flex h-12 items-center gap-1 px-1.5">
        <button
          type="button"
          onClick={onBack}
          aria-label="Kembali"
          className="grid size-11 shrink-0 touch-manipulation place-items-center rounded-full text-white/90 active:bg-white/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/80"
        >
          <IconAngleLeft className="size-4" aria-hidden="true" />
        </button>
        {onHome && (
          <button
            type="button"
            onClick={onHome}
            aria-label="Beranda"
            className="grid size-11 shrink-0 touch-manipulation place-items-center rounded-full text-white/90 active:bg-white/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/80"
          >
            <IconHouse className="size-4" aria-hidden="true" />
          </button>
        )}
        <div className="min-w-0 flex-1">
          {/* text-shadow: judul/meta duduk di atas gambar manga yang bisa
              putih total (balon dialog). Gradient toolbar saja tidak cukup —
              teks 11–13 px harus tetap terbaca di halaman terang. */}
          <p className="truncate font-display text-[13px] font-semibold text-white [text-shadow:0_1px_3px_rgba(0,0,0,0.65)]">
            {title}
          </p>
          {(subtitle || badge || chip) && (
            <div className="flex min-w-0 items-center gap-1.5">
              {subtitle && (
                <p className="min-w-0 truncate text-[11px] leading-tight text-white/85 [text-shadow:0_1px_2px_rgba(0,0,0,0.7)]">
                  {subtitle}
                </p>
              )}
              {/* badge sumber di baris meta — judul tetap dapat lebar penuh
                  di layar 390px (sebelumnya badge memakan ~60px judul) */}
              {badge && <span className="shrink-0">{badge}</span>}
              {/* chip mode aktif pindah dari baris judul ke baris meta: di
                  layar 390px chip ~52px + heart 44 + 4 tombol 44 membuat
                  judul cuma kebagian ~73px (terpotong jadi "Bab…"). */}
              {chip && (
                <span className="shrink-0 rounded-[5px] bg-brand-amber px-1.5 py-[2px] text-[10px] font-semibold leading-tight text-white">
                  {chip}
                </span>
              )}
            </div>
          )}
        </div>
        {heart && (
          <span className="grid size-11 shrink-0 place-items-center text-white/90">{heart}</span>
        )}
        <button
          type="button"
          onClick={onShare}
          aria-label="Bagikan"
          className="grid size-11 shrink-0 touch-manipulation place-items-center rounded-full text-white/90 active:bg-white/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/80"
        >
          <IconShare className="size-4" aria-hidden="true" />
        </button>
        <button
          type="button"
          onClick={onMore}
          aria-label="Menu"
          className="grid size-11 shrink-0 touch-manipulation place-items-center rounded-full text-white/90 active:bg-white/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/80"
        >
          <IconEllipsisV className="size-4" aria-hidden="true" />
        </button>
      </div>
      <div className="h-[0.9px] w-full bg-black/20" />
    </header>
  )
}
