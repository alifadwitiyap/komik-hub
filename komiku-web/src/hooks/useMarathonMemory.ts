import { useCallback } from 'react'
import { getUser } from '../account'
import {
  findPosition,
  latestForHandle,
  marathonStoreKey,
  parsePositions,
  removeHandle,
  removePosition,
  serializePositions,
  upsertPosition,
  type MarathonPosition,
} from '../marathonMemory'
import { usePerAccountLocalStorage } from './usePerAccountLocalStorage'

/**
 * Store posisi baca MODE MARATON (per-akun, localStorage saja).
 *
 * Lihat `marathonMemory.ts` untuk alasan kenapa ini TERPISAH dari
 * `useProgress`: progress menyimpan satu posisi per series untuk riwayat,
 * maraton menyimpan posisi di dalam RANTAI chapter. Menyatukannya membuat
 * keduanya saling menimpa.
 *
 * Tidak ada sinkronisasi server — posisi rantai adalah keadaan device ini.
 */
export function useMarathonMemory() {
  const { entries, apply, entriesRef } = usePerAccountLocalStorage<MarathonPosition[]>({
    readKey: () => marathonStoreKey(getUser()),
    parse: parsePositions,
    serialize: serializePositions,
  })

  /** Simpan/perbarui posisi satu sesi maraton. */
  const save = useCallback(
    (pos: Omit<MarathonPosition, 'at'>) => {
      const next = upsertPosition(entriesRef.current, { ...pos, at: Date.now() })
      apply(next)
    },
    [apply, entriesRef],
  )

  /** Hapus posisi sesi (dipakai "Mulai dari awal"). */
  const clear = useCallback(
    (chapterKey: string) => {
      apply(removePosition(entriesRef.current, chapterKey))
    },
    [apply, entriesRef],
  )

  /** Hapus semua sesi satu series (dipakai "Mulai dari awal"). */
  const clearSeries = useCallback(
    (handle: string | null | undefined) => {
      apply(removeHandle(entriesRef.current, handle))
    },
    [apply, entriesRef],
  )

  /** Posisi satu sesi (blok pertama = `chapterKey`). */
  const forChapter = useCallback(
    (chapterKey: string) => findPosition(entriesRef.current, chapterKey),
    [entriesRef],
  )

  /** Sesi terbaru milik sebuah series — dipakai "Lanjut membaca". */
  const forHandle = useCallback(
    (handle: string | null | undefined) => latestForHandle(entriesRef.current, handle),
    [entriesRef],
  )

  return { positions: entries, save, clear, clearSeries, forChapter, forHandle }
}
