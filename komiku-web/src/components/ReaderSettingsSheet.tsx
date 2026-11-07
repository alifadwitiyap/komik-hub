import { useEffect, useRef } from 'react'
import {
  IconBars,
  IconPersonRunning,
  IconPlaySolid,
  IconBrightness,
  IconMoonOverSun,
  IconExpand,
  IconLightbulb,
  IconXmark,
  IconBolt,
} from '../icons'
import type { ReaderSettings } from './ReaderMenu'

interface ReaderSettingsSheetProps {
  open: boolean
  settings: ReaderSettings
  onClose: () => void
  onChange: (patch: Partial<ReaderSettings>) => void
  onReset: () => void
  /** Slot: aksi unduhan (Ekspor PDF / Simpan offline). */
  downloadActions?: React.ReactNode
  /** Slot: seksi Maraton (Mulai maraton dari awal). */
  marathonActions?: React.ReactNode
}

/**
 * Sheet preferensi reader — replika sheet_reader_settings APK:
 * baris dengan switch: Mode Baca (nilai), Maraton, Putar Otomatis
 * (+Kecepatan Pertama/Kedua), Kecerahan Layar (+slider), Perisai Malam,
 * Layar Tetap Menyala, Layar Penuh, lalu Kembalikan Semula.
 */
export default function ReaderSettingsSheet({
  open,
  settings,
  onClose,
  onChange,
  onReset,
  downloadActions,
  marathonActions,
}: ReaderSettingsSheetProps) {
  const panelRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null
    panelRef.current?.focus()
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('keydown', onKey)
      prev?.focus()
    }
  }, [onClose])

  if (!open) return null
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/50" onClick={onClose}>
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        tabIndex={-1}
        className="sheet-panel w-full max-w-md rounded-t-2xl bg-ink-900 pb-6 outline-none"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={trapFocus}
      >
        <div className="flex items-center justify-between px-4 py-3">
          <h2 className="font-display text-[15px] font-bold text-ink-100">Preferensi</h2>
          <button onClick={onClose} aria-label="Tutup" className="p-1.5 text-ink-500">
            <IconXmark className="size-4" />
          </button>
        </div>
        <div className="h-px bg-ink-800" />

        <Row
          icon={<IconBars className="size-4" />}
          label="Mode Baca"
          value={settings.readMode === 'scroll' ? 'Gulir Halaman' : 'Webtoon'}
          onClick={() => onChange({ readMode: settings.readMode === 'scroll' ? 'webtoon' : 'scroll' })}
        />
        <Row
          icon={<IconPersonRunning className="size-4" />}
          label="Maraton"
          labelId="reader-marathon-label"
          toggle={settings.marathon}
          onToggle={(v) => onChange({ marathon: v })}
        />
        <Row
          icon={<IconPlaySolid className="size-4" />}
          label="Putar Otomatis"
          toggle={settings.autoScroll}
          onToggle={(v) => onChange({ autoScroll: v })}
        />
        {settings.autoScroll && (
          <div className="flex gap-2 px-4 pb-2">
            {([1, 2] as const).map((s) => (
              <button
                key={s}
                onClick={() => onChange({ speed: s })}
                className={`flex-1 rounded-lg border px-2 py-1.5 text-[11.5px] font-semibold ${
                  settings.speed === s
                    ? 'border-brand-amber bg-brand-amber/10 text-brand-amber'
                    : 'border-ink-300 text-ink-300'
                }`}
              >
                Kecepatan {s === 1 ? 'Pertama' : 'Kedua'}
              </button>
            ))}
          </div>
        )}
        <Row
          icon={<IconBrightness className="size-4" />}
          label="Kecerahan Layar"
          value={`${settings.brightness}%`}
        />
        <div className="px-4 pb-2">
          <input
            type="range"
            min={20}
            max={100}
            value={settings.brightness}
            aria-label="Kecerahan Layar"
            aria-valuetext={`${settings.brightness}%`}
            onChange={(e) => onChange({ brightness: Number(e.target.value) })}
            className="w-full accent-brand-amber"
          />
        </div>
        <Row
          icon={<IconMoonOverSun className="size-4" />}
          label="Perisai Malam"
          toggle={settings.nightShift}
          onToggle={(v) => onChange({ nightShift: v })}
        />
        <Row
          icon={<IconLightbulb className="size-4" />}
          label="Layar Tetap Menyala"
          toggle={settings.keepScreenOn}
          onToggle={(v) => onChange({ keepScreenOn: v })}
        />
        <Row
          icon={<IconExpand className="size-4" />}
          label="Layar Penuh"
          toggle={settings.fullscreen}
          onToggle={(v) => onChange({ fullscreen: v })}
        />
        <Row icon={<IconBolt className="size-4" />} label="Prefetch" />
        <div className="flex gap-2 px-4 pb-2">
          {(
            [
              ['hemat', 'Hemat'],
              ['seimbang', 'Seimbang'],
              ['siapkan', 'Siapkan lebih banyak'],
            ] as const
          ).map(([mode, label]) => (
            <button
              key={mode}
              onClick={() => onChange({ prefetchMode: mode })}
              className={`flex-1 rounded-lg border px-2 py-1.5 text-[11.5px] font-semibold ${
                settings.prefetchMode === mode
                  ? 'border-brand-amber bg-brand-amber/10 text-brand-amber'
                  : 'border-ink-300 text-ink-300'
              }`}
            >
              {label}
            </button>
          ))}
        </div>

        {downloadActions}

        {marathonActions}

        <div className="mt-2 px-4">
          <button
            onClick={onReset}
            className="w-full rounded-xl border border-ink-300 py-2.5 text-[12.5px] font-semibold text-ink-300"
          >
            Kembalikan Semula
          </button>
        </div>
      </div>
    </div>
  )
}

