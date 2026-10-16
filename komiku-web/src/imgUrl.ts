/**
 * Semua URL gambar komik (halaman manga & sampul) dilewatkan melalui proxy
 * `/img` milik sendiri: respons same-origin penuh → bisa di-cache service
 * worker secara andal, plus retry/backoff sudah ditangani server.
 */
/**
 * Host gambar yang WAJIB lewat proxy `/img`.
 *
 * Daftar SAMA PERSIS dengan `ALLOWED_HOSTS` di komiku-server/src/img.rs —
 * host di luar daftar akan dijawab 403 oleh server, jadi proxy-nya sia-sia.
 * Matching memakai suffix host supaya subdomain yang serupa ikut ter-proxy;
 * kalau server menambah host, tambahkan juga di sini (dan di komiku-server).
 *
 * Komentar kontrak: komiku (img/thumbnail.komiku.org), komiku CDN baru
 * (image2..image11.komiku.to), shinigami (assets/storage.shngm.id), mangaku
 * (cdnkuma.my.id), kiryuu (cdn.jsdelivr.net, v2.yuucdn.net, v7.kiryuu.to).
 */
const IMG_HOSTS = [
  'img.komiku.org',
  'thumbnail.komiku.org',
  'image2.komiku.to',
  'image3.komiku.to',
  'image4.komiku.to',
  'image5.komiku.to',
  'image6.komiku.to',
  'image7.komiku.to',
  'image8.komiku.to',
  'image9.komiku.to',
  'image10.komiku.to',
  'image11.komiku.to',
  'assets.shngm.id',
  'storage.shngm.id',
  'cdnkuma.my.id',
  'cdn.jsdelivr.net',
  'v2.yuucdn.net',
  'v7.kiryuu.to',
]

/** Suffix match supaya subdomain host tersebut ikut ter-proxy (bukan wildcard liar). */
function isImgHost(u: string): boolean {
  try {
    const host = new URL(u, 'http://x.invalid').hostname.toLowerCase()
    return IMG_HOSTS.some((h) => host === h || host.endsWith(`.${h}`))
  } catch {
    return false
  }
}

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

/** URL halaman/sampul → URL proxy lokal (idempoten). */
export function imgUrl(u: string | null | undefined): string {
  if (!u) return ''
  if (u.startsWith('/img?u=')) return u
  // host sudah dikenal (komiku atau sumber unified baru) → proxy
  if (isImgHost(u)) return `/img?u=${encodeURIComponent(u)}`
  // sudah absolute ke host lain: biarkan (mis. placeholder data URI)
  if (/^(https?:)?\/\//.test(u)) return u
  return u
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
 * Hangatkan cache service worker untuk URL yang hampir dibutuhkan: halaman
 * berikutnya (reader biasa) atau awal chapter baru (maraton).
 * Array dipotong menurut batas prefetch aktif sebelum dikirim ke SW.
 * Fire-and-forget; mengembalikan jumlah URL yang benar-benar dihangatkan.
 */
export function warmCache(urls: (string | null | undefined)[]): number {
  if (typeof navigator === 'undefined' || !navigator.serviceWorker?.controller) return 0
  const abs = urls
    .filter((u): u is string => !!u)
    .map((u) => new URL(imgUrl(u), window.location.origin).toString())
    .slice(0, prefetchLimit())
  if (abs.length === 0) return 0
  navigator.serviceWorker.controller.postMessage({ urls: abs })
  return abs.length
}
