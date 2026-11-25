import { useCallback, useEffect, useRef } from 'react'
import { getUser } from '../account'
import { progressApi } from '../api'
import { toChapterId } from '../readerSource'
import { usePerAccountLocalStorage } from './usePerAccountLocalStorage'
import type { ReadingStatus } from '../readingStatus'

export interface ProgressEntry {
  seriesId: number | string
  seriesTitle: string | null
  /** Identitas chapter = string. "0" dan "00.1" adalah dua chapter berbeda. */
  chapterId: string
  chapterName: string
  /** Nomor halaman (0-based) — 0 kalau data lama tidak punya pageId. */
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
  /** Mode baca sesi terakhir. Entri lama tanpa mode dianggap 'normal'. */
  mode?: 'normal' | 'marathon'
  /** Status baca eksplisit. Entri lama tanpa status dianggap dibuka. */
  status?: ReadingStatus
  at: number
}

const KEY = 'komiku.web.progress.v1'
const MAX = 24
const PUSH_DEBOUNCE_MS = 2000
const PROGRESS_EVENT = 'komik-progress-change'

function emitProgressChange(): void {
  if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function') {
    window.dispatchEvent(new CustomEvent(PROGRESS_EVENT))
  }
}

export interface MarkFinishedMeta {
  seriesTitle?: string | null
  chapterId?: string
  chapterName?: string
  source?: string | null
}

function matchesProgressTarget(p: ProgressEntry, handleOrSeriesId: string): boolean {
  const needle = String(handleOrSeriesId ?? '').trim()
  if (!needle) return false
  const sid = String(p.seriesId)
  const h = String(p.handle ?? '')
  if (sid === needle || h === needle) return true
  if (h.startsWith(`${needle}:`) || String(p.chapterId).startsWith(`${needle}:`)) return true
  if (!needle.includes(':') && (h.endsWith(`:${needle}`) || sid.endsWith(`:${needle}`))) return true
  if (needle.includes(':') && !sid.includes(':') && !h.includes(':') && sid === needle.split(':').pop()) return true
  return false
}

function removeProgressEntry(list: ProgressEntry[], handleOrSeriesId: string): ProgressEntry[] {
  return list.filter((p) => !matchesProgressTarget(p, handleOrSeriesId))
}

function markProgressFinished(
  list: ProgressEntry[],
  handleOrSeriesId: string,
  meta?: MarkFinishedMeta,
  now = Date.now(),
): ProgressEntry[] {
  const existing = list.find((p) => matchesProgressTarget(p, handleOrSeriesId))
  const rest = removeProgressEntry(list, handleOrSeriesId)
  if (existing) {
    return [{ ...existing, status: 'Selesai' as const, progress: 1, at: now }, ...rest].slice(0, MAX)
  }
  const hasColon = handleOrSeriesId.includes(':')
  const created: ProgressEntry = {
    seriesId: handleOrSeriesId,
    seriesTitle: meta?.seriesTitle ?? null,
    chapterId: toChapterId(meta?.chapterId ?? ''),
    chapterName: meta?.chapterName ?? 'Selesai',
    page: 0,
    progress: 1,
    source: meta?.source ?? (hasColon ? handleOrSeriesId.split(':')[0] : null),
    handle: hasColon ? handleOrSeriesId : null,
    status: 'Selesai',
    at: now,
  }
  return [created, ...rest].slice(0, MAX)
}

/** Key localStorage per-akun: akun beda dapat riwayat baca terpisah. */
function progressKey(): string {
  const u = getUser()
  return u ? `${KEY}:${u}` : KEY
}

/** Parse blob localStorage menuju daftar entri (toleran terhadap rusak). */
function parse(raw: string | null): ProgressEntry[] {
  if (!raw) return []
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    // kompatibilitas: buang entri legacy berkunci judul ("t:<judul>") yang
    // bikin duplikat di riwayat — series sekarang selalu pakai id numerik.
    const list = (parsed as ProgressEntry[]).filter(
      (e) => e && !String(e.seriesId).startsWith('t:'),
    )
    // Spec §1: chapter identity SELALU string. Entri lama menyimpan angka;
    // toChapterId hanya String(trim()) — "0" tidak berubah jadi "00.1".
    return list.map((e) => ({ ...e, chapterId: toChapterId(e.chapterId) }))
  } catch {
    return []
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
  for (const entry of [...a, ...b]) {
    const e = { ...entry, chapterId: toChapterId(entry.chapterId) }
    const key = String(e.seriesId)
    const prev = byId.get(key)
    if (!prev || e.at > prev.at) byId.set(key, e)
  }
  return [...byId.values()].sort((x, y) => y.at - x.at).slice(0, MAX)
}

