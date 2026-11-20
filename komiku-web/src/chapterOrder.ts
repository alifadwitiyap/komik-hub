// Satu aturan urutan chapter: nomor apa pun dibaca dari angka di depan,
// edisi revisi ("811 Fix") menempel pada induknya, kunci asli tidak diubah.
const CHAPTER_PREFIX = /^\s*(\d+(?:[.,]\d+)?)/

export function compareChapterNumber(a: string, b: string): number {
  const ma = CHAPTER_PREFIX.exec(a)
  const mb = CHAPTER_PREFIX.exec(b)
  if (ma && mb) {
    const na = Number(ma[1].replace(',', '.'))
    const nb = Number(mb[1].replace(',', '.'))
    if (na !== nb) return na - nb
    // Induk sebelum revisi: "811" < "811 Fix"; "1189" < "1189.2".
    // ponytail: suffix lain (e.g. "2") tidak diparse; tambah jika ada pola baru.
    const sa = a.trim().slice(ma[1].length).trim()
    const sb = b.trim().slice(mb[1].length).trim()
    if (!sa && sb) return -1
    if (sa && !sb) return 1
    return sa.localeCompare(sb, 'id', { numeric: true }) || a.localeCompare(b, 'id')
  }
  // Tanpa angka → terakhir saat "lama", terdepan saat "terbaru" (reverse).
  if (ma) return -1
  if (mb) return 1
  return a.localeCompare(b, 'id', { numeric: true }) || a.localeCompare(b, 'id')
}

export function sortByChapterNumber<T>(
  rows: readonly T[],
  getNumber: (row: T) => string,
  order: 'lama' | 'terbaru' = 'lama',
): T[] {
  const sorted = [...rows].sort((x, y) => compareChapterNumber(getNumber(x), getNumber(y)))
  if (order !== 'terbaru') return sorted
  // Nomor tanpa angka tetap di belakang (bukan ikut terbalik ke depan).
  const bernomor = sorted.filter((row) => CHAPTER_PREFIX.test(getNumber(row)))
  const tanpaNomor = sorted.filter((row) => !CHAPTER_PREFIX.test(getNumber(row)))
  return [...bernomor.reverse(), ...tanpaNomor]
}

/**
 * Edisi chapter untuk picker: nomor + sumber, dengan fallback pada suffix
 * nomor asli ("1189.2", "811 Fix") bila sumber tidak tersedia. Kunci/link
 * TIDAK diubah — helper ini hanya menghasilkan string tampilan.
 */
export function chapterEditionLabel(
  chapter: { number?: string | null; key?: string | null; source?: string | null; title?: string | null },
): string {
  const number = (chapter.number || chapter.title || '').trim() || '—'
  const source = chapter.source?.trim() || chapter.key?.split(':')[0]?.trim() || ''
  // Judul sudah membawa edisi ("Chapter 811 Fix", "Chapter 1189.2 · Mangaku")
  // → jangan dilabeli dua kali.
  if (source && !/·\s*\S+\s*$/.test(number)) return `${number} · ${source}`
  return number
}
