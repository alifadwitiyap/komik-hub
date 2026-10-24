/**
 * chapterOffline — "Unduh offline" di reader: simpan byte chapter ke Cache
 * Storage via service worker.
 *
 * Service worker (`sw.js`) sudah cache-first untuk `/img?u=…&w=…` (same-origin,
 * proxy server). Jadi cukup me-request tiap URL proxy gambar chapter itu, dan
 * SW otomatis menyimpannya. Baca ulang saat internet/server mati tinggal
 * dilayani dari cache tanpa menyentuh jaringan.
 *
 * Untuk tiap halaman kita fetch SEMUA lebar proxy (480/640/900) supaya offline
 * kebaca di layar mana pun — browser memilih lebar dari `sizes`, dan kalau
 * hanya satu lebar yang di-cache, viewport lain akan request lebar lain yang
 * belum ada → kena 504 saat offline.
 */

import { imgSrc, imgSrcSet, READER_WIDTHS } from './imgUrl'

export interface OfflineDownloadResult {
  /** jumlah halaman yang berhasil di-cache penuh (semua lebar). */
  ok: number
  /** jumlah halaman yang gagal total (>=1 lebar gagal). */
  fail: number
}

const CONCURRENCY = 6

/**
 * `onProgress(done, total)` dipanggil setelah tiap halaman selesai diproses.
 */
export async function downloadChapterImages(
  images: string[],
  onProgress?: (done: number, total: number) => void,
): Promise<OfflineDownloadResult> {
  let ok = 0
  let fail = 0
  const total = images.length
  let cursor = 0

  // proses dalam batch paralel (concurrency terbatas)
  while (cursor < total) {
    const batch = images.slice(cursor, cursor + CONCURRENCY)
    const results = await Promise.all(batch.map((raw) => cachePage(raw)))
    for (const success of results) {
      if (success) ok++
      else fail++
    }
    cursor += batch.length
    onProgress?.(cursor, total)
  }

  return { ok, fail }
}

/** Fetch semua lebar proxy satu halaman; benar kalau SEMUA berhasil. */
async function cachePage(raw: string): Promise<boolean> {
  const srcSet = imgSrcSet(raw, READER_WIDTHS)
  // srcset undefined = host tak diizinkan proxy → pakai URL asli (fail-open).
  const targets: string[] = srcSet
    ? READER_WIDTHS.map((w) => imgSrc(raw, w))
    : raw
      ? [raw]
      : []

  const results = await Promise.all(
    targets.map(async (url) => {
      try {
        const res = await fetch(url, { cache: 'no-cache' })
        return res.ok
      } catch {
        return false
      }
    }),
  )

  return results.length > 0 && results.every(Boolean)
}
