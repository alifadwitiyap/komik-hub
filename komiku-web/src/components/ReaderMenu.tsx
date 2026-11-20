import { useEffect, useRef } from 'react'
import { useSheetPresence } from '../hooks/useSheetPresence'
import { useSheetDrag } from '../hooks/useSheetDrag'
import '../styles/sheets.css'
import {
  IconBars,
  IconPersonRunning,
  IconPlaySolid,
  IconMoonOverSun,
  IconSliders,
  IconExpand,
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
  prefetchMode: 'seimbang',
  direction: 'ltr',
  zoom: 1,
}

interface ReaderMenuProps {
  open: boolean
  settings: ReaderSettings
  /** true saat native/immersive fullscreen aktif (dari useAutoFullscreen). */
  fullscreenActive?: boolean
  onClose: () => void
  onChange: (patch: Partial<ReaderSettings>) => void
  onOpenSettings: () => void
  /** Memanggil useAutoFullscreen().requestEnter()/reset() dari halaman. */
  onToggleFullscreen: () => void
}

/**
 * Menu reader — enam aksi dalam satu bilah bawah: Mode Baca, Maraton,
 * Putar Otomatis, Perisai Malam, Layar penuh, Preferensi.
 */
export default function ReaderMenu({
  open,
  settings,
  fullscreenActive = false,
  onClose,
  onChange,
  onOpenSettings,
  onToggleFullscreen,
}: ReaderMenuProps) {
  const panelRef = useRef<HTMLDivElement>(null)
  const prevRef = useRef<HTMLElement | null>(null)
  const mounted = useSheetPresence(open)
  const drag = useSheetDrag({ panelRef, onClose, enabled: open })

  useEffect(() => {
    if (!open) return
    prevRef.current = document.activeElement as HTMLElement | null
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
      if (e.key !== 'Tab' || !panelRef.current) return
      const focusables = Array.from(
        panelRef.current.querySelectorAll<HTMLElement>(
          'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
        ),
      ).filter((el) => !el.hasAttribute('disabled'))
      if (focusables.length === 0) return
      const first = focusables[0]
      const last = focusables[focusables.length - 1]
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault()
        last.focus()
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault()
        first.focus()
      }
    }
    document.addEventListener('keydown', onKey)
    const raf = requestAnimationFrame(() => {
      panelRef.current?.querySelector<HTMLElement>('button')?.focus({ preventScroll: true })
    })
    return () => {
      document.removeEventListener('keydown', onKey)
      cancelAnimationFrame(raf)
      // Tombol kembali dari menu mengembalikan fokus ke kontrol pemicu.
      prevRef.current?.focus?.({ preventScroll: true })
    }
  }, [open, onClose])

  if (!mounted) return null
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
      ariaPressed: settings.marathon,
      onClick: () => onChange({ marathon: !settings.marathon }),
    },
    {
      key: 'auto',
      label: 'Putar Otomatis',
      icon: <IconPlaySolid className="size-5" />,
      active: settings.autoScroll,
      ariaPressed: settings.autoScroll,
      onClick: () => onChange({ autoScroll: !settings.autoScroll }),
    },
    {
      key: 'night',
      label: 'Perisai Malam',
      icon: <IconMoonOverSun className="size-5" />,
      active: settings.nightShift,
      ariaPressed: settings.nightShift,
      onClick: () => onChange({ nightShift: !settings.nightShift }),
    },
    {
      key: 'fullscreen',
      label: 'Layar penuh',
      icon: <IconExpand className="size-5" />,
      active: fullscreenActive,
      ariaPressed: fullscreenActive,
      onClick: () => {
        onToggleFullscreen()
        onClose()
      },
    },
    {
      key: 'settings',
      label: 'Preferensi',
      icon: <IconSliders className="size-5" />,
      active: false,
      onClick: onOpenSettings,
    },
  ]
  // z-50, setara sheet preferensi/pemilih chapter: kontrol halaman
  // ("Muat ulang"/"Coba lagi") di-portal ke <body> dengan z-40 dan selalu
  // menang atas #root pada z-index yang sama — tanpa ini tombol melingkar
  // itu melayang DI ATAS backdrop menu yang sedang terbuka.
  return (
    <div className={`fixed inset-0 z-50 flex items-end bg-black/40 ${open ? 'sheet-backdrop' : 'sheet-backdrop-closing'}`} onClick={onClose}>
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label="Menu reader"
        aria-hidden={!open}
        inert={!open}
        className={`sheet-panel w-full rounded-t-2xl bg-night-dark/95 px-2 pb-[calc(1.25rem+env(safe-area-inset-bottom))] pt-3 backdrop-blur ${open ? '' : 'sheet-closing'}`}
        onClick={(e) => e.stopPropagation()}
      >
        {/* 44px hit area; 36×4px visual. touch-none hanya di sini supaya grid
            tombol di bawah tidak ikut terseret. */}
        <div
          {...drag}
          aria-hidden="true"
          className="pointer-events-auto flex h-11 touch-none select-none items-start justify-center"
        >
          <span className="h-1 w-9 rounded-full bg-white/20" />
        </div>
        <div className="grid grid-cols-3 gap-y-2">
          {items.map((it) => (
            <button
              key={it.key}
              type="button"
              onClick={it.onClick}
              aria-pressed={'ariaPressed' in it ? it.ariaPressed : undefined}
              className="flex min-h-11 w-full flex-col items-center gap-1.5 rounded-xl py-2 active:bg-white/10 active:scale-[0.97] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/70"
            >
              <span
                className={`grid size-10 place-items-center rounded-full ${
                  it.active ? 'bg-brand-red text-white' : 'bg-white/10 text-white/85'
                }`}
              >
                {it.icon}
              </span>
              <span className="text-center text-[12px] font-medium leading-tight text-white/85">{it.label}</span>
            </button>
          ))}
        </div>

      </div>
    </div>
  )
}
