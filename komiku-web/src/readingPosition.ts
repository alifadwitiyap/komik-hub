import { useCallback, useEffect, useRef } from 'react'
import { scrollYForAnchor, type ReadingAnchor } from './pageMemory.ts'

/**
 * readingPosition.ts — modul DALAM untuk pemulihan posisi baca (K1).
 *
 * Memusatkan logika yang sebelumnya diduplikasi di Reader.tsx dan
 * ReaderMarathon.tsx:
 *
 *   1. `measurePages` — membaca geometri halaman dari DOM secara murni
 *      (input: root + resolver pageId; output: array geometry). Murni
 *      supaya bisa diuji tanpa browser.
 *
 *   2. `setScrollToAnchor` — scroll ke posisi anchor pada satu elemen, dan
 *      lapor apakah posisi sudah final (gambar pemilik sudah decode).
 *
 *   3. `useReadingAnchor` — hook yang memiliki SATU implementasi restore-retry
 *      (rAF loop, batas ~3 detik) + gating chrome saat restore. Resolver
 *      pageId adalah SEAM: Reader memakai `src`, Marathon memakai indeks
 *      blok/halaman.
 */

export interface PageGeometry {
  /** identitas halaman (dari resolver) */
  pageId: string
  /** posisi absolut (px) tepi atas elemen */
  top: number
  /** tinggi elemen (px) */
  height: number
}

/**
 * Resolver halaman: beri `pageId` untuk satu elemen `<img>`/`<div>` halaman.
 * Berbeda per flow (Reader: atribut `src`; Marathon: indeks data blok).
 */
export type ResolvePageId = (el: HTMLElement) => string | null

function isImageStable(el: HTMLElement): boolean {
  const img = el instanceof HTMLImageElement ? el : el.querySelector('img')
  return !!img?.complete && img.naturalWidth > 0
}

/**
 * Baca geometri semua halaman di `root`.
 * Murni: tidak mengubah apa pun; mengembalikan daftar geometry.
 * `resolvePageId` menentukan identitas tiap halaman.
 */
export function measurePages(
  root: HTMLElement | null,
  resolvePageId: ResolvePageId,
  selector = 'img[data-page], img[data-b]',
): PageGeometry[] {
  if (!root) return []
  const out: PageGeometry[] = []
  for (const el of Array.from(root.querySelectorAll<HTMLElement>(selector))) {
    const pageId = resolvePageId(el)
    if (!pageId) continue
    if (el.offsetHeight === 0) continue // belum terukur → lewati
    out.push({
      pageId,
      top: el.getBoundingClientRect().top + window.scrollY,
      height: el.offsetHeight,
    })
  }
  return out
}

/**
 * Scroll ke `anchor`. Return true kalau posisi sudah FINAL (gambar pemilik
 * anchor sudah decode) — inilah sinyal untuk berhenti retry.
 */
export function setScrollToAnchor(
  el: HTMLElement,
  anchor: Pick<ReadingAnchor, 'offsetRatio'>,
): boolean {
  if (!el || el.offsetHeight === 0) return false
  const top = el.getBoundingClientRect().top + window.scrollY
  const target = scrollYForAnchor(anchor.offsetRatio, top, el.offsetHeight, window.innerHeight)
  if (Math.abs(window.scrollY - target) > 1) window.scrollTo({ top: target })
  return isImageStable(el)
}

export interface ReadingAnchorHook {
  /**
   * Minta pemulihan posisi. `anchor` adalah target; `findEl(pageId)` mencari
   * elemen DOM untuk pageId itu (seam — beda per flow).
   * Dipanggil saat data chapter tiba.
   */
  restore: (
    anchor: Pick<ReadingAnchor, 'pageId' | 'offsetRatio'>,
    findEl: (pageId: string) => HTMLElement | null,
  ) => void
  /**
   * true selagi restore berjalan — chrome (toolbar) tidak boleh bereaksi pada
   * scroll programatik. Lewatkan ke `useChromeOnScroll(restoring)`.
   */
  isRestoring: () => boolean
}

/**
 * Hook pemulihan posisi — satu implementasi restore-retry untuk Reader &
 * ReaderMarathon. `findEl` menentukan bagaimana menemukan elemen halaman
 * (Reader: `[data-page=idx]`; Marathon: `img[data-b][data-page]`).
 */
export function useReadingAnchor(): ReadingAnchorHook {
  const pending = useRef<{
    pageId: string
    offsetRatio: number
    findEl: (pageId: string) => HTMLElement | null
  } | null>(null)

  const isRestoring = useCallback(() => pending.current !== null, [])

  const restore = useCallback(
    (
      anchor: Pick<ReadingAnchor, 'pageId' | 'offsetRatio'>,
      findEl: (pageId: string) => HTMLElement | null,
    ) => {
      pending.current = { pageId: anchor.pageId, offsetRatio: anchor.offsetRatio, findEl }
    },
    [],
  )

  // retry loop: kejar sampai posisi final (layout stabil) atau ~3 detik
  useEffect(() => {
    let raf = 0
    let tries = 0
    const attempt = () => {
      raf = 0
      const p = pending.current
      if (!p) return
      const el = p.findEl(p.pageId)
      if (el && setScrollToAnchor(el, { offsetRatio: p.offsetRatio })) {
        pending.current = null
        return
      }
      if (++tries > 180) {
        // ~3 detik: berhenti memaksa, jangan rebut kendali scroll dari pembaca
        pending.current = null
        return
      }
      raf = requestAnimationFrame(attempt)
    }
    raf = requestAnimationFrame(attempt)
    return () => {
      if (raf) cancelAnimationFrame(raf)
    }
  }, [])

  return { restore, isRestoring }
}
