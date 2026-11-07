/**
 * Sumber kebenaran tunggal untuk preferensi reader yang tersimpan di
 * localStorage. Dulu parsing JSON di-ulang di 3 tempat (useReaderSettings,
 * imgUrl.readerMode, Reader.tsx guard prefetch) — sekarang semua memakai
 * fungsi di sini. Kontrak tersimpan: key `komiku.web.reader.settings.v1`,
 * bentuk JSON `{ prefetchMode?: string }`; `undefined`/kosong saat belum
 * di-set atau rusak.
 */

/** Key penyimpanan preferensi reader (kontrak, jangan diubah). */
export const READER_SETTINGS_KEY = 'komiku.web.reader.settings.v1'

/**
 * Parse string mentah dari localStorage jadi objek preferensi.
 * Mengembalikan `{}` kalau kosong/rusak — pemanggil yang memutuskan default.
 */
export function parseReaderSettings(raw: string | null): { prefetchMode?: string } {
  if (!raw) return {}
  try {
    return JSON.parse(raw) as { prefetchMode?: string }
  } catch {
    return {}
  }
}

/**
 * Baca preferensi tersimpan. `prefetchMode` undefined saat belum di-set,
 * rusak, atau storage tertutup (semua → default pemanggil).
 */
export function getReaderSettings(): { prefetchMode?: string } {
  try {
    return parseReaderSettings(localStorage.getItem(READER_SETTINGS_KEY))
  } catch {
    /* storage tertutup — pakai default */
    return {}
  }
}
