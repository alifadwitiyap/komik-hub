import { IconAngleLeft, IconHouse, IconShare, IconEllipsisV, IconBolt } from '../icons'

interface ReaderToolbarProps {
  title: string
  subtitle?: string
  onBack: () => void
  /** Tombol Beranda — kalau diisi, ikon rumah muncul di sebelah "Kembali". */
  onHome?: () => void
  onShare: () => void
  onMore: () => void
  /** chip ungu di kanan (mode aktif, mis. "Maraton") */
  chip?: string | null
  /** badge sumber (muncul hanya untuk manga non-komiku) */
  badge?: React.ReactNode
  /**
   * Kalau diisi, tombol unduh (bolt) muncul di kanan sebelum menu —
   * hanya ReaderMarathon yang mengirim; Reader.tsx tetap tanpa tombol.
   */
  onDownload?: () => void
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
  onDownload,
  heart,
  visible = true,
}: ReaderToolbarProps) {
  return (
    <header
      data-reader-chrome="toolbar"
      className={`fixed inset-x-0 top-0 z-30 bg-gradient-to-b from-black/85 to-transparent transition-transform duration-200 ${
        visible ? 'translate-y-0' : '-translate-y-full'
      }`}
      aria-hidden={!visible}
      inert={!visible}
    >
      <div className="flex h-12 items-center gap-1 px-1.5">
        <button
          onClick={onBack}
          aria-label="Kembali"
          className="grid size-11 place-items-center rounded-full text-white/90 active:bg-white/10"
        >
          <IconAngleLeft className="size-4" />
        </button>
        {onHome && (
          <button
            onClick={onHome}
            aria-label="Beranda"
            className="grid size-11 place-items-center rounded-full text-white/90 active:bg-white/10"
          >
            <IconHouse className="size-4" />
          </button>
        )}
        <div className="min-w-0 flex-1">
          <p className="truncate font-display text-[13px] font-semibold text-white">{title}</p>
          {subtitle && <p className="truncate text-[10.5px] text-white/60">{subtitle}</p>}
        </div>
        {badge && <span className="shrink-0">{badge}</span>}
        {heart && (
          <span className="grid size-10 shrink-0 place-items-center text-white/90">
            {heart}
          </span>
        )}
        {chip && (
          <span className="shrink-0 rounded-[5px] bg-brand-red px-2 py-[3px] text-[10.5px] font-semibold text-white">
            {chip}
          </span>
        )}
        {onDownload && (
          <button
            onClick={onDownload}
            aria-label="Simpan untuk dibaca offline"
            title="Simpan untuk dibaca offline"
            className="grid size-11 place-items-center rounded-full text-white/90 active:bg-white/10"
          >
            <IconBolt className="size-4" />
          </button>
        )}
        <button
          onClick={onShare}
          aria-label="Bagikan"
          className="grid size-11 place-items-center rounded-full text-white/90 active:bg-white/10"
        >
          <IconShare className="size-4" />
        </button>
        <button
          onClick={onMore}
          aria-label="Menu"
          className="grid size-11 place-items-center rounded-full text-white/90 active:bg-white/10"
        >
          <IconEllipsisV className="size-4" />
        </button>
      </div>
      <div className="h-[0.9px] w-full bg-black/20" />
    </header>
  )
}