/** Server mengembalikan blob JSON opaque — bentuknya `ProgressEntry`. */
function asEntries(raw: unknown[]): ProgressEntry[] {
  return (raw as ProgressEntry[])
    .filter((e) => e && e.seriesId !== undefined && typeof e.at === 'number')
    .map((e) => ({ ...e, chapterId: toChapterId(e.chapterId) }))
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
  const { entries, apply, entriesRef } = usePerAccountLocalStorage<ProgressEntry[]>({
    readKey: progressKey,
    parse,
    serialize: (list) => JSON.stringify(list),
    onAccountChange: (e) => {
      // akun berganti → cache lokal akun lama tidak relevan; kosongkan dulu
      // supaya merge dengan server akun baru tidak mencampur.
      if (e.username === null) return
      apply([])
      if (e.created === true) {
        push([])
        return
      }
      void syncFromServer()
    },
  })

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
  }, [apply, push, entriesRef])

  // boot: akun yang sedang aktif → PULL.
  useEffect(() => {
    void syncFromServer()
    const onVisible = () => {
      if (document.visibilityState === 'visible') void syncFromServer()
    }
    document.addEventListener('visibilitychange', onVisible)
    return () => document.removeEventListener('visibilitychange', onVisible)
  }, [syncFromServer])

  useEffect(() => {
    const onProgress = () => {
      try {
        const raw = localStorage.getItem(progressKey())
        const next = parse(raw)
        if (JSON.stringify(entriesRef.current) !== JSON.stringify(next)) {
          apply(next)
        }
      } catch {
        /* ignore */
      }
    }
    window.addEventListener(PROGRESS_EVENT, onProgress)
    return () => {
      window.removeEventListener(PROGRESS_EVENT, onProgress)
      if (pushTimer.current) clearTimeout(pushTimer.current)
    }
  }, [apply, entriesRef])

  const pushNow = useCallback((list: ProgressEntry[]) => {
    if (getUser() === null) return
    if (pushTimer.current) {
      clearTimeout(pushTimer.current)
      pushTimer.current = null
    }
    void progressApi
      .put(list as unknown as Record<string, unknown>[])
      .catch((err) => console.warn('useProgress: gagal push progres', err))
  }, [])

  const save = useCallback(
    (entry: Omit<ProgressEntry, 'at'>) => {
      // Spec §5: penulis yang lebih lama (storage event / pull yang tertunda)
      // tidak boleh menimpa entri series yang lebih baru di `entriesRef`.
      const at = Date.now()
      const prev = entriesRef.current.find(
        (p: ProgressEntry) => String(p.seriesId) === String(entry.seriesId),
      )
      if (prev && prev.at > at) return
      const next = [
        { ...entry, chapterId: toChapterId(entry.chapterId), at },
        ...entriesRef.current.filter(
          (p: ProgressEntry) => String(p.seriesId) !== String(entry.seriesId),
        ),
      ].slice(0, MAX)
      apply(next)
      emitProgressChange()
      push(next)
    },
    [apply, push, entriesRef],
  )

  const clear = useCallback(() => {
    apply([])
    emitProgressChange()
    push([])
  }, [apply, push])

  const removeProgressFn = useCallback(
    (handleOrSeriesId: string) => {
      const next = removeProgressEntry(entriesRef.current, handleOrSeriesId)
      apply(next)
      emitProgressChange()
      pushNow(next)
    },
    [apply, entriesRef, pushNow],
  )

  const markSeriesFinishedFn = useCallback(
    (handleOrSeriesId: string, meta?: MarkFinishedMeta) => {
      const next = markProgressFinished(entriesRef.current, handleOrSeriesId, meta)
      apply(next)
      emitProgressChange()
      pushNow(next)
    },
    [apply, entriesRef, pushNow],
  )

  return {
    recent: entries,
    save,
    clear,
    removeProgress: removeProgressFn,
    markSeriesFinished: markSeriesFinishedFn,
  }
}

export function removeProgress(handleOrSeriesId: string): void {
  try {
    const next = removeProgressEntry(parse(localStorage.getItem(progressKey())), handleOrSeriesId)
    localStorage.setItem(progressKey(), JSON.stringify(next))
    emitProgressChange()
    if (getUser() !== null) {
      void progressApi
        .put(next as unknown as Record<string, unknown>[])
        .catch((err) => console.warn('useProgress: gagal push progres', err))
    }
  } catch {
    /* storage penuh / mode privat */
  }
}

export function markSeriesFinished(handleOrSeriesId: string, meta?: MarkFinishedMeta): void {
  try {
    const next = markProgressFinished(parse(localStorage.getItem(progressKey())), handleOrSeriesId, meta)
    localStorage.setItem(progressKey(), JSON.stringify(next))
    emitProgressChange()
    if (getUser() !== null) {
      void progressApi
        .put(next as unknown as Record<string, unknown>[])
        .catch((err) => console.warn('useProgress: gagal push progres', err))
    }
  } catch {
    /* storage penuh / mode privat */
  }
}

/** Entri untuk satu manga (dipakai tombol "Lanjut"). */
export function findProgress(
  entries: ProgressEntry[],
  seriesId: number | string | undefined,
): ProgressEntry | undefined {
  if (seriesId === undefined) return undefined
  return entries.find((e) => String(e.seriesId) === String(seriesId))
}
