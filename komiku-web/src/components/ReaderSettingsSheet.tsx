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
  /** Ekspor chapter saat ini sebagai PDF (server-side → tab Unduhan). */
  onExportPdf?: () => void
  /** Simpan chapter saat ini ke cache offline (service worker). */
  onOfflineDownload?: () => void
  /** true = aksi PDF sedang berjalan (disable tombol). */
  exportingPdf?: boolean
  /** true = aksi unduh offline sedang berjalan (disable tombol). */
  downloading?: boolean
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
  onExportPdf,
  onOfflineDownload,
  exportingPdf,
  downloading,
}: ReaderSettingsSheetProps) {
  if (!open) return null
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/50" onClick={onClose}>
      <div
        className="w-full max-w-md rounded-t-2xl bg-ink-900 pb-6"
        onClick={(e) => e.stopPropagation()}
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

        {(onExportPdf || onOfflineDownload) && (
          <>
            <div className="mt-3 flex items-center gap-2 px-4">
              <span className="h-px flex-1 bg-ink-800" />
              <span className="text-[10.5px] font-semibold uppercase tracking-wide text-ink-500">
                Unduhan
              </span>
              <span className="h-px flex-1 bg-ink-800" />
            </div>
            {onExportPdf && (
              <Row
                icon={<IconBolt className="size-4" />}
                label={exportingPdf ? 'Membuat PDF…' : 'Ekspor PDF'}
                value={exportingPdf ? 'Mohon tunggu' : undefined}
                disabled={exportingPdf}
                onClick={onExportPdf}
              />
            )}
            {onOfflineDownload && (
              <Row
                icon={<IconBolt className="size-4" />}
                label={downloading ? 'Mengunduh offline…' : 'Simpan untuk dibaca offline'}
                value={downloading ? 'Mohon tunggu' : undefined}
                disabled={downloading}
                onClick={onOfflineDownload}
              />
            )}
          </>
        )}

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

function Row({
  icon,
  label,
  value,
  toggle,
  onToggle,
  onClick,
  disabled,
}: {
  icon: React.ReactNode
  label: string
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
      <span className="min-w-0 flex-1 text-[13px] font-medium text-ink-100">{label}</span>
      {value && <span className="text-[12px] text-ink-500">{value}</span>}
      {toggle !== undefined && (
        <button
          role="switch"
          aria-checked={toggle}
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
