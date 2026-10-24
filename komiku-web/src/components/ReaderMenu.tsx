import {
  IconBars,
  IconPersonRunning,
  IconPlaySolid,
  IconMoonOverSun,
  IconSliders,
} from '../icons'

export interface ReaderSettings {
  readMode: 'scroll' | 'webtoon'
  marathon: boolean
  autoScroll: boolean
  speed: 1 | 2
  brightness: number // 0..100
  nightShift: boolean
  keepScreenOn: boolean
  fullscreen: boolean
  /** Auto fullscreen setelah beberapa kali scroll turun. */
  autoFullscreen: boolean
  /** Berapa banyak gambar yang dihangatkan lebih awal (hemat kuota ↔ siap). */
  prefetchMode: 'hemat' | 'seimbang' | 'siapkan'
  /** Arah baca: 'ltr' (kiri→kanan, default) atau 'rtl' (kanan→kiri). */
  direction: 'ltr' | 'rtl'
  /** Zoom halaman: 1 = lebar penuh, >1 = diperbesar (1..3). */
  zoom: number
}

export const DEFAULT_SETTINGS: ReaderSettings = {
  readMode: 'scroll',
  marathon: false,
  autoScroll: false,
  speed: 1,
  brightness: 100,
  nightShift: false,
  keepScreenOn: false,
  fullscreen: false,
  autoFullscreen: true,
  prefetchMode: 'seimbang',
  direction: 'ltr',
  zoom: 1,
}

interface ReaderMenuProps {
  open: boolean
  settings: ReaderSettings
  onClose: () => void
  onChange: (patch: Partial<ReaderSettings>) => void
  onOpenSettings: () => void
}

/**
 * Menu reader (layout_reader_menu APK) — 5 aksi melayang di atas footer:
 * Mode Baca, Maraton, Putar Otomatis, Kecerahan, Perisai Malam.
 */
export default function ReaderMenu({
  open,
  settings,
  onClose,
  onChange,
  onOpenSettings,
}: ReaderMenuProps) {
  if (!open) return null
  const items = [
    {
      key: 'read_mode',
      label: 'Mode Baca',
      icon: <IconBars className="size-5" />,
      active: false,
      onClick: onOpenSettings,
    },
    {
      key: 'marathon',
      label: 'Maraton',
      icon: <IconPersonRunning className="size-5" />,
      active: settings.marathon,
      onClick: () => onChange({ marathon: !settings.marathon }),
    },
    {
      key: 'auto',
      label: 'Putar Otomatis',
      icon: <IconPlaySolid className="size-5" />,
      active: settings.autoScroll,
      onClick: () => onChange({ autoScroll: !settings.autoScroll }),
    },
    {
      key: 'night',
      label: 'Perisai Malam',
      icon: <IconMoonOverSun className="size-5" />,
      active: settings.nightShift,
      onClick: () => onChange({ nightShift: !settings.nightShift }),
    },
    {
      key: 'settings',
      label: 'Preferensi',
      icon: <IconSliders className="size-5" />,
      active: false,
      onClick: onOpenSettings,
    },
  ]
  return (
    <div className="fixed inset-0 z-40 flex items-end bg-black/40" onClick={onClose}>
      <div
        className="w-full rounded-t-2xl bg-night-dark/95 px-2 pb-5 pt-3 backdrop-blur"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-2 flex justify-center">
          <span className="h-1 w-10 rounded-full bg-white/25" />
        </div>
        <div className="flex justify-around">
          {items.map((it) => (
            <button
              key={it.key}
              onClick={it.onClick}
              className="flex w-16 flex-col items-center gap-1.5 rounded-xl py-2 active:bg-white/10"
            >
              <span
                className={`grid size-10 place-items-center rounded-full ${
                  it.active ? 'bg-brand-red text-white' : 'bg-white/10 text-white/85'
                }`}
              >
                {it.icon}
              </span>
              <span className="text-[9.5px] leading-tight text-white/75">{it.label}</span>
            </button>
          ))}
        </div>
        <p className="mt-2 text-center text-[10px] text-white/40">
          Ketuk sisi kanan/kiri layar untuk gulir halaman
        </p>
      </div>
    </div>
  )
}
