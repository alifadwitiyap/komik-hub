/** Derivasi murni untuk pill source-health (TopBar). Tanpa React supaya bisa
 *  diuji langsung dengan node (lihat sourceHealth.check.ts).
 *
 *  Kontrak: GET /api/unified/health -> {total, healthy, sources:[{source,
 *  label?, ok, latency_ms?, error?}]}. `label` BOLEH absen — tooltip tetap
 *  harus menyebut nama sumber yang mati. */

import type { SourceHealthRow } from '../types'
import { sourceLabel } from './SourceBadge'

/** Nama tampil satu sumber: `label` server dulu, lalu helper badge, lalu
 *  kapitalisasi kasar sebagai jaring terakhir. */
export function rowLabel(row: SourceHealthRow): string {
  const fromServer = row.label?.trim()
  if (fromServer) return fromServer
  return sourceLabel(row.source) ?? '?'
}

/** Baris sumber dianggap MATI = !ok. Urutan payload dipertahankan. */
export function deadSources(rows: SourceHealthRow[]): SourceHealthRow[] {
  return rows.filter((r) => !r.ok)
}

/** Sumber sehat sebagai rasio bertingkat: hijau penuh / amber sebagian /
 *  merah semua mati / unknown belum ada data. */
export type HealthTier = 'ok' | 'warn' | 'danger' | 'unknown'

export function healthTier(healthy: number, total: number): HealthTier {
  if (total <= 0 || healthy < 0) return 'unknown'
  if (healthy === 0) return 'danger'
  return healthy < total ? 'warn' : 'ok'
}

/** "3/4 sumber sehat" — teks count pill + tooltip. Kalau belum ada data
 *  (total 0), jangan mengaku "0/0 sehat" — pakai kalimat netral. */
export function healthSummary(healthy: number, total: number): string {
  if (total <= 0) return 'Kesehatan sumber belum diketahui'
  return `${healthy}/${total} sumber sehat`
}

/** Satu baris tooltip untuk sumber mati: "Mangaku — timeout 8s". */
export function deadRowText(row: SourceHealthRow): string {
  const err = row.error?.trim()
  return err ? `${rowLabel(row)} — ${err}` : rowLabel(row)
}

/** Teks pembaca layar / title pill: ringkasan + sumber yang mati. */
export function healthDescription(
  healthy: number,
  total: number,
  dead: SourceHealthRow[],
): string {
  const base = healthSummary(healthy, total)
  return dead.length === 0
    ? base
    : `${base} — sumber mati: ${dead.map(deadRowText).join('; ')}`
}
