/**
 * SourceHealthBadge — pill kecil di TopBar: "N/4" sumber sehat.
 *
 * Hover / fokus keyboard menampilkan tooltip yang MENYEBUT sumber mati
 * (nama + pesan error server). Warna mengikuti tier: hijau (semua sehat),
 * amber (sebagian), merah (semua mati), abu (belum ada data).
 *
 * Tooltip memakai CSS `group-hover`/`group-focus-within` — tanpa state React
 * dan tanpa listener dokumen, jadi tidak mengganggu penutupan panel lain.
 * Teks lengkap juga ada di aria-label + title supaya pembaca layar dan hover
 * native tetap dapat info walau tooltip CSS tidak muncul.
 */

import { useEffect, useMemo, useState } from 'react'
import { useSourceHealth } from '../hooks/useSourceHealth'
import { deadRowText, deadSources, healthDescription, healthTier } from './sourceHealth'

const TIER_CLASS: Record<string, string> = {
  ok: 'bg-healthy/12 text-healthy ring-healthy/30',
  warn: 'bg-warn/12 text-warn ring-warn/30',
  danger: 'bg-danger/12 text-danger ring-danger/30',
  unknown: 'bg-ink-850 text-ink-500 ring-ink-700',
}

const DOT_CLASS: Record<string, string> = {
  ok: 'bg-healthy',
  warn: 'bg-warn',
  danger: 'bg-danger',
  unknown: 'bg-ink-600',
}

export default function SourceHealthBadge() {
  const { rows, healthy, total, status, refresh } = useSourceHealth()
  const dead = useMemo(() => deadSources(rows), [rows])
  const tier = healthTier(healthy, total)
  // Angka pill: "—" selama belum ada data (probe pertama jalan ATAU 404),
  // supaya tidak pernah menampilkan "0/0" yang terbaca seperti tuduhan.
  const countText = total <= 0 ? '—' : `${healthy}/${total}`
  const description = healthDescription(healthy, total, dead)

  // klik = probe ulang manual; label singkat berubah sesaat.
  const [poked, setPoked] = useState(false)
  useEffect(() => {
    if (!poked) return
    const t = setTimeout(() => setPoked(false), 1500)
    return () => clearTimeout(t)
  }, [poked])

  return (
    <div className="group relative" data-source-health>
      <button
        type="button"
        onClick={() => {
          refresh()
          setPoked(true)
        }}
        aria-label={description}
        aria-live="polite"
        title={description}
        className={`flex h-[35px] items-center gap-1.5 rounded-full px-2.5 text-[11.5px] font-bold ring-1 transition-colors ${TIER_CLASS[tier]}`}
      >
        <span aria-hidden="true" className={`size-1.5 rounded-full ${DOT_CLASS[tier]}`} />
        <span className="tabular-nums">{countText}</span>
      </button>

      {/* tooltip: muncul saat hover / fokus keyboard. Di-centered pada pil
          (left-1/2 + -translate-x-1/2) karena `right-0` membuat tepi kiri
          jatuh di luar layar pada viewport sempit. */}
      <div
        role="tooltip"
        className="pointer-events-none absolute left-1/2 top-full z-50 mt-2 hidden w-56 max-w-[calc(100vw-1.5rem)] -translate-x-1/2 rounded-xl border border-ink-800 bg-ink-900 p-3 text-left shadow-xl shadow-black/20 group-hover:block group-focus-within:block"
      >
        <p className="font-display text-[12px] font-bold text-ink-100">{description}</p>
        {rows.length > 0 && (
          <ul className="mt-1.5 space-y-1">
            {rows.map((r) => (
              <li key={r.source} className="flex items-center gap-1.5 text-[11.5px]">
                <span
                  aria-hidden="true"
                  className={`size-1.5 shrink-0 rounded-full ${r.ok ? 'bg-healthy' : 'bg-danger'}`}
                />
                <span className={r.ok ? 'text-ink-400' : 'font-semibold text-ink-100'}>
                  {deadRowText(r)}
                </span>
              </li>
            ))}
          </ul>
        )}
        <p className="mt-2 text-[10.5px] text-ink-500">
          {status === 'stale'
            ? total <= 0
              ? 'Belum bisa memeriksa sumber.'
              : 'Pemeriksaan terakhir gagal — angka mungkin basi.'
            : poked
              ? 'Memeriksa ulang…'
              : 'Klik untuk periksa ulang.'}
        </p>
      </div>
    </div>
  )
}
