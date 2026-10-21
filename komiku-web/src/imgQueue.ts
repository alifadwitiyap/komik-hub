/**
 * Antrean muat gambar HALAMAN (khusus reader; cover di halaman lain tidak
 * lewat sini).
 *
 * Kenapa modul ini ada — terukur di 400 kbps, bukan dugaan: saat reader
 * dibuka, IntersectionObserver melepas halaman 1 DAN 3 halaman berikutnya
 * hampir bersamaan (detik 5,58 vs 5,61). Keempatnya berbagi bandwidth yang
 * sama, jadi 538 KB tetangga ikut berebut dengan 71,8 KB halaman yang SEDANG
 * DILIHAT — halaman 1 baru selesai di detik 11,6 padahal sendirian butuh
 * ~1,4 detik. Inilah "lemot"-nya yang user rasakan.
 *
 * Aturan yang dipaksakan di sini:
 * 1. Halaman EAGER (halaman pertama chapter) tidak pernah antre.
 * 2. Selama halaman eager masih memuat, halaman lain MENUNGGU. Byte yang
 *    datang harus byte yang berguna sekarang.
 * 3. Sesudah itu paling banyak 2 permintaan bersamaan — atau 1 kalau koneksi
 *    terbukti lambat (Save-Data/2G, atau gambar yang baru selesai butuh
 *    >2,5 detik). Adaptif, bukan menebak dari tipe koneksi saja.
 *
 * Konsekuensi yang disengaja: scroll sangat cepat bisa membuat halaman yang
 * belum termuat menunggu lebih lama daripada browser biasa. Itu pilihan sadar
 * — halaman yang sedang dibaca tidak boleh kalah rebutan.
 */

import { slowLink } from './imgUrl'

/** Dianggap "lambat" kalau satu gambar butuh lebih dari ini. */
const SLOW_SETTLE_MS = 2500
/** Permintaan bersamaan pada koneksi normal. */
const CAP_NORMAL = 2
/** Permintaan bersamaan pada koneksi lambat. */
const CAP_SLOW = 1

interface Waiter {
  seq: number
  onReady: () => void
  /** false = masih di antrean, true = slot sudah diberikan. */
  granted: boolean
}

let eagerActive = 0
let otherActive = 0
let seq = 0
let lastSettleMs: number | null = null
const waiters: Waiter[] = []

function cap(): number {
  if (slowLink()) return CAP_SLOW
  if (lastSettleMs !== null && lastSettleMs > SLOW_SETTLE_MS) return CAP_SLOW
  return CAP_NORMAL
}

/** Beri slot ke sebanyak mungkin penunggu yang boleh jalan sekarang. */
function pump(): void {
  // Halaman eager masih memuat → jangan kirim byte lain ke jalur yang sama.
  if (eagerActive > 0) return
  while (waiters.length > 0 && otherActive < cap()) {
    const w = waiters.shift()!
    w.granted = true
    otherActive += 1
    w.onReady()
  }
}

/**
 * Minta izin mulai memuat satu gambar.
 *
 * @param eager halaman pertama chapter — selalu langsung, tidak antre
 * @param onReady dipanggil saat boleh memasang `src` (langsung, atau nanti)
 * @returns fungsi pembatalan/pelepasan yang IDEMPOTEN: aman dipanggil dari
 *          pembersihan efek React maupun dari handler `onLoad`/`onError`.
 */
export function acquireImageSlot(priority: 0 | 1, onReady: () => void): () => void {
  if (priority === 0) {
    eagerActive += 1
    onReady()
    let done = false
    return () => {
      if (done) return
      done = true
      eagerActive = Math.max(0, eagerActive - 1)
      pump()
    }
  }

  const w: Waiter = { seq: seq++, onReady, granted: false }
  waiters.push(w)
  pump()

  let done = false
  return () => {
    if (done) return
    done = true
    if (w.granted) {
      otherActive = Math.max(0, otherActive - 1)
      pump()
      return
    }
    const i = waiters.indexOf(w)
    if (i >= 0) waiters.splice(i, 1)
  }
}

/**
 * Catat berapa lama satu gambar selesai (dipanggil ComicImage saat
 * load/error). Dipakai membuat antrean menyempit sendiri di koneksi lambat.
 */
export function recordImageSettle(ms: number): void {
  lastSettleMs = ms
  pump()
}

/** Reset state antrean — untuk unit test / pindah halaman penuh. */
export function resetImageQueue(): void {
  waiters.length = 0
  eagerActive = 0
  otherActive = 0
  lastSettleMs = null
}
