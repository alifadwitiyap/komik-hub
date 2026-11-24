import { useCallback, useState } from 'react'
import type { ReactNode } from 'react'
import { BATCH_MAX } from '../downloadBatch'

/**
 * Range picker 2-tap (parity Komiku+ v2.3.0): tap dua baris mana pun —
 * semua chapter di ANTARA keduanya (inklusif, menurut URUTAN TAMPIL) jadi
 * terpilih. Urutan tap bebas; yang penting ujung rentangnya. TANPA centang 1-1.
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

/** Tap berikutnya: anchor pertama → anchor kedua → ketiga → mulai lagi. */
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
 * Range lengkap (dua anchor) → slice dari earliest ke latest (inklusif).
 * Dipotong ke RANGE_MAX chapter PERTAMA dari range. `length` (jumlah chapter
 * yang benar-benar tersedia) opsional: kalau diberikan, rentang juga
 * di-clamp ke daftar nyata — indeks di luar daftar tidak pernah lolos
 * (sesi sebelumnya: 99 dipilih di daftar 5 → 30 diminta, 5 valid).
 * Belum lengkap / seluruhnya di luar daftar → null.
 */
export function rangeSlice(state: RangeAnchor, length?: number): RangeSlice | null {
  if (state.start === null || state.end === null) return null
  const raw = Math.abs(state.end - state.start) + 1
  const lo = Math.min(state.start, state.end)
  if (length !== undefined && (!Number.isFinite(length) || lo >= length)) return null
  const from = Math.max(0, lo)
  const room = length === undefined ? RANGE_MAX : Math.max(0, length - from)
  const count = Math.min(raw, RANGE_MAX, room)
  if (count <= 0) return null
  return { from, to: from + count - 1, raw, count, clamped: count < raw }
}

/** True kalau baris ini salah satu ujung rentang (index anchor). */
export function isAnchorIndex(state: RangeAnchor, index: number): boolean {
  return (
    (state.start !== null && index === state.start) ||
    (state.end !== null && index === state.end)
  )
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
  isAnchor: (index: number) => boolean
  inRange: (index: number) => boolean
}

/**
 * State range untuk daftar baris (urutan tampil). Dipakai dua halaman
 * series (unified + legacy) supaya perilakunya identik. `length` = jumlah
 * chapter yang tersedia di daftar saat ini (opsional; kalau diisi, seleksi
 * selalu clamp ke batas nyata).
 */
export function useRangeSelection(length?: number): RangeSelection {
  const [state, setState] = useState<RangeAnchor>(EMPTY_RANGE)
  const select = useCallback((index: number) => setState((s) => rangeTap(s, index)), [])
  const reset = useCallback(() => setState(EMPTY_RANGE), [])

  const slice = rangeSlice(state, length)
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
    isAnchor: (index: number) => isAnchorIndex(state, index),
    inRange: (index: number) => (slice !== null ? index >= slice.from && index <= slice.to : false),
  }
}

interface RangeSelectBarProps {
  count: number
  clamped?: boolean
  needEnd?: boolean
  busy?: boolean
  max?: number
  /** Kedua aksi unduh (cache offline + PDF), langsung terlihat. */
  onDownloadOffline: () => void
  onDownloadPdf: () => void
  children?: ReactNode
}

/**
 * Dock aksi seleksi (Floating Action Dock): counter "N dipilih · maks 30"
 * + dua tombol langsung (Offline di perangkat ini / PDF siap diambil).
 * Disabled kalau baru satu anchor (hint "Tap chapter kedua…"); range > 30 →
 * pesan clamp eksplisit. `children` = baris progres. `busy` menonaktifkan
 * keduanya.
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
  const disabled = busy || needEnd || count === 0
  return (
    <div
      role="region"
      aria-label="Pilih range unduhan"
      data-range-dock
      className="range-dock fixed inset-x-4 bottom-[calc(4.75rem+env(safe-area-inset-bottom))] z-30 rounded-xl border border-ink-800 bg-ink-900/95 p-3 shadow-lg shadow-black/40 backdrop-blur"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-[12px] font-semibold tabular-nums text-ink-200" aria-live="polite" aria-atomic="true">
          {count > 0 ? (
            <>{count} chapter dipilih <span className="text-ink-500">· maks {max}</span></>
          ) : (
            <span className="text-ink-500">Belum ada chapter dipilih</span>
          )}
        </p>
        <div className="flex flex-wrap gap-1.5" role="group" aria-label="Tipe unduhan">
          <button
            type="button"
            onClick={onDownloadOffline}
            disabled={disabled}
            aria-busy={busy}
            aria-label={busy ? 'Mengunduh chapter, mohon tunggu' : `Unduh ${count} chapter untuk baca offline di aplikasi — Offline di perangkat ini`}
            title={needEnd ? 'Tap chapter kedua untuk menyelesaikan rentang' : undefined}
            className="min-h-11 min-w-11 rounded-lg bg-brand-amber px-3 py-2.5 text-[11.5px] font-semibold leading-tight text-white transition-[transform,background-color,border-color,color] duration-150 ease-[var(--ease-out)] active:scale-[0.97] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-amber focus-visible:ring-offset-2 disabled:opacity-45"
          >
            <span className="block font-bold">{busy ? 'Mengunduh…' : 'Offline di perangkat ini'}</span>
            <span className="block text-[10px] font-normal opacity-85">baca tanpa internet</span>
          </button>
          <button
            type="button"
            onClick={onDownloadPdf}
            disabled={disabled}
            aria-busy={busy}
            aria-label={busy ? 'Menyiapkan PDF, mohon tunggu' : `Unduh ${count} chapter sebagai file PDF — PDF siap diambil`}
            className="min-h-11 min-w-11 rounded-lg border border-ink-600 bg-ink-850 px-3 py-2.5 text-[11.5px] font-semibold leading-tight text-ink-100 transition-[transform,background-color,border-color,color] duration-150 ease-[var(--ease-out)] active:scale-[0.97] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-amber focus-visible:ring-offset-2 disabled:opacity-45"
          >
            <span className="block font-bold">PDF siap diambil</span>
            <span className="block text-[10px] font-normal text-ink-400">file diunduh</span>
          </button>
        </div>
      </div>

      {/* Instruksi tetap terlihat; slot hint tidak menggeser baris saat tap pertama. */}
      <div className="mt-1.5" aria-live="polite">
        <p className="text-[11px] leading-4 text-ink-500">
          Tap dua chapter — semua di antaranya ikut terpilih, urutan bebas. Untuk satu chapter, tap chapter yang sama dua kali.
        </p>
        <div className="min-h-4">
          {needEnd ? (
            <p className="text-[11px] font-semibold leading-4 text-ink-500">Tap chapter kedua untuk menyelesaikan rentang</p>
          ) : clamped ? (
            <p className="text-[11px] font-semibold leading-4 text-brand-amber">Maksimal {max} chapter — {max} pertama yang diambil</p>
          ) : null}
        </div>
      </div>
      {children}
    </div>
  )
}
/**
 * Hitung berapa index seleksi rentang yang tidak lagi punya item di daftar
 * sepanjang `listLength` (daftar chapter menyusut setelah seleksi, atau
 * indeks di luar batas karena data baru). Murni — dipakai halaman untuk
 * memperingatkan user alih-alih diam-diam membuang chapter.
 */
export function outOfRangeCount(indices: readonly number[], listLength: number): number {
  if (listLength <= 0) return indices.length
  let n = 0
  for (const i of indices) if (i < 0 || i >= listLength) n += 1
  return n
}
