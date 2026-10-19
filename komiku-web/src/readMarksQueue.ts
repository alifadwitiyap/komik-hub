/**
 * readMarksQueue.ts — logika antrean mark "sudah dibaca" (murni, tanpa DOM).
 *
 * Dipisah dari `readMarks.ts` supaya bisa diuji tanpa browser: perlombaan
 * "mark baru masuk saat request lama masih jalan" mustahil direproduksi
 * deterministik lewat Playwright (route handler di mode sync memblokir loop
 * event), tapi DI SINI bisa — cukup pegang promise.
 *
 * Aturan yang dijaga:
 *  - `snapshot()` membekukan DAFTAR key yang benar-benar terkirim. Key yang
 *    masuk SESUDAH snapshot itu tidak boleh ikut terhapus.
 *  - `commit()` menghapus HANYA key yang terkirim. Kalau seluruh antrean
 *    dihapus, mark yang baru saja masuk ikut hilang: hilang dari antrean
 *    memory DAN dari storage → mark itu tak pernah sampai ke server.
 */

export type MarkBag = Record<string, number>
export type MarkPayload = Record<string, Record<string, number>>

/** Bentuk payload server + daftar key yang dikirim. */
export interface MarkSnapshot {
  sent: string[]
  payload: MarkPayload
}

/**
 * Bekukan antrean menjadi payload yang akan dikirim.
 * Key = `title_key:chapter`; `title_key` tidak mengandung `:`.
 */
export function snapshot(bag: MarkBag): MarkSnapshot {
  const sent: string[] = []
  const payload: MarkPayload = {}
  for (const [key, at] of Object.entries(bag)) {
    const idx = key.lastIndexOf(':')
    if (idx <= 0) continue
    const titleKey = key.slice(0, idx)
    const chapter = key.slice(idx + 1)
    const series = (payload[titleKey] ??= {})
    series[chapter] = at
    sent.push(key)
  }
  return { sent, payload }
}

/**
 * Hapus HANYA key yang terkirim dari antrean.
 * Mark yang masuk saat request berjalan tetap tertinggal → flush berikutnya
 * membawanya.
 */
export function commit(bag: MarkBag, sent: string[]): void {
  for (const key of sent) delete bag[key]
}
