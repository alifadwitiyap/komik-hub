/**
 * SourceHealthPanel — daftar terbuka 4 sumber API, tanpa kartu bertumpuk.
 *
 * Zero-prop: state diambil langsung dari useSourceHealth. `probing` belum ada
 * di hook (lane lain menambahkannya), jadi dibaca lewat accessor kompatibel +
 * fallback lokal untuk klik manual. Parent akan menyederhanakan setelah merge.
 */

import { useState, type CSSProperties } from 'react'
import { useSourceHealth } from '../hooks/useSourceHealth'
import type { SourceHealthRow } from '../types'
import { deadSources, healthSummary, rowLabel } from './sourceHealth'

const LATENCY_CAP_MS = 2000

function panelSummary(healthy: number, total: number, deadCount: number): string {
  const base = healthSummary(healthy, total)
  if (total <= 0 || deadCount === 0) return base
  return `${base} · ${deadCount} gangguan`
}

function relativeChecked(checkedAtMs: number | null): string {
  if (checkedAtMs == null) return 'Belum pernah dicek'
  const delta = Math.max(0, Date.now() - checkedAtMs)
  if (delta < 5000) return 'Baru saja'
  if (delta < 60_000) return `${Math.floor(delta / 1000)} detik lalu`
  if (delta < 3_600_000) return `${Math.floor(delta / 60_000)} menit lalu`
  return `${Math.floor(delta / 3_600_000)} jam lalu`
}

function latencyText(row: SourceHealthRow): string {
  if (!row.ok) return 'Mati'
  const ms = row.latency_ms
  return typeof ms === 'number' && Number.isFinite(ms) ? `${Math.round(ms)} ms` : '—'
}

function latencyTone(row: SourceHealthRow): 'ok' | 'warn' | 'danger' | 'muted' {
  if (!row.ok) return 'danger'
  const ms = row.latency_ms
  if (typeof ms !== 'number' || !Number.isFinite(ms)) return 'muted'
  if (ms > 1500) return 'danger'
  if (ms >= 500) return 'warn'
  return 'ok'
}

const TEXT_TONE = {
  ok: 'text-healthy',
  warn: 'text-warn',
  danger: 'text-danger',
  muted: 'text-ink-300',
} as const

const BAR_TONE = {
  ok: 'bg-healthy',
  warn: 'bg-warn',
  danger: 'bg-danger',
  muted: 'bg-ink-500',
} as const

export default function SourceHealthPanel() {
  // Kompatibilitas sementara: hook lane belum menyediakan `probing`.
  const h = useSourceHealth() as ReturnType<typeof useSourceHealth> & { probing?: boolean }
  const [manualProbing, setManualProbing] = useState(false)
  const probing = Boolean(h.probing ?? manualProbing)
  const dead = deadSources(h.rows)
  const summary = `${panelSummary(h.healthy, h.total, dead.length)}${h.status === 'stale' ? ' · data basi' : ''}`
  const checked = relativeChecked(h.checkedAtMs)

  const refresh = () => {
    if (probing) return
    setManualProbing(true)
    Promise.resolve(h.refresh()).finally(() => setManualProbing(false))
  }

  return (
    <div className="px-4 pb-5 pt-1">
      <header className="flex items-start justify-between gap-3 border-b border-ink-800 pb-3">
        <div className="min-w-0">
          <h2 className="font-display text-[15px] font-semibold text-ink-100">Status Sumber</h2>
          <p className="mt-0.5 text-[12.5px] text-ink-300">{summary}</p>
          <p className="text-[12px] text-ink-400">Dicek {checked.toLowerCase()}</p>
        </div>
        <button
          type="button"
          onClick={refresh}
          disabled={probing}
          aria-busy={probing}
          className="sh-tap inline-flex min-h-11 shrink-0 items-center gap-1.5 rounded-lg border border-ink-700 bg-ink-850 px-3 text-[12px] font-semibold text-ink-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-amber disabled:opacity-70"
        >
          <span aria-hidden="true" className={`text-[15px] leading-none ${probing ? 'sh-spin' : ''}`}>
            ↻
          </span>
          {probing ? 'Memeriksa…' : 'Cek ulang'}
        </button>
      </header>

      <ul className="divide-y divide-ink-800 border-b border-ink-800">
        {h.rows.map((row, index) => {
          const tone = latencyTone(row)
          const ratio =
            row.ok && typeof row.latency_ms === 'number' && Number.isFinite(row.latency_ms)
              ? Math.min(1, Math.max(0, row.latency_ms / LATENCY_CAP_MS))
              : 0
          const error = row.ok ? '' : row.error?.trim() ?? ''
          return (
            <li
              key={row.source}
              className="sh-row-enter flex items-start justify-between gap-3 py-2.5"
              style={{ '--row-i': index } as CSSProperties}
            >
              <div className="flex min-w-0 items-center gap-2 pt-0.5">
                <span aria-hidden="true" className="relative grid size-2 shrink-0 place-items-center">
                  {row.ok && (
                    <span className="sh-beacon-ring absolute inset-0 rounded-full bg-healthy/45" />
                  )}
                  <span
                    className={`size-2 rounded-full ${row.ok ? 'bg-healthy' : 'bg-danger'}`}
                  />
                </span>
                <div className="min-w-0">
                  <p className="text-[14.5px] font-semibold text-ink-100">{rowLabel(row)}</p>
                  {error && <p className="mt-0.5 break-words text-[12.5px] text-ink-100">{error}</p>}
                </div>
              </div>
              <div className="flex shrink-0 flex-col items-end gap-1.5">
                <span className={`text-[12.5px] tabular-nums ${TEXT_TONE[tone]}`}>
                  {latencyText(row)}
                </span>
                <span aria-hidden="true" className="h-[3px] w-3.5 overflow-hidden rounded-full bg-ink-700">
                  <span
                    className={`sh-latency-bar block h-[3px] w-3.5 rounded-full ${BAR_TONE[tone]}`}
                    style={{ transform: `scaleX(${ratio})` }}
                  />
                </span>
              </div>
            </li>
          )
        })}
      </ul>

      <p className="mt-3 text-[12px] leading-relaxed text-ink-400">
        Pemeriksaan otomatis tiap 30 detik saat tab aktif. Gangguan 522/timeout berasal dari server sumber.
      </p>
    </div>
  )
}
