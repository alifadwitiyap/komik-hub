import { IconExpand, IconXmark } from '../icons'

interface ReaderFullscreenButtonProps {
  /** layar penuh sedang aktif (native atau immersive) */
  active: boolean
  /** false = sembunyikan (chrome ikut arah scroll) */
  visible: boolean
  onToggle: () => void
}

/**
 * Tombol layar penuh manual reader — SATU komponen untuk Reader dan Marathon
 * supaya penampilannya tidak pernah menyimpang antar mode.
 *
 * Ini SATU-SATUNYA kontrol fullscreen (auto-fullscreen dihapus): tap pada
 * halaman bacaan hanya toggle chrome, tidak masuk/keluar layar penuh.
 *
 * DIBEDAKAN dari kontrol halaman melingkar ("Muat ulang"/"Coba lagi"):
 * - bentuk   : kotak membulat 44×44 (ikon saja) — bukan lingkaran 80 px
 * - warna    : biru brand solid — kontrol halaman hitam transparan
 * - posisi   : kanan-atas, tepat di bawah toolbar — kontrol halaman di tengah
 * - label    : teks "Layar penuh"/"Keluar" muncul saat layar penuh aktif
 *
 * Saat idle tombol sengaja ikon-saja: pil berteks selebar ~112 px menutupi
 * kredit/panel di pojok kanan-atas halaman manga (terlihat pada halaman yang
 * punya "Credits" di sana). 44×44 = target sentuh minimum yang tetap nyaman.
 */
export default function ReaderFullscreenButton({
  active,
  visible,
  onToggle,
}: ReaderFullscreenButtonProps) {
  const expanded = active
  const label = active ? 'Keluar layar penuh' : 'Masuk layar penuh'
  return (
    <button
      type="button"
      aria-label={label}
      aria-pressed={active}
      title={label}
      data-testid="reader-fullscreen-toggle"
      data-fs-toggle=""
      onClick={onToggle}
      className={`fixed right-[max(0.75rem,env(safe-area-inset-right))] top-[calc(env(safe-area-inset-top)+3.5rem)] z-40 flex h-11 select-none touch-manipulation items-center justify-center gap-1.5 rounded-xl border shadow-lg transition-opacity duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white focus-visible:ring-offset-2 focus-visible:ring-offset-black/50 ${
        expanded ? 'px-3' : 'w-11 px-0'
      } ${
        active
          ? 'border-white/40 bg-black/75 text-white'
          : 'border-brand-amber-soft bg-brand-amber text-white'
      } ${visible ? 'opacity-100' : 'pointer-events-none opacity-0'}`}
      aria-hidden={!visible}
      inert={!visible}
    >
      {active ? (
        <IconXmark className="size-4 shrink-0" aria-hidden="true" />
      ) : (
        <IconExpand className="size-4 shrink-0" aria-hidden="true" />
      )}
      {expanded && (
        <span className="whitespace-nowrap text-[12px] font-semibold leading-none">
          {active ? 'Keluar' : 'Layar penuh'}
        </span>
      )}
    </button>
  )
}
