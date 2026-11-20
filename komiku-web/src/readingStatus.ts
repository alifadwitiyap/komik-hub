// Progres baca = halaman yang sedang terlihat, BUKAN banyak gambar termuat.
// Status disimpan eksplisit: chapter dibuka = "Sedang dibaca", dan hanya
// "Selesai" kalau halaman terakhir benar-benar habis digulir.
export type ReadingStatus = 'Sedang dibaca' | 'Selesai'

export function visiblePageProgress(visiblePage: number, pageCount: number): number {
  if (pageCount <= 0) return 0
  return Math.min(1, Math.max(0, visiblePage / pageCount))
}

export function readingStatusForPage(
  visiblePage: number,
  pageCount: number,
  atEnd: boolean,
): ReadingStatus {
  return pageCount > 0 && visiblePage >= pageCount && atEnd ? 'Selesai' : 'Sedang dibaca'
}
