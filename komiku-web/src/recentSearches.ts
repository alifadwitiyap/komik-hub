/**
 * Riwayat kata kunci pencarian halaman Cari (localStorage, maksimal 5 entri).
 * Sengaja TIDAK bergantung pada React/DOM yang bisa mati supaya logikanya bisa
 * diuji langsung dengan node. Semua akses localStorage dibungkus try/catch:
 * storage bisa diblokir (mode privat, kuota penuh) — riwayat cuma kemewahan,
 * kegagalannya tidak boleh membuat pencarian gagal.
 */

const RECENT_KEY = 'komik-search-recent'
export const RECENT_MAX = 5

/** Entri terakhir (terbaru dulu). Data rusak/kosong → []. */
export function listRecent(): string[] {
  try {
    const raw = localStorage.getItem(RECENT_KEY)
    if (!raw) return []
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed
      .filter((s): s is string => typeof s === 'string' && s.length > 0)
      .slice(0, RECENT_MAX)
  } catch {
    return []
  }
}

/** Simpan satu kata kunci di depan; kembalikan daftar baru (maksimal 5). */
export function rememberSearch(q: string): string[] {
  const term = q.trim()
  if (!term) return listRecent()
  const next = [
    term,
    ...listRecent().filter((s) => s.toLowerCase() !== term.toLowerCase()),
  ].slice(0, RECENT_MAX)
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify(next))
  } catch {
    /* storage diblokir — riwayat tidak tersimpan, pencarian tetap jalan */
  }
  return next
}

/** Kosongkan riwayat; mengembalikan [] supaya pemanggil bisa langsung setState. */
export function clearRecent(): string[] {
  try {
    localStorage.removeItem(RECENT_KEY)
  } catch {
    /* storage diblokir */
  }
  return []
}
