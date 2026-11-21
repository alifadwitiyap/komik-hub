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

/** "5/5 sumber sehat" — teks count pill + tooltip. Kalau belum ada data
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

/* Derivasi panel status (plan SH §3/4). Murni: tanpa React, DOM, atau
 * library tanggal — semua bisa diuji offline. */

/** Warna latency bar/angka: mati > merah > amber > hijau (500/1500ms). */
export function latencyTier(row: SourceHealthRow): 'ok' | 'warn' | 'danger' | 'dead' {
  if (!row.ok) return 'dead'
  const ms = row.latency_ms ?? 0
  if (ms < 500) return 'ok'
  if (ms <= 1500) return 'warn'
  return 'danger'
}

/** Angka latensi tampil; sumber mati tidak mengaku punya latensi hidup. */
export function latencyLabel(row: SourceHealthRow): string {
  if (!row.ok) return 'Mati'
  return `${Math.round(row.latency_ms ?? 0)} ms`
}

/** Rasio 0..1 untuk scaleX bar (2000ms = penuh), aman untuk data absen/NaN. */
export function latencyScale(latencyMs: number | null | undefined): number {
  const ms = latencyMs ?? 0
  if (!Number.isFinite(ms)) return 0
  return Math.min(1, Math.max(0, ms / 2000))
}

/** Waktu cek relatif; `nowMs` opsional supaya uji deterministik. */
export function relativeChecked(checkedAtMs: number | null, nowMs = Date.now()): string {
  if (checkedAtMs === null || !Number.isFinite(checkedAtMs)) return 'Baru saja'
  const elapsed = nowMs - checkedAtMs
  if (!Number.isFinite(elapsed) || elapsed < 1000) return 'Baru saja'
  const seconds = Math.floor(elapsed / 1000)
  if (seconds < 60) return `${seconds} detik lalu`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes} menit lalu`
  return `${Math.floor(minutes / 60)} jam lalu`
}

/** Ringkasan header panel: "4/4 sehat" / "3/4 sehat · 1 gangguan". */
export function panelSummary(healthy: number, total: number): string {
  if (total <= 0 || healthy < 0) return 'Kesehatan sumber belum diketahui'
  const base = `${healthy}/${total} sehat`
  return healthy >= total ? base : `${base} · ${total - healthy} gangguan`
}
