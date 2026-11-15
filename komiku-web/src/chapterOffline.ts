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
 * Gambar minimal: tubuh respons < 12 byte atau tanpa magic bytes yang dikenal
 * = 0-byte/truncated/HTML-error-page-di-balik-status-200/Bukan gambar.
 * Tanpa pemeriksaan ini, byte kosong dianggap sukses dan halaman "tersimpan"
 * di cache padahal tidak bisa dibaca saat offline.
 */
export function isImageBytes(buf: ArrayBuffer): boolean {
  if (buf.byteLength < 12) return false
  const b = new Uint8Array(buf, 0, 12)
  const eq = (a: number[], offset = 0) => a.every((v, i) => b[offset + i] === v)
  if (eq([0xff, 0xd8, 0xff])) return true                      // JPEG
  if (eq([0x89, 0x50, 0x4e, 0x47])) return true                // PNG
  if (eq([0x47, 0x49, 0x46, 0x38])) return true                // GIF8
  if (eq([0x52, 0x49, 0x46, 0x46]) && eq([0x57, 0x45, 0x42, 0x50], 8)) return true // WebP (RIFF....WEBP)
  if (eq([0x66, 0x74, 0x79, 0x70], 4)) return true             // AVIF/HEIC/MP4 ftyp
  return false
}

/**
 * Gabungkan signal pemanggil dengan timeout 15s per fetch. Tanpa
 * AbortSignal.any/timeout (engine lama) fallback: signal pemanggil atau
 * timeout polos.
 */
function composeSignal(signal?: AbortSignal): AbortSignal {
  const canAny = typeof AbortSignal.any === 'function' && typeof AbortSignal.timeout === 'function'
  if (canAny) {
    return AbortSignal.any(signal ? [signal, AbortSignal.timeout(15_000)] : [AbortSignal.timeout(15_000)])
  }
  // ponytail: fallback tanpa AbortSignal.any — signal pemanggil menang, atau timeout polos
  return signal ?? AbortSignal.timeout(15_000)
}

/**
 * `onProgress(done, total)` dipanggil setelah tiap halaman selesai diproses.
 * `signal` opsional: diteruskan ke fetch tiap lebar proxy (dikomposisi dengan
 * timeout 15s); batch berikutnya tidak dimulai setelah abort.
 */
export async function downloadChapterImages(
  images: string[],
  onProgress?: (done: number, total: number) => void,
  signal?: AbortSignal,
): Promise<OfflineDownloadResult> {
  let ok = 0
  let fail = 0
  const total = images.length
  let cursor = 0

  // proses dalam batch paralel (concurrency terbatas)
  while (cursor < total) {
    if (signal?.aborted) break
    const batch = images.slice(cursor, cursor + CONCURRENCY)
    const results = await Promise.all(batch.map((raw) => cachePage(raw, signal)))
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
async function cachePage(raw: string, signal?: AbortSignal): Promise<boolean> {
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
        const res = await fetch(url, { cache: 'no-cache', signal: composeSignal(signal) })
        // SW menandai `X-Komiku-Cached: 0` kalau cache.put GAGAL (kuota penuh).
        // Respons jaringan tetap ok supaya gambar tampil, tapi byte-nya TIDAK
        // tersimpan — tanpa cek ini halaman dihitung sukses palsu.
        if (res.headers.get('x-komiku-cached') === '0') return false
        if (!res.ok) return false
        // Verifikasi BYTE, bukan status: SW bisa melayani 200 dengan tubuh
        // kosong/terpotong/HTML error page → hitung sebagai gagal.
        const buf = await res.arrayBuffer()
        return isImageBytes(buf)
      } catch {
        return false
      }
    }),
  )

  // Satu lebar gagal = halaman gagal (offline di viewport lain akan 504).
  return results.length > 0 && results.every(Boolean)
}
