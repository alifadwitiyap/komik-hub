/**
 * Guard untuk auto-reload sekali saat chunk lazy gagal diambil.
 *
 * Dipisah ke modul sendiri supaya `main.tsx` tidak perlu tahu detailnya.
 *
 * ## Kenapa guard ini TIDAK dibersihkan otomatis
 *
 * Percobaan pertama membersihkan guard dari `useEffect` di `App` dengan asumsi
 * "App mount = app sehat". Itu SALAH dan menghasilkan loop reload tak berujung
 * (terukur: 265 reload dalam ~20 detik). Sebabnya: `ErrorBoundary` per-route
 * menangkap error chunk DI DALAM `App`, sehingga `App` sendiri tetap render
 * sukses dan `useEffect`-nya tetap jalan — guard terhapus, lalu `preloadError`
 * berikutnya memicu reload lagi, berulang.
 *
 * Karena tidak ada titik di React yang bisa membedakan "route sukses" dari
 * "route gagal tapi ditangkap boundary" tanpa menambah plumbing, guard dibiarkan
 * hidup selama tab ini. Konsekuensinya: setelah satu kegagalan, auto-reload tidak
 * tersedia lagi sampai tab ditutup — tapi tombol "Muat ulang" di fallback selalu
 * ada. Kehilangan satu auto-reload jauh lebih baik daripada loop reload.
 */
const KEY = 'komik.preload-reload.v1'

/** Apakah reload otomatis sudah pernah dicoba untuk sesi tab ini. */
export function preloadReloadSudahDicoba(): boolean {
  try {
    return sessionStorage.getItem(KEY) !== null
  } catch {
    // sessionStorage bisa diblokir (mode privat ketat) — anggap sudah dicoba
    // supaya tidak berisiko loop.
    return true
  }
}

/** Tandai bahwa reload otomatis sudah dicoba sekali. */
export function tandaiPreloadReload(): void {
  try {
    sessionStorage.setItem(KEY, '1')
  } catch {
    /* tidak bisa menyimpan: risiko loop diterima, lebih baik daripada blank */
  }
}
