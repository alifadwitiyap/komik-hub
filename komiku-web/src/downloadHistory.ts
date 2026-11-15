/**
 * Ledger chapter yang sudah selesai diunduh — tahan tab ditutup.
 * Dipakai downloadStore (markDownloadDone saat job 'ok') dan SeriesUnified
 * (doneNumbers untuk menandai chapter yang sudah ada offline).
 */

const KEY = 'komik:download-history'

function storage(): Storage | null {
  try {
    return typeof localStorage !== 'undefined' ? localStorage : null
  } catch {
    return null
  }
}

function read(): Record<string, string[]> {
  const s = storage()
  if (!s) return {}
  try {
    const raw = s.getItem(KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    const out: Record<string, string[]> = {}
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (Array.isArray(v) && v.every((n) => typeof n === 'string')) out[k] = v
    }
    return out
  } catch {
    return {}
  }
}

function write(map: Record<string, string[]>): void {
  const s = storage()
  if (!s) return
  try {
    s.setItem(KEY, JSON.stringify(map))
  } catch {
    /* quota penuh / mode privat — ledger best-effort, bukan data kritis */
  }
}

export function markDownloadDone(handle: string, numbers: string[]): void {
  if (!handle || !Array.isArray(numbers) || numbers.length === 0) return
  const map = read()
  const set = new Set(map[handle] ?? [])
  for (const n of numbers) {
    if (n != null) set.add(String(n))
  }
  map[handle] = [...set]
  write(map)
}

export function doneNumbers(handle: string): string[] {
  if (!handle) return []
  return read()[handle] ?? []
}
