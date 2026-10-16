/**
 * account.ts — identitas akun Komik Hub di sisi klien.
 *
 * Satu username = satu akun. Disimpan di localStorage; dipakai `api.ts` untuk
 * menyisipkan header `X-Komik-User` ke setiap request ber-scope akun.
 *
 * TIDAK ada password — masuk = ketik username. Aturan validasi di sini HARUS
 * sama dengan `komiku-server/src/user.rs::normalize_username` (alfabet
 * `[a-z0-9_-]`, 3-20 karakter). Server tetap memvalidasi ulang; ini hanya
 * supaya user dapat umpan balik instan tanpa round-trip.
 */

const KEY = 'komik-akun-v1'

/** Aturan sama dengan server (pesan dipakai di UI). */
export const USERNAME_RULE =
  "username harus 3-20 karakter: huruf kecil, angka, '-' atau '_' (diawali huruf/angka)"

/**
 * Event akun. `created` menentukan ARAH SINKRONISASI dan itu bagian dari
 * kontrak — jangan diisi asal:
 *
 *   created === true   → PUSH (akun baru: adopsi rak device ini ke server)
 *   created !== true   → PULL (akun lama, boot, ganti akun: server menang)
 *
 * `null` sengaja dipakai untuk boot dan ganti akun, dan keduanya memang harus
 * PULL: boot wajib hydrate sebelum boleh push, ganti akun tidak boleh
 * membocorkan rak akun sebelumnya.
 */
export interface AccountEvent {
  username: string | null
  created: boolean | null
}

type Listener = (e: AccountEvent) => void

const listeners = new Set<Listener>()

/** Trim + lowercase. Cerminan `normalize_username` di server. */
export function normalizeUsername(raw: string): string {
  return raw.trim().toLowerCase()
}

/** `true` kalau username lolos aturan server. */
export function isValidUsername(raw: string): boolean {
  const u = normalizeUsername(raw)
  if (u.length < 3 || u.length > 20) return false
  if (!/^[a-z0-9]/.test(u)) return false
  return /^[a-z0-9_-]+$/.test(u)
}

/** Username aktif, atau `null` kalau belum masuk. */
export function getUser(): string | null {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return null
    const u = normalizeUsername(raw)
    return isValidUsername(u) ? u : null
  } catch {
    return null
  }
}

/**
 * Simpan/ganti akun aktif. `created` menentukan arah sinkronisasi (lihat
 * `AccountEvent`). Memancarkan `account-change` supaya store lain (favorit,
 * progress, unduhan) bisa hydrate ulang.
 */
export function setUser(username: string | null, created: boolean | null = null): void {
  const u = username === null ? null : normalizeUsername(username)
  try {
    if (u === null) localStorage.removeItem(KEY)
    else localStorage.setItem(KEY, u)
  } catch {
    /* storage penuh / mode privat — sesi ini tetap jalan tanpa persist */
  }
  emit({ username: u, created })
}

function emit(e: AccountEvent): void {
  for (const cb of listeners) {
    try {
      cb(e)
    } catch (err) {
      console.warn('account: listener gagal', err)
    }
  }
}

/** Dengar perubahan akun; kembalikan fungsi lepas. */
export function onAccountChange(cb: Listener): () => void {
  listeners.add(cb)
  return () => listeners.delete(cb)
}

/**
 * Baca `?u=<username>` dari URL (link akun lintas device), simpan, lalu
 * BERSIHKAN query dari address bar supaya username tidak tertinggal di history
 * atau ikut ter-share. Kembalikan username kalau berhasil.
 */
export function captureFromUrl(): string | null {
  if (typeof window === 'undefined') return null
  try {
    const params = new URLSearchParams(window.location.search)
    const raw = params.get('u')
    if (!raw) return null
    const u = normalizeUsername(raw)
    if (!isValidUsername(u)) return null
    setUser(u, null) // dari link = akun lama → PULL
    params.delete('u')
    const qs = params.toString()
    const url = `${window.location.pathname}${qs ? `?${qs}` : ''}${window.location.hash}`
    window.history.replaceState({}, '', url)
    return u
  } catch {
    return null
  }
}

/** Link akun siap-bagikan untuk device lain. */
export function accountLink(username: string): string {
  if (typeof window === 'undefined') return `/?u=${username}`
  return `${window.location.origin}/?u=${encodeURIComponent(username)}`
}
