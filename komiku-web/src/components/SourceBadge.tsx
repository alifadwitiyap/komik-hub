import type { SVGProps } from 'react'

/**
 * Badge sumber (komiku / non-komiku) — kecil & halus, ditaruh di kartu
 * (MangaCard/Row). User tidak perlu sadar ada 4 sumber; badge hanya memberi
 * tahu "ini bukan dari komiku" supaya ekspektasi gambar/kecepatannya pas.
 */
const LABELS: Record<string, string> = {
  komiku: 'Komiku',
  kiryuu: 'Kiryuu',
  shngm: 'Shngm',
  shinigami: 'Shinigami',
  mangaku: 'Mangaku',
  kuma: 'Kuma',
  softkomik: 'Softkomik',
  yuu: 'Yuu',
}

function label(source: string): string {
  if (LABELS[source]) return LABELS[source]
  return source.charAt(0).toUpperCase() + source.slice(1)
}

export function sourceLabel(source: string | null | undefined): string | null {
  if (!source) return null
  return label(source)
}

/** Label sumber untuk komiku sendiri dipakai sebagai pembanding di UI. */
export const KOMIKU_SOURCE = 'komiku'

export default function SourceBadge({
  source,
  className = '',
  ...rest
}: { source: string | null | undefined } & Omit<SVGProps<HTMLSpanElement>, 'children'>) {
  const text = sourceLabel(source)
  if (!text) return null
  const isKomiku = source === KOMIKU_SOURCE
  return (
    <span
      className={`inline-flex items-center rounded bg-black/55 px-1.5 py-0.5 text-[9.5px] font-semibold text-white/85 backdrop-blur-sm ${
        isKomiku ? '' : 'ring-1 ring-brand-amber/60'
      } ${className}`}
      title={`Sumber: ${text}`}
      {...rest}
    >
      {text}
    </span>
  )
}
