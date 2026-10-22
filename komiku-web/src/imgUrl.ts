/**
 * URL gambar komik (halaman manga & sampul).
 *
 * DUA jalur yang sengaja dipisah — jangan digabung:
 *
 * 1. `imgUrl(u)` = IDENTITAS halaman, yaitu URL CDN apa adanya. Dipakai
 *    `pageMemory` + anchor posisi baca (`imgUrl(s) === anchor.pageId`). Kalau
 *    bentuk nilainya berubah (mis. ikut jadi URL proxy), semua posisi baca
 *    yang tersimpan user lama tidak ketemu dan pembaca dilempar ke atas.
 *
 * 2. `imgSrc(u,w)` / `imgSrcSet(u)` = nilai untuk atribut `src`/`srcset`,
 *    yaitu lewat proxy `/img` server (same-origin, di-resize, WebP lossy).
 *    Byte gambar inilah bottleneck yang user rasakan di koneksi jelek: satu
 *    chapter 5,4 MB (180 KB/halaman, 900 px penuh) ≈ 108 detik di 400 kbps.
 *    Hasil ukur proxy: 480 px → −74%, 640 px → −59%, 900 px → −14%.
 *
 * Same-origin juga membuat service worker bisa men-cache hasilnya (baca ulang
 * dan baca offline jadi instan) — lihat `public/sw.js`.
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
  effectiveType?: string
}

/**
 * Host yang di-proxy. KONTRAK: daftar ini WAJIB identik dengan ALLOWED_HOSTS
 * di `komiku-server/src/hosts.rs` — host yang tak ada di sana dijawab 403
 * server, jadi host baru harus ditambahkan di DUA tempat.
 */
export const IMG_HOSTS = [
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
] as const

/** Lebar yang dilayani proxy `/img` (px). Harus di dalam rentang server 96..1400. */
export const READER_WIDTHS = [480, 640, 900] as const

/** `sizes` halaman reader: kontainer `max-w-3xl` (768 px) di layar lebar. */
export const READER_SIZES = '(min-width: 800px) 768px, 100vw'

/**
 * Jarak (kelipatan tinggi viewport) untuk MULAI memuat gambar di luar layar.
 * Ini pengungkit terbesar untuk koneksi jelek: dengan `loading="lazy"` bawaan
 * browser, Chrome memuat ~1250 px + margin adaptif ke bawah, sehingga satu
 * kunjungan reader langsung meminta 9 gambar / 1,7 MB — dan halaman yang
 * SEDANG DILIHAT ikut antre di belakangnya. Terukur di 400 kbps: halaman 1
 * baru tampil 53 detik; 12 detik kalau tidak ada yang berebut.
 */
const MOUNT_AHEAD = {
  hemat: 0.4,
  seimbang: 1.5,
  siapkan: 3,
} as const

/** URL halaman/sampul → URL CDN apa adanya (idempoten, IDENTITAS). */
export function imgUrl(u: string | null | undefined): string {
  return u ?? ''
}

/** Host gambar ini boleh lewat proxy `/img`? (allowlist klien ↔ server) */
export function isProxyable(raw: string | null | undefined): boolean {
  if (!raw || !raw.startsWith('https://')) return false
  const host = raw.slice('https://'.length).split(/[/?#]/)[0]
  if (!host) return false
  return (IMG_HOSTS as readonly string[]).some((h) => h.toLowerCase() === host.toLowerCase())
}

/**
 * URL untuk atribut `src`: lewat proxy `/img?u=…&w=…` bila host diizinkan,
 * selain itu URL asli (fail-open: host baru tetap tampil, hanya tanpa resize).
 */
export function imgSrc(
  raw: string | null | undefined,
  width: number = 640,
  buster?: number,
): string {
  if (!raw) return ''
  if (!isProxyable(raw)) {
    // Fail-open: URL asli. Cache-buster tetap dilekatkan supaya refresh
    // manual bisa memaksa re-fetch dari server (bukan cache rusak).
    if (!buster) return raw
    const sep = raw.includes('?') ? '&' : '?'
    return `${raw}${sep}t=${buster}`
  }
  const base = `/img?u=${encodeURIComponent(raw)}&w=${width}`
  return buster ? `${base}&t=${buster}` : base
}

/**
 * `srcset` untuk proxy. `undefined` kalau host tidak bisa di-proxy → pemanggil
 * memakai `src` biasa.
 */
export function imgSrcSet(
  raw: string | null | undefined,
  widths: readonly number[] = READER_WIDTHS,
  buster?: number,
): string | undefined {
  if (!raw || !isProxyable(raw)) return undefined
  return widths.map((w) => `${imgSrc(raw, w, buster)} ${w}w`).join(', ')
}

/**
 * Koneksi lambat terdeteksi? Save-Data menyala, atau effectiveType 2g/slow-2g.
 * `3g` sengaja TIDAK dihitung lambat: mayoritas pembaca di 3G wajar, dan kalau
 * semua dianggap lambat fitur prefetch tak pernah jalan.
 */
export function slowLink(): boolean {
  if (typeof navigator === 'undefined') return false
  const c = (navigator as Navigator & { connection?: NetworkInformationLike }).connection
  if (!c) return false
  if (c.saveData) return true
  return c.effectiveType === 'slow-2g' || c.effectiveType === '2g'
}

/** Mode pembaca tersimpan; `undefined` = belum pernah memilih (default). */
export function readerMode(): string | undefined {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY)
    return raw ? (JSON.parse(raw) as { prefetchMode?: string }).prefetchMode : undefined
  } catch {
    /* storage tertutup / JSON rusak: pakai default */
    return undefined
  }
}

/**
 * Seberapa jauh (px) di luar layar sebuah gambar boleh mulai dimuat.
 * `hemat` → 0,4 viewport (hampir hanya yang terlihat), `siapkan` → 3 viewport
 * (nyaris tanpa jeda saat scroll cepat), Save-Data/2G dipaksa hemat.
 */
export function mountAheadPx(viewportHeight: number): number {
  if (typeof window === 'undefined') return 1200
  const mode = slowLink() ? 'hemat' : readerMode()
  const factor = MOUNT_AHEAD[mode as keyof typeof MOUNT_AHEAD] ?? MOUNT_AHEAD.seimbang
  return Math.round(Math.max(200, viewportHeight * factor))
}

/**
 * Batas prefetch aktif: prefetchMode dari preferensi reader, dipaksa `hemat`
 * ketika pengguna menyala Save-Data (Network Information API). Nol/gagal parse
 * → `seimbang`.
 */
export function prefetchLimit(): number {
  if (slowLink()) return PREFETCH_LIMITS.hemat
  const mode = readerMode()
  return PREFETCH_LIMITS[mode as keyof typeof PREFETCH_LIMITS] ?? PREFETCH_LIMITS.seimbang
}

/**
 * Hangatkan cache gambar perangkat — NO-OP sejak proxy `/img` dipakai lagi.
 *
 * Dengan proxy, gambar same-origin dan service worker-lah yang menyimpannya;
 * menghangatkan manual di sini hanya menggandakan permintaan. Fungsi
 * dipertahankan (mengembalikan 0) supaya kontrak pemanggil (reader & maraton)
 * stabil tanpa import yang rusak. Untuk memanaskan halaman tertentu, pakai
 * `new Image().src = imgSrc(url, w)` — itu masuk ke cache SW yang sama.
 */
export function warmCache(_urls: (string | null | undefined)[]): number {
  return 0
}
