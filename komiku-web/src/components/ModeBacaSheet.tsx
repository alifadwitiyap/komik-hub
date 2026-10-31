import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { api } from '../api'
import { marathonHref } from '../readerSource'
import { useMarathonMemory } from '../hooks/useMarathonMemory'
import { SPEED_KEDUA, SPEED_PERTAMA } from '../hooks/useAutoScroll'

export interface ModeBacaSheetProps {
  /** id chapter aktif — cadangan kalau series tidak bisa di-resolve. */
  chapterId: string
  /** id series asli — dipakai untuk mulai maraton dari chapter PALING AWAL. */
  seriesId: number | string | null
  /** tombol tutup sheet */
  onClose: () => void
  /** state Putar Otomatis */
  autoOn: boolean
  onAutoToggle: (v: boolean) => void
  speed: number
  onSpeed: (v: number) => void
}

/**
 * Sheet "Pilih Mode Baca" — meniru opsi reader Komiku+:
 * - Gulir Halaman (manual, "Gulir halaman dengan sentuhan manual")
 * - Putar Otomatis ("Ketuk tombol putar otomatis di bawah untuk memulai"),
 *   dengan Kecepatan Pertama / Kecepatan Kedua
 * - Baca Marathon ("Putar ke chapter selanjutnya tanpa ada hambatan cocok
 *   untuk kamu yang sedang maraton.") — mulai dari chapter paling awal series,
 *   supaya rantai marathon benar-benar berjalan.
 */
