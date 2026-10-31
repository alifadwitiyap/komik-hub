import { IconPersonRunning, IconXmark } from '../icons'

interface ReaderMarathonToggleProps {
  /** true = sedang dalam mode maraton (menampilkan "Keluar") */
  active: boolean
  /** false = sembunyikan (chrome ikut arah scroll) */
  visible: boolean
  onToggle: () => void
}

/**
 * Tombol toggle MODE MARATON — SATU komponen untuk Reader dan Marathon.
 *
 * Fungsi: masuk mode maraton (dari reader biasa) atau keluar (dari maraton).
 * Diletakkan di KIRI-atas, berlawanan dengan tombol layar penuh (kanan-atas),
 * supaya dua kontrol penting tidak berdekatan dan kecil kemungkinan salah
 * pencet. Gaya visual identik dengan `ReaderFullscreenButton` (44×44,
 * rounded, ikon + teks saat aktif) agar konsisten.
 *
 * Saat tidak aktif (reader biasa): ikon lari, teks "Maraton" saat hover/aktif.
 * Saat aktif (maraton): ikon X, teks "Keluar".
 */
export default function ReaderMarathonToggle({
  active,
  visible,
  onToggle,
}: ReaderMarathonToggleProps) {
  const label = active ? 'Keluar maraton' : 'Masuk maraton'
  return (
    <button
      type="button"
      aria-label={label}
      aria-pressed={active}
      title={label}
      data-testid="reader-marathon-toggle"
      onClick={onToggle}
      className={`fixed left-[max(0.75rem,env(safe-area-inset-left))] top-[calc(env(safe-area-inset-top)+3.5rem)] z-40 flex h-11 select-none touch-manipulation items-center justify-center gap-1.5 rounded-xl border shadow-lg transition-opacity duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white focus-visible:ring-offset-2 focus-visible:ring-offset-black/50 ${
        active ? 'px-3' : 'w-11 px-0'
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
        <IconPersonRunning className="size-4 shrink-0" aria-hidden="true" />
      )}
      {active && (
        <span className="whitespace-nowrap text-[12px] font-semibold leading-none">
          Keluar maraton
        </span>
      )}
    </button>
  )
}
