/**
 * Ingatan pergi-pulang halaman Cari → detail.
 *
 * Kontrak:
 * - Search menulis `writeSearchReturn()` saat user mengklik kartu (via
 *   event delegation di `[data-search-results]`).
 * - Detail membaca `readSearchReturn(location.state)`, lalu `navigate(-1)`
 *   atau `navigate('/cari' + qs, { replace: true, state: payload })`.
 * - Setelah dipakai, detail memanggil `clearSearchReturn()` supaya state
 *   kedua tidak dipakai ulang.
 *
 * STATE disimpan di `history.state.usr` (bukan sessionStorage mentah) supaya
 * tombol Kembali browser native ikut membawa payload. sessionStorage dipakai
 * sebagai cadangan kalau state hilang (mis. reload di detail dengan replace).
 * Akses localStorage/sessionStorage dibungkus try/catch (mode private).
 */

const KEY = 'komik-cari-return'

export type SearchReturnFilter = {
  source: string
  sort: string
  tipe: string
  status: string
  genre: string
}

export interface SearchReturnState {
  query: string
  filter: SearchReturnFilter
  /** Posisi scroll halaman Cari saat kartu diklik. */
  scrollY: number
  /** URL detail yang dituju — dipakai detail untuk cek cocok tidak. */
  href: string
}

function storage(): Storage | null {
  try {
    return window.sessionStorage
  } catch {
    return null
  }
}

/** Tulis state ke sessionStorage + history.state.usr (best effort). */
export function writeSearchReturn(payload: SearchReturnState): void {
  const s = storage()
  try {
    s?.setItem(KEY, JSON.stringify(payload))
  } catch {
    /* storage penuh / private mode — history.state masih dipakai */
  }
  try {
    const historyState = window.history.state
    const usr = historyState && typeof historyState === 'object' ? historyState.usr : undefined
    window.history.replaceState(
      { ...(historyState ?? {}), usr: { ...(usr ?? {}), cariReturn: payload } },
      '',
    )
  } catch {
    /* history.state bisa ditolak pada browser lama — cadangan tetap ada */
  }
}

/** Baca state dari navigasi; jatuh ke sessionStorage kalau tidak ada. */
export function readSearchReturn(state: unknown): SearchReturnState | null {
  const fromState = extract(state)
  if (fromState) return fromState
  const s = storage()
  try {
    const raw = s?.getItem(KEY)
    return raw ? parse(raw) : null
  } catch {
    return null
  }
}

/** Hapus cadangan sessionStorage setelah state navigasi dikonsumsi. */
export function clearSearchReturn(): void {
  const s = storage()
  try {
    s?.removeItem(KEY)
  } catch {
    /* abaikan */
  }
  try {
    const historyState = window.history.state
    if (!historyState || typeof historyState !== 'object') return
    const usr = (historyState as { usr?: Record<string, unknown> }).usr
    if (!usr || !('cariReturn' in usr)) return
    const nextUsr = { ...usr }
    delete nextUsr.cariReturn
    window.history.replaceState({ ...historyState, usr: nextUsr }, '')
  } catch {
    /* abaikan */
  }
}

/** Query string URL Cari dari payload (dipakai detail saat Kembali). */
export function searchReturnQuery(payload: SearchReturnState): string {
  const p = new URLSearchParams()
  if (payload.query) p.set('q', payload.query)
  for (const [key, value] of Object.entries(payload.filter)) {
    const isDefault =
      (key === 'source' && value === 'semua') || (key === 'sort' && value === 'terbaru')
    if (!value || isDefault) continue
    p.set(key, value)
  }
  const qs = p.toString()
  return qs ? `?${qs}` : ''
}

function extract(state: unknown): SearchReturnState | null {
  if (!state || typeof state !== 'object') return null
  const cari = (state as { cariReturn?: unknown }).cariReturn
  return cari ? parse(JSON.stringify(cari)) : null
}

function parse(raw: string): SearchReturnState | null {
  try {
    const v = JSON.parse(raw) as Partial<SearchReturnState>
    if (!v || typeof v.query !== 'string' || !v.filter || typeof v.filter !== 'object') return null
    const f = v.filter
    if (
      typeof f.source !== 'string' ||
      typeof f.sort !== 'string' ||
      typeof f.tipe !== 'string' ||
      typeof f.status !== 'string' ||
      typeof f.genre !== 'string'
    ) {
      return null
    }
    return {
      query: v.query,
      filter: { source: f.source, sort: f.sort, tipe: f.tipe, status: f.status, genre: f.genre },
      scrollY: typeof v.scrollY === 'number' && Number.isFinite(v.scrollY) ? v.scrollY : 0,
      href: typeof v.href === 'string' ? v.href : '',
    }
  } catch {
    return null
  }
}
