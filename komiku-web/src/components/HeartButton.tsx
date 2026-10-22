import { useEffect, useState } from 'react'
import { isFavorite, toggleFavorite } from '../rakStore'
import type { RakManga } from '../rakStore'
import { useNotifCounts } from '../notifCounts'

interface HeartButtonProps {
  manga: RakManga & { title_key: string }
  className?: string
  /** true = tombol pil dengan label (buat HP / discoverability); default ikon. */
  labeled?: boolean
}

/** Path FontAwesome heart (viewBox 0 0 512 512). */
const HEART_D =
  'M47.6 300.4L228.3 469.1c7.5 7 17.4 10.9 27.7 10.9s20.2-3.9 27.7-10.9L464.4 300.4c30.4-28.3 47.6-68 47.6-109.5v-5.8c0-69.9-50.5-129.5-119.4-141C347 36.5 300.6 51.4 268 84L256 96 244 84c-32.6-32.6-79-47.5-124.6-39.9C50.5 55.6 0 115.2 0 185.1v5.8c0 41.5 17.2 81.2 47.6 109.5z'

/** "UP n" parity: gelembung kecil di kanan-atas ikon; '9+' supaya tetap ~14px. */
function badgeClass() {
  return 'pointer-events-none absolute -right-1 -top-1 grid h-[14px] min-w-[14px] place-items-center rounded-full bg-brand-amber px-0.5 text-[9px] font-bold leading-none text-ink-950'
}

/**
 * Tombol favorit series — state dari rakStore, re-render via custom event
 * 'rak-change' (tanpa Context: satu event per tab cukup). Jumlah chapter
 * baru (unread per title_key) datang dari NotifCounts context.
 */
export default function HeartButton({ manga, className = '', labeled = false }: HeartButtonProps) {
  const [loved, setLoved] = useState(() => isFavorite(manga.title_key))
  const { unreadByTitle } = useNotifCounts()
  const count = unreadByTitle[manga.title_key] ?? 0

  useEffect(() => {
    const onRak = () => setLoved(isFavorite(manga.title_key))
    window.addEventListener('rak-change', onRak)
    return () => window.removeEventListener('rak-change', onRak)
  }, [manga.title_key])

  const heart = (
    <svg
      viewBox="0 0 512 512"
      fill={loved ? '#f59e0b' : 'none'}
      stroke={loved ? '#f59e0b' : 'currentColor'}
      strokeWidth="36"
      aria-hidden="true"
      className={labeled ? 'size-4' : 'size-5'}
    >
      <path d={HEART_D} />
    </svg>
  )

  if (labeled) {
    return (
      <button
        aria-label={loved ? 'Hapus dari favorit' : 'Tambah ke favorit'}
        aria-pressed={loved}
        onClick={(e) => {
          e.preventDefault()
          e.stopPropagation()
          toggleFavorite(manga)
        }}
        className={`flex shrink-0 items-center gap-1.5 rounded-xl border px-3 py-2.5 text-[13px] font-semibold transition-colors ${
          loved
            ? 'border-brand-amber-dim bg-brand-amber/15 text-brand-amber'
            : 'border-ink-700 text-ink-300 hover:bg-ink-850'
        } ${className}`}
      >
        {heart}
        {loved ? 'Difavoritkan' : 'Favorit'}
        {count > 0 && ` · ${count}`}
      </button>
    )
  }

  return (
    <button
      aria-label={loved ? 'Hapus dari favorit' : 'Tambah ke favorit'}
      aria-pressed={loved}
      onClick={(e) => {
        e.preventDefault()
        e.stopPropagation()
        toggleFavorite(manga)
      }}
      className={`relative grid place-items-center rounded-full p-2 transition-colors ${className}`}
    >
      {heart}
      {count > 0 && (
        <span aria-hidden="true" className={badgeClass()}>
          {count > 9 ? '9+' : count}
        </span>
      )}
    </button>
  )
}
