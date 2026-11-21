/**
 * SourceHealthPanel — daftar terbuka 4 sumber API, tanpa kartu bertumpuk.
 *
 * Zero-prop: state diambil langsung dari useSourceHealth. `probing`, helper
 * latensi, dan waktu relatif berasal dari lane foundation yang sudah di-merge.
 * CSS sh-* di-import oleh parent setelah lane index.css selesai.
 */

import type { CSSProperties } from 'react'
import { useSourceHealth } from '../hooks/useSourceHealth'
import type { SourceHealthRow } from '../types'
import {
  latencyLabel,
  latencyScale,
  latencyTier,
  panelSummary,
  relativeChecked,
  rowLabel,
} from './sourceHealth'

type Tone = 'ok' | 'warn' | 'danger' | 'dead' | 'muted'

const TEXT_TONE: Record<Tone, string> = {
  ok: 'text-healthy',
  warn: 'text-warn',
  danger: 'text-danger',
  dead: 'text-danger',
  muted: 'text-ink-300',
}

const BAR_TONE: Record<Tone, string> = {
  ok: 'bg-healthy',
  warn: 'bg-warn',
  danger: 'bg-danger',
  dead: 'bg-danger',
  muted: 'bg-ink-500',
}

function toneOf(row: SourceHealthRow): Tone {
  if (!row.ok) return 'dead'
  if (typeof row.latency_ms !== 'number' || !Number.isFinite(row.latency_ms)) return 'muted'
  return latencyTier(row)
}

export default function SourceHealthPanel() {
  const health = useSourceHealth()
  const summary = `${panelSummary(health.healthy, health.total)}${health.status === 'stale' ? ' · data basi' : ''}`
  const checked = relativeChecked(health.checkedAtMs)

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
          onClick={health.refresh}
          disabled={health.probing}
          aria-busy={health.probing}
          className="sh-tap inline-flex min-h-11 shrink-0 items-center gap-1.5 rounded-lg border border-ink-700 bg-ink-850 px-3 text-[12px] font-semibold text-ink-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-amber disabled:opacity-70"
        >
          <span aria-hidden="true" className={`text-[15px] leading-none ${health.probing ? 'sh-spin' : ''}`}>
            ↻
          </span>
          {health.probing ? 'Memeriksa…' : 'Cek ulang'}
        </button>
      </header>

      <ul className="divide-y divide-ink-800 border-b border-ink-800">
        {health.rows.map((row, index) => {
          const tone = toneOf(row)
          const ratio = row.ok ? latencyScale(row.latency_ms) : 0
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
                  {latencyLabel(row)}
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
