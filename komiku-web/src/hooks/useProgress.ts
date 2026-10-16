import { useCallback, useEffect, useRef, useState } from 'react'
import { getUser, onAccountChange, type AccountEvent } from '../account'
import { progressApi } from '../api'

export interface ProgressEntry {
  seriesId: number | string
  seriesTitle: string | null
  chapterId: number | string
  chapterName: string
  page: number
  /** 0..1 — posiasi halaman terakhir yang terbaca */
  progress: number
  /**
   * Lane A — posisi baca presisi: id halaman (URL gambar dari API) yang
   * sedang ditatap pembaca. Opsional; entri lama hanya punya `page`.
   */
  pageId?: string
  /**
   * Lane B — unified: sumber yang melayani chapter ini + handle sumbernya.
   * Dipakai series page mengirim `last_source` supaya server coba sumber
   * yang sama dulu, dan dipakai reader untuk RESET posisi pindah sumber.
   */
  source?: string | null
  handle?: string | null
  /**
   * Lane A — 0..1: seberapa jauh "posisi mata" (tengah viewport) menembus
   * halaman `pageId`. Digunakan memulihkan posisi baca ke piksel, bukan
   * cuma ke atas halaman.
   */
  offsetRatio?: number
  at: number
}

const KEY = 'komiku.web.progress.v1'
const MAX = 24
const PUSH_DEBOUNCE_MS = 2000

function read(): ProgressEntry[] {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return []
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    // kompatibilitas: buang entri legacy berkunci judul ("t:<judul>") yang
    // bikin duplikat di riwayat — series sekarang selalu pakai id numerik.
    return (parsed as ProgressEntry[]).filter((e) => !String(e.seriesId).startsWith('t:'))
  } catch {
    return []
  }
}

function write(entries: ProgressEntry[]) {
  try {
    localStorage.setItem(KEY, JSON.stringify(entries))
  } catch {
    /* storage penuh / mode privat — progres tidak ganggu membaca */
  }
}

/**
 * Merge dua daftar per `seriesId`: entri dengan `at` terbesar menang, lalu
 * diurutkan terbaru-dulu dan dipotong `MAX`. Dipakai untuk menggabungkan
 * progres lokal dengan progres server tanpa kehilangan posisi yang lebih baru
 * dari sisi mana pun (spec §5: pull → merge → push).
 */
export function mergeProgress(a: ProgressEntry[], b: ProgressEntry[]): ProgressEntry[] {
  const byId = new Map<string, ProgressEntry>()
  for (const e of [...a, ...b]) {
    const key = String(e.seriesId)
    const prev = byId.get(key)
    if (!prev || e.at > prev.at) byId.set(key, e)
  }
  return [...byId.values()].sort((x, y) => y.at - x.at).slice(0, MAX)
}

/** Server mengembalikan blob JSON opaque — bentuknya `ProgressEntry`. */
function asEntries(raw: unknown[]): ProgressEntry[] {
  return (raw as ProgressEntry[]).filter(
    (e) => e && e.seriesId !== undefined && typeof e.at === 'number',
  )
}

/**
 * Riwayat "lanjut baca" per manga. Satu entri per manga (yang terbaru menang),
 * supaya daftar tidak banjir chapter dari serial yang sama.
 *
 * Sinkron per-akun (spec §5): kalau `getUser()` tidak null, saat boot dan saat
 * ganti akun kita pull progres server, merge dengan lokal (max `at` menang),
 * lalu push hasilnya (debounce, non-blocking). Kalau belum masuk, perilaku
 * lama (murni localStorage) tidak berubah.
 */
export function useProgress() {
  const [entries, setEntries] = useState<ProgressEntry[]>(read)
  // Cermin sinkron dari `entries` untuk dipakai di jalur async (syncFromServer)
  // tanpa membaca state basi. Diperbarui HANYA lewat apply()/save() — bukan saat
  // render — supaya tidak melanggar aturan React soal akses ref di render.
  const entriesRef = useRef<ProgressEntry[]>(entries)
  const pushTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const push = useCallback((list: ProgressEntry[]) => {
    if (getUser() === null) return
    if (pushTimer.current) clearTimeout(pushTimer.current)
    pushTimer.current = setTimeout(() => {
      pushTimer.current = null
      void progressApi
        .put(list as unknown as Record<string, unknown>[])
        .catch((err) => console.warn('useProgress: gagal push progres', err))
    }, PUSH_DEBOUNCE_MS)
  }, [])

  const apply = useCallback((next: ProgressEntry[]) => {
    entriesRef.current = next
    setEntries(next)
    write(next)
  }, [])

  // pull → merge → push. Dipakai saat boot dan saat PULL (akun lama/ganti akun).
  const syncFromServer = useCallback(async () => {
    if (getUser() === null) return
    try {
      const { entries: remote } = await progressApi.get()
      const merged = mergeProgress(entriesRef.current, asEntries(remote))
      apply(merged)
      // push hasil merge supaya server punya posisi terbaru dari device ini
      push(merged)
    } catch (err) {
      // endpoint belum ada / jaringan mati: pertahankan progres lokal apa adanya.
      console.warn('useProgress: gagal pull progres', err)
    }
  }, [apply, push])

  // Arah sinkronisasi mengikuti aturan yang sama dengan favorit (spec §5):
  //   created === true → PUSH (akun baru: server kosong, adopsi progres device)
  //   selain itu       → PULL + merge + push (akun lama / boot / ganti akun)
  const onAccount = useCallback(
    (e: AccountEvent) => {
      if (e.username === null) return
      if (e.created === true) {
        push(entriesRef.current)
        return
      }
      void syncFromServer()
    },
    [push, syncFromServer],
  )

  useEffect(() => {
    const onStorage = (e: StorageEvent) => e.key === KEY && apply(read())
    window.addEventListener('storage', onStorage)
    // boot: akun yang sedang aktif → PULL.
    void syncFromServer()
    const off = onAccountChange(onAccount)
    return () => {
      window.removeEventListener('storage', onStorage)
      off()
      if (pushTimer.current) clearTimeout(pushTimer.current)
    }
  }, [apply, onAccount, syncFromServer])

  const save = useCallback(
    (entry: Omit<ProgressEntry, 'at'>) => {
      setEntries((prev) => {
        const next = [
          { ...entry, at: Date.now() },
          ...prev.filter((p) => String(p.seriesId) !== String(entry.seriesId)),
        ].slice(0, MAX)
        write(next)
        entriesRef.current = next
        push(next)
        return next
      })
    },
    [push],
  )

  const clear = useCallback(() => {
    apply([])
    push([])
  }, [apply, push])

  return { recent: entries, save, clear }
}

/** Entri untuk satu manga (dipakai tombol "Lanjut"). */
export function findProgress(
  entries: ProgressEntry[],
  seriesId: number | string | undefined,
): ProgressEntry | undefined {
  if (seriesId === undefined) return undefined
  return entries.find((e) => String(e.seriesId) === String(seriesId))
}