function trapFocus(e: React.KeyboardEvent<HTMLElement>) {
  if (e.key !== 'Tab') return
  const root = e.currentTarget
  const focusables = Array.from(
    root.querySelectorAll<HTMLElement>(
      'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
    )
  ).filter((el) => !el.hasAttribute('disabled') && el.offsetParent !== null)
  if (focusables.length === 0) {
    e.preventDefault()
    return
  }
  const first = focusables[0]
  const last = focusables[focusables.length - 1]
  if (e.shiftKey && (document.activeElement === first || document.activeElement === root)) {
    e.preventDefault()
    last.focus()
  } else if (!e.shiftKey && document.activeElement === last) {
    e.preventDefault()
    first.focus()
  }
}

export function Row({
  icon,
  label,
  labelId,
  value,
  toggle,
  onToggle,
  onClick,
  disabled,
}: {
  icon: React.ReactNode
  label: string
  labelId?: string
  value?: string
  toggle?: boolean
  onToggle?: (v: boolean) => void
  onClick?: () => void
  disabled?: boolean
}) {
  const clickable = onClick !== undefined
  return (
    <div
      role={clickable ? 'button' : undefined}
      tabIndex={clickable && !disabled ? 0 : undefined}
      aria-disabled={disabled || undefined}
      onClick={disabled ? undefined : onClick}
      onKeyDown={clickable && !disabled ? (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onClick() } } : undefined}
      className={`flex items-center gap-3 px-4 py-3 ${clickable ? `${disabled ? 'cursor-not-allowed opacity-50' : 'cursor-pointer select-none active:bg-ink-850'}` : ''}`}
    >
      <span className="grid size-8 place-items-center rounded-full bg-ink-850 text-ink-300">{icon}</span>
      <span id={labelId} className="min-w-0 flex-1 text-[13px] font-medium text-ink-100">{label}</span>
      {value && <span className="text-[12px] text-ink-500">{value}</span>}
      {toggle !== undefined && (
        <button
          role="switch"
          aria-checked={toggle}
          aria-labelledby={labelId}
          onClick={() => onToggle?.(!toggle)}
          className={`relative h-6 w-11 shrink-0 rounded-full transition-colors ${
            toggle ? 'bg-brand-amber' : 'bg-ink-700'
          }`}
        >
          <span
            className={`absolute top-0.5 size-5 rounded-full bg-white shadow transition-all ${
              toggle ? 'left-[22px]' : 'left-0.5'
            }`}
          />
        </button>
      )}
    </div>
  )
}
