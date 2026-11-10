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

/** Outline heart simetris (viewBox 0 0 24 24), stroke 2 + sudut membulat. */
const HEART_D =
  'M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z'

/** "UP n" parity: gelembung kecil di kanan-atas ikon; '9+' supaya tetap ~14px. */
function badgeClass() {
  return 'pointer-events-none absolute -right-1 -top-1 grid h-[14px] min-w-[14px] place-items-center rounded-full bg-brand-amber px-0.5 text-[9px] font-bold leading-none text-white'
}

/**
 * Tombol favorit series — state dari rakStore, re-render via custom event
 * 'rak-change' (tanpa Context: satu event per tab cukup). Jumlah chapter
 * baru (unread per title_key) datang dari NotifCounts context.
 */
export default function HeartButton({ manga, className = '', labeled = false }: HeartButtonProps) {
  const [loved, setLoved] = useState(() => isFavorite(manga.title_key))
  const [pop, setPop] = useState(false)
  const { unreadByTitle } = useNotifCounts()
  const count = unreadByTitle[manga.title_key] ?? 0

  useEffect(() => {
    const onRak = () => setLoved(isFavorite(manga.title_key))
    window.addEventListener('rak-change', onRak)
    return () => window.removeEventListener('rak-change', onRak)
  }, [manga.title_key])

  const heart = (
    <svg
      viewBox="0 0 24 24"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      onAnimationEnd={() => setPop(false)}
      className={`${loved ? 'fill-brand-amber stroke-brand-amber' : 'fill-none stroke-current'} ${labeled ? 'size-4' : 'size-5'} ${pop ? 'animate-heart-pop' : ''}`}
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
          if (isFavorite(manga.title_key)) setPop(true)
        }}
        className={`flex min-h-11 shrink-0 items-center gap-1.5 rounded-xl border px-3 py-2.5 text-[13px] font-semibold transition-colors active:scale-[0.97] active:transition-transform active:duration-100 ${
          loved
            ? 'border-brand-amber-dim bg-brand-amber/15 text-brand-amber'
            : 'border-ink-700 text-ink-300 [@media(hover:hover)_and_(pointer:fine)]:hover:bg-ink-850'
        } ${className}`}
      >
        {heart}
        {loved ? 'Difavoritkan' : 'Favorit'}
        {count > 0 && ` · ${count}`}
      </button>
    )
  }

  // Target 44px: p-3 + ikon 20px; min-* mengatasi size-9 dari pemanggil.
  return (
    <button
      aria-label={loved ? 'Hapus dari favorit' : 'Tambah ke favorit'}
      aria-pressed={loved}
      onClick={(e) => {
        e.preventDefault()
        e.stopPropagation()
        toggleFavorite(manga)
        if (isFavorite(manga.title_key)) setPop(true)
      }}
      className={`relative grid min-h-11 min-w-11 touch-manipulation place-items-center rounded-full p-3 transition-colors active:scale-[0.97] active:transition-transform active:duration-100 ${className}`}
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
