/**
 * URL gambar komik (halaman manga & sampul) dipakai APA ADANYA dari CDN.
 *
 * Keputusan Q21 (plan komiku-ringan-homeserver): hotlink CDN aman (diuji live,
 * tanpa cek Referer), jadi byte gambar TIDAK lagi dilewatkan proxy `/img`
 * server. Beban bandwidth gambar keluar dari CDN, bukan dari PC user.
 *
 * Konsekuensi jujur: respons gambar kini lintas-origin (opaque), jadi service
 * worker TIDAK bisa men-cache-nya untuk offline. Karena itu cache offline
 * in-app dibuang (Q11) — lihat `public/sw.js`.
 */

/** Berapa banyak gambar dihangatkan lebih awal per mode preferensi. */
const PREFETCH_LIMITS = {
  hemat: 1,
  seimbang: 3,
  siapkan: 8,
} as const

const SETTINGS_KEY = 'komiku.web.reader.settings.v1'

interface NetworkInformationLike {
  saveData?: boolean
}

/** URL halaman/sampul → URL CDN apa adanya (idempoten). */
export function imgUrl(u: string | null | undefined): string {
  return u ?? ''
}

/**
 * Batas prefetch aktif: prefetchMode dari preferensi reader, dipaksa `hemat`
 * ketika pengguna menyala Save-Data (Network Information API). Nol/gagal parse
 * → `seimbang`.
 */
export function prefetchLimit(): number {
  let mode: string | undefined
  try {
    const raw = localStorage.getItem(SETTINGS_KEY)
    mode = raw ? (JSON.parse(raw) as { prefetchMode?: string }).prefetchMode : undefined
  } catch {
    /* storage tertutup / JSON rusak: pakai default */
  }
  if (
    typeof navigator !== 'undefined' &&
    (navigator as Navigator & { connection?: NetworkInformationLike }).connection?.saveData
  ) {
    return PREFETCH_LIMITS.hemat
  }
  return PREFETCH_LIMITS[mode as keyof typeof PREFETCH_LIMITS] ?? PREFETCH_LIMITS.seimbang
}

/**
 * Hangatkan cache gambar — sekarang NO-OP.
 *
 * Setelah proxy `/img` dihapus (Q21) gambar datang dari CDN lintas-origin dan
 * service worker tidak lagi punya cache `komiku-img-v2`, jadi tidak ada cache
 * perangkat yang bisa diisi. Fungsi dipertahankan (mengembalikan 0) supaya
 * kontrak pemanggil (reader & maraton) tetap stabil tanpa import yang rusak.
 */
export function warmCache(_urls: (string | null | undefined)[]): number {
  return 0
}
