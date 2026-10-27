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

/**
 * Halaman yang diproses bersamaan. Tiap halaman = 3 permintaan `/img`
 * (480/640/900), jadi 6 halaman = 18 encode paralel di server. Terukur di
 * mesin 4 core: encode yang sendirian ~0,1 s jadi 3-20 s saat 18-nya rebutan,
 * dan `/img` mulai balas 504. 2 halaman = maks 6 permintaan, masih memakai
 * seluruh core tanpa membuat antrean server meledak.
 */
const CONCURRENCY = 2

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
        // SW menandai `X-Komiku-Cached: 0` kalau cache.put GAGAL (kuota penuh).
        // Respons jaringan tetap ok supaya gambar tampil, tapi byte-nya TIDAK
        // tersimpan — tanpa cek ini halaman dihitung sukses palsu.
        if (res.headers.get('x-komiku-cached') === '0') return false
        return res.ok
      } catch {
        return false
      }
    }),
  )

  // Satu lebar gagal = halaman gagal (offline di viewport lain akan 504).
  return results.length > 0 && results.every(Boolean)
}
