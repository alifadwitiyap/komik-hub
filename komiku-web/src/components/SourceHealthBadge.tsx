/**
 * SourceHealthBadge — adaptive TopBar indicator.
 *
 * Sehat (4/4, bukan stale): HP dapat SATU target 44×44 berisi dot 8px saja;
 * desktop tetap pil dot + "4/4". Begitu ada gangguan / stale / belum ada
 * data, kedua breakpoint memakai pil kontras dengan angka atau label netral.
 * Klik selalu membuka SourceHealthSheet — tidak pernah probe diam-diam.
 */

import { useCallback, useState } from 'react'
import { useSourceHealth } from '../hooks/useSourceHealth'
import SourceHealthSheet from './SourceHealthSheet'
import {
  deadSources,
  healthDescription,
  healthTier,
  type HealthTier,
} from './sourceHealth'

const PILL_CLASS: Record<HealthTier, string> = {
  ok: 'bg-healthy/12 text-healthy ring-healthy/30',
  warn: 'bg-warn/15 text-warn ring-warn/50',
  danger: 'bg-danger/15 text-danger ring-danger/50',
  unknown: 'bg-ink-850 text-ink-200 ring-ink-600',
}

const DOT_CLASS: Record<HealthTier, string> = {
  ok: 'bg-healthy',
  warn: 'bg-warn',
  danger: 'bg-danger',
  unknown: 'bg-ink-400',
}

export default function SourceHealthBadge() {
  const { rows, healthy, total, status } = useSourceHealth()
  const [open, setOpen] = useState(false)
  const close = useCallback(() => setOpen(false), [])
  const dead = deadSources(rows)
  const compact = total > 0 && healthy === total && status !== 'stale'
  // Stale dengan angka lama "sehat" tetap harus terasa seperti peringatan.
  const tier: HealthTier =
    status === 'stale' && total > 0 ? 'warn' : healthTier(healthy, total)
  const description = healthDescription(healthy, total, dead)
  const countText = total <= 0 ? 'Belum ada data' : `${healthy}/${total}`

  return (
    <>
      <button
        type="button"
        data-source-health=""
        onClick={() => setOpen(true)}
        aria-label={description}
        aria-haspopup="dialog"
        aria-expanded={open}
        className={`sh-tap inline-flex h-11 items-center justify-center gap-1.5 rounded-full text-[12px] font-bold ring-1 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-amber ${compact ? 'w-11 px-0 sm:w-auto sm:px-2.5' : 'w-auto px-2.5 ring-2'} ${PILL_CLASS[tier]}`}
      >
        <span
          aria-hidden="true"
          className={`size-2 shrink-0 rounded-full ${DOT_CLASS[tier]}`}
        />
        <span className={compact ? 'hidden tabular-nums sm:inline' : 'tabular-nums'}>
          {countText}
        </span>
      </button>
      <SourceHealthSheet open={open} onClose={close} />
    </>
  )
}
