import { useCallback, useState } from 'react'
import type { ReactNode } from 'react'
import { BATCH_MAX } from '../downloadBatch'

/**
 * Range picker 2-tap (parity Komiku+ v2.3.0): tap baris pertama = anchor
 * "Awal", tap baris kedua = anchor "Akhir", semua chapter di ANTARA keduanya
 * (inklusif, menurut URUTAN TAMPIL) jadi terpilih. TANPA centang 1-1.
 *
 * Logika murni + hook hidup di file terpisah supaya bisa dipakai halaman lain
 * (Series legacy) dan diuji tanpa React/DOM.
 */

/** Maksimal chapter per range/batch (spek user: 30). */
export const RANGE_MAX = BATCH_MAX

export interface RangeAnchor {
  /** index baris anchor awal (null = belum ada anchor) */
  start: number | null
  /** index baris anchor akhir (null = baru satu anchor) */
  end: number | null
}

export const EMPTY_RANGE: RangeAnchor = { start: null, end: null }

/** Tap berikutnya: anchor pertama → "Awal", kedua → "Akhir", ketiga → mulai lagi. */
export function rangeTap(state: RangeAnchor, index: number): RangeAnchor {
  if (state.start === null) return { start: index, end: null }
  if (state.end === null) return { start: state.start, end: index }
  return { start: index, end: null }
}

export interface RangeSlice {
  /** index baris pertama yang terpilih (urutan tampil) */
  from: number
  /** index baris terakhir yang terpilih, sudah di-clamp ke RANGE_MAX */
  to: number
  /** jumlah chapter sesuai range sebelum clamp (> RANGE_MAX saat dipotong) */
  raw: number
  /** jumlah chapter yang benar-benar terpilih (<= RANGE_MAX) */
  count: number
  /** true kalau range lebih besar dari RANGE_MAX dan dipotong */
  clamped: boolean
}

/**
 * Range lengkap (dua anchor) → slice dari earliest ke latest (inklusif),
 * dipotong ke RANGE_MAX chapter PERTAMA dari range. Belum lengkap → null.
 */
export function rangeSlice(state: RangeAnchor): RangeSlice | null {
  if (state.start === null || state.end === null) return null
  const from = Math.min(state.start, state.end)
  const raw = Math.abs(state.end - state.start) + 1
  const count = Math.min(raw, RANGE_MAX)
  return { from, to: from + count - 1, raw, count, clamped: raw > RANGE_MAX }
}

/** Label kecil di baris: "Awal" / "Akhir" / null (bukan anchor). */
export function anchorLabel(state: RangeAnchor, index: number): string | null {
  if (state.start !== null && index === state.start) return 'Awal'
  if (state.end !== null && index === state.end) return 'Akhir'
  return null
}

export interface RangeSelection {
  state: RangeAnchor
  /** daftar index baris yang terpilih (sudah clamp RANGE_MAX) */
  indices: number[]
  /** jumlah chapter terpilih (0 kalau baru satu anchor) */
  count: number
  /** jumlah chapter sesuai range sebelum clamp */
  raw: number
  /** true kalau range dipotong ke RANGE_MAX chapter pertama */
  clamped: boolean
  /** true kalau baru ada satu anchor → belum bisa diunduh */
  needEnd: boolean
  select: (index: number) => void
  reset: () => void
  isAnchor: (index: number) => string | null
  inRange: (index: number) => boolean
}

/**
 * State range untuk daftar baris (urutan tampil). Dipakai dua halaman
 * series (unified + legacy) supaya perilakunya identik.
 */
export function useRangeSelection(): RangeSelection {
  const [state, setState] = useState<RangeAnchor>(EMPTY_RANGE)
  const select = useCallback((index: number) => setState((s) => rangeTap(s, index)), [])
  const reset = useCallback(() => setState(EMPTY_RANGE), [])

  const slice = rangeSlice(state)
  const indices =
    slice === null ? [] : Array.from({ length: slice.count }, (_, k) => slice.from + k)

  return {
    state,
    indices,
    count: slice?.count ?? 0,
    raw: slice?.raw ?? 0,
    clamped: slice?.clamped ?? false,
    needEnd: state.start !== null && state.end === null,
    select,
    reset,
    isAnchor: (index: number) => anchorLabel(state, index),
    inRange: (index: number) => (slice !== null ? index >= slice.from && index <= slice.to : false),
  }
}

interface RangeSelectBarProps {
  count: number
  clamped?: boolean
  needEnd?: boolean
  busy?: boolean
  max?: number
  /** Kedua aksi unduh (cache offline + PDF). Satu tombol dulu, setelah
   *  diklik tampil pilihan jenis unduhan. */
  onDownloadOffline: () => void
  onDownloadPdf: () => void
  children?: ReactNode
}

/**
 * Bar info seleksi (menggantikan UI centang): "N dipilih · maks 30" +
 * tombol "Unduh (N)". Disabled kalau baru satu anchor (hint "Pilih chapter
 * akhir"); range > 30 → pesan clamp eksplisit. `children` = baris progres.
 *
 * Alur jenis unduhan: klik "Unduh (N)" → dua tombol pilihan (Offline / PDF)
 * muncul di tempatnya; salah satu diklik → aksi dijalankan + bar kembali ke
 * tombol tunggal. `busy` menonaktifkan keduanya.
 */
export function RangeSelectBar({
  count,
  clamped = false,
  needEnd = false,
  busy = false,
  max = RANGE_MAX,
  onDownloadOffline,
  onDownloadPdf,
  children,
}: RangeSelectBarProps) {
  const [showType, setShowType] = useState(false)
  const disabled = busy || needEnd || count === 0
  return (
    <div className="rounded-xl border border-ink-800 bg-ink-900 p-3">
      <div className="flex items-center justify-between gap-2">
        <p className="text-[12px] font-semibold text-ink-200">
          {count} dipilih <span className="text-ink-500">· maks {max}</span>
        </p>
        {!showType ? (
          <button
            type="button"
            onClick={() => setShowType(true)}
            disabled={disabled}
            title={needEnd ? 'Pilih chapter akhir' : undefined}
            className="rounded-lg bg-brand-amber px-3 py-1.5 text-[11.5px] font-bold text-ink-950 disabled:opacity-50"
          >
            {busy ? 'Mengunduh…' : `Unduh (${count})`}
          </button>
        ) : (
          <div className="flex gap-1.5">
            <button
              type="button"
              onClick={() => {
                setShowType(false)
                onDownloadOffline()
              }}
              disabled={busy}
              className="rounded-lg border border-brand-amber-dim bg-brand-amber/10 px-2.5 py-1.5 text-[11.5px] font-semibold text-brand-amber disabled:opacity-50"
            >
              Offline
            </button>
            <button
              type="button"
              onClick={() => {
                setShowType(false)
                onDownloadPdf()
              }}
              disabled={busy}
              className="rounded-lg border border-ink-600 px-2.5 py-1.5 text-[11.5px] font-semibold text-ink-200 hover:bg-ink-850 disabled:opacity-50"
            >
              PDF
            </button>
          </div>
        )}
      </div>

      {needEnd && (
        <p className="mt-1.5 text-[11px] font-semibold text-ink-500">Pilih chapter akhir</p>
      )}
      {clamped && (
        <p className="mt-1.5 text-[11px] font-semibold text-brand-amber">
          Maksimal {max} chapter — {max} pertama yang diambil
        </p>
      )}
      {children}
    </div>
  )
}
