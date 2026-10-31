import { useCallback, useEffect, useRef, useState } from 'react'
import { getUser, onAccountChange } from '../account'
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
function read(): MarathonPosition[] {
  try {
    return parsePositions(localStorage.getItem(marathonStoreKey(getUser())))
  } catch {
    return []
  }
}

function write(entries: MarathonPosition[]) {
  try {
    localStorage.setItem(marathonStoreKey(getUser()), serializePositions(entries))
  } catch {
    /* storage penuh / mode privat — posisi tidak ganggu membaca */
  }
}

export function useMarathonMemory() {
  const [entries, setEntries] = useState<MarathonPosition[]>(read)
  // cermin sinkron untuk jalur async (tanpa membaca state basi)
  const entriesRef = useRef<MarathonPosition[]>(entries)

  const apply = useCallback((next: MarathonPosition[]) => {
    entriesRef.current = next
    setEntries(next)
    write(next)
  }, [])

  /** Simpan/perbarui posisi satu sesi maraton. */
  const save = useCallback(
    (pos: Omit<MarathonPosition, 'at'>) => {
      const next = upsertPosition(entriesRef.current, { ...pos, at: Date.now() })
      apply(next)
    },
    [apply],
  )

  /** Hapus posisi sesi (dipakai "Mulai dari awal"). */
  const clear = useCallback(
    (chapterKey: string) => {
      apply(removePosition(entriesRef.current, chapterKey))
    },
    [apply],
  )

  /** Hapus semua sesi satu series (dipakai "Mulai dari awal"). */
  const clearSeries = useCallback(
    (handle: string | null | undefined) => {
      apply(removeHandle(entriesRef.current, handle))
    },
    [apply],
  )

  /** Posisi satu sesi (blok pertama = `chapterKey`). */
  const forChapter = useCallback(
    (chapterKey: string) => findPosition(entriesRef.current, chapterKey),
    [],
  )

  /** Sesi terbaru milik sebuah series — dipakai "Lanjut membaca". */
  const forHandle = useCallback(
    (handle: string | null | undefined) => latestForHandle(entriesRef.current, handle),
    [],
  )

  // akun berganti → posisi akun lain tidak boleh terbawa
  useEffect(() => {
    const off = onAccountChange(() => apply(read()))
    const onStorage = (e: StorageEvent) => {
      if (e.key === marathonStoreKey(getUser())) apply(read())
    }
    window.addEventListener('storage', onStorage)
    return () => {
      window.removeEventListener('storage', onStorage)
      off()
    }
  }, [apply])

  return { positions: entries, save, clear, clearSeries, forChapter, forHandle }
}