export default function ModeBacaSheet({
  chapterId,
  seriesId,
  onClose,
  autoOn,
  onAutoToggle,
  speed,
  onSpeed,
}: ModeBacaSheetProps) {
  const navigate = useNavigate()
  const [preparing, setPreparing] = useState(false)
  const marathon = useMarathonMemory()

  /**
   * "Baca Marathon" — MELANJUTKAN sesi maraton tersimpan kalau ada.
   *
   * Dulu selalu lompat ke chapter PALING AWAL series, jadi setiap kali tombol
   * ini ditekan pembaca kehilangan posisinya dan mulai dari nol. Sekarang:
   * sesi tersimpan menang; chapter paling awal hanya dipakai kalau belum
   * pernah maraton di series ini.
   */
  const startMarathon = async () => {
    onClose()
    // 1. sesi tersimpan untuk series ini (kalau ada). Identitas series di
    //    reader = handle unified ATAU id manga numerik (flow komiku lama).
    const seriesKey = seriesId == null ? null : String(seriesId)
    const saved = seriesKey ? marathon.forHandle(seriesKey) : null
    if (saved) {
      navigate(marathonHref(saved.chapterKey))
      return
    }
    if (!seriesId) {
      navigate(`/maraton/${chapterId}`)
      return
    }
    setPreparing(true)
    try {
      const d = await api.series(seriesId)
      // chapters terurut TERBARU -> TERLAMA; ambil paling awal
      const oldest = d.chapters.length > 0 ? d.chapters[d.chapters.length - 1] : null
      navigate(`/maraton/${oldest?.id ?? chapterId}`)
    } catch {
      navigate(`/maraton/${chapterId}`)
    } finally {
      setPreparing(false)
    }
  }
  return (
    <div className="fixed inset-0 z-30 flex items-end justify-center bg-black/60" onClick={onClose}>
      <div
        className="w-full max-w-md rounded-t-2xl border-t border-ink-700 bg-ink-900 pb-6"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-4 py-3">
          <h2 className="font-display text-[15px] font-semibold text-ink-100">Pilih Mode Baca</h2>
          <button
            onClick={onClose}
            aria-label="Tutup"
            className="rounded-lg p-1.5 text-ink-400 hover:bg-white/10 hover:text-ink-200"
          >
            <svg viewBox="0 0 24 24" className="size-5" fill="none" stroke="currentColor" strokeWidth="1.9">
              <path d="M6 6l12 12M18 6L6 18" strokeLinecap="round" />
            </svg>
          </button>
        </div>

        <div className="space-y-1.5 px-3">
          {/* Gulir Halaman — mode manual (aktif saat auto scroll mati) */}
          <button
            onClick={() => onAutoToggle(false)}
            className={`flex w-full items-center gap-3 rounded-xl border px-3.5 py-3 text-left transition-colors ${
              !autoOn
                ? 'border-brand-amber-dim bg-brand-amber-dim/10'
                : 'border-ink-700 hover:bg-white/5'
            }`}
          >
            <Icon name="hand" />
            <span className="min-w-0 flex-1">
              <span className="block text-[13px] font-semibold text-ink-100">Gulir Halaman</span>
              <span className="block text-[11px] text-ink-400">Gulir halaman dengan sentuhan manual</span>
            </span>
            {!autoOn && <Check />}
          </button>

          {/* Putar Otomatis */}
          <button
            onClick={() => onAutoToggle(true)}
            className={`flex w-full items-center gap-3 rounded-xl border px-3.5 py-3 text-left transition-colors ${
              autoOn
                ? 'border-brand-amber-dim bg-brand-amber-dim/10'
                : 'border-ink-700 hover:bg-white/5'
            }`}
          >
            <Icon name="play" />
            <span className="min-w-0 flex-1">
              <span className="block text-[13px] font-semibold text-ink-100">Putar Otomatis</span>
              <span className="block text-[11px] text-ink-400">
                Ketuk tombol putar otomatis di bawah untuk memulai
              </span>
            </span>
            {autoOn && <Check />}
          </button>

          {autoOn && (
            <div className="flex gap-1.5 px-1 pb-1">
              {[
                { v: SPEED_PERTAMA, label: 'Kecepatan Pertama' },
                { v: SPEED_KEDUA, label: 'Kecepatan Kedua' },
              ].map(({ v, label }) => (
                <button
                  key={v}
                  onClick={() => onSpeed(v)}
                  className={`flex-1 rounded-lg px-2 py-1.5 text-[11.5px] font-semibold transition-colors ${
                    speed === v
                      ? 'bg-brand-amber text-ink-950'
                      : 'border border-ink-600 text-ink-300 hover:bg-white/5'
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>
          )}

          {/* Baca Marathon — mulai dari chapter paling awal series */}
          <button
            onClick={startMarathon}
            disabled={preparing}
            className="mt-2 flex w-full items-center gap-3 rounded-xl border border-ink-700 bg-ink-850 px-3.5 py-3 text-left transition-colors hover:border-ink-600 disabled:opacity-60"
          >
            <Icon name="stack" />
            <span className="min-w-0 flex-1">
              <span className="block text-[13px] font-bold text-brand-amber">
                {preparing ? 'Menyiapkan maraton…' : 'Baca Marathon'}
              </span>
              <span className="block text-[11px] text-ink-400">
                Putar ke chapter selanjutnya tanpa ada hambatan cocok untuk kamu yang sedang maraton.
              </span>
            </span>
          </button>
        </div>
      </div>
    </div>
  )
}

function Check() {
  return (
    <svg viewBox="0 0 24 24" className="size-4 shrink-0 text-brand-amber" fill="none" stroke="currentColor" strokeWidth="2.4">
      <path d="M4 12.5 10 18 20 6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

function Icon({ name }: { name: 'hand' | 'play' | 'stack' }) {
  const common = { viewBox: '0 0 24 24', className: 'size-5 shrink-0 text-ink-300', fill: 'none', stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const }
  if (name === 'play') {
    return (
      <svg {...common}>
        <circle cx="12" cy="12" r="9" />
        <path d="M10 8.5l6 3.5-6 3.5z" />
      </svg>
    )
  }
  if (name === 'stack') {
    return (
      <svg {...common}>
        <path d="M12 3 3 7.5l9 4.5 9-4.5L12 3z" />
        <path d="M3 12.5 12 17l9-4.5" />
        <path d="M3 17 12 21.5 21 17" />
      </svg>
    )
  }
  return (
    <svg {...common}>
      <path d="M8 13V5a2 2 0 0 1 4 0v6" />
      <path d="M12 11V4a2 2 0 0 1 4 0v7" />
      <path d="M16 11.5V6a2 2 0 0 1 4 0v8a6 6 0 0 1-6 6h-1.5a6 6 0 0 1-5.2-3l-2.1-3.6a2 2 0 0 1 3.4-2l1.4 2" />
    </svg>
  )
}
