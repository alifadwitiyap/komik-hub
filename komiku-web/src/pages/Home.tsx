import { imgUrl } from '../imgUrl'
import { memo, useEffect, useRef, useState, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent } from 'react'
import { Link } from 'react-router-dom'
import { api, coverOf, thumbOf, toMangaCard, unifiedApi } from '../api'
import type { Homepage, HomeSection, Manga } from '../types'
import { Empty, Spinner } from '../App'
import SourceBadge, { sourceLabel } from '../components/SourceBadge'
import HeartButton from '../components/HeartButton'
import { IconPlaySolid } from '../icons'
import ContinueReading from '../components/ContinueReading'
import QuickActionSheet, { LONG_PRESS_MS, LONG_PRESS_SLOP_PX } from '../components/QuickActionSheet'
import { useProgress } from '../hooks/useProgress'

/**
 * Beranda: urutan replika Komiku+ v2.3.0 Home (fragment_home) tapi KONTEN
 * gabungan 5 sumber (unified):
 *   (a) backdrop carousel  → unifiedApi.popular(1) (item_index_backdrop)
 *   (b) Lanjut membaca      → ContinueReading (item_index_history), DI ATAS carousel
 *   (d) Populer (semua sumber)      → unifiedApi.popular(1)
 *   (e) Update terbaru (semua sumber) → unifiedApi.latest(1)
 *   (f) Pilihan Komiku      → seksi komiku lama (api.homepage) diringkas
 * Gagal fetch unified → seksi itu disembunyikan (pola sama seperti latest).
 */
export default function Home() {
  const [data, setData] = useState<Homepage | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [refreshing, setRefreshing] = useState(false)
  const [pull, setPull] = useState(0)
  const [reloadKey, setReloadKey] = useState(0)
  const touchY = useRef(0)

  const load = (sig?: AbortSignal) =>
    api.homepage(sig).then(setData).catch((e: Error) => {
      if (e.name !== 'AbortError') setError(e.message)
    })

  useEffect(() => {
    const ctrl = new AbortController()
    load(ctrl.signal)
    return () => ctrl.abort()
  }, [reloadKey])

  // Kartu untuk (a) backdrop carousel + (d) section "Populer" — SATU fetch
  // popular(1) dipakai dua tempat (app juga memakai satu respons populer).
  const [popular, setPopular] = useState<Manga[] | null>(null)
  // "Update terbaru (semua sumber)" — seksi tambahan fleksibel: gagal fetch
  // (route unified belum siap) cukup membuat seksi ini tidak muncul, seksi
  // Komiku di atasnya tetap utuh.
  const [latest, setLatest] = useState<Manga[] | null>(null)
  useEffect(() => {
    // JANGAN di-gate oleh `error` legacy: homepage Komiku yang mati tidak
    // boleh membatalkan/menghalangi feed unified dari sumber lain.
    const ctrl = new AbortController()
    unifiedApi
      .popular(1, ctrl.signal)
      .then((r) => setPopular(r.items.map(toMangaCard)))
      .catch(() => setPopular([]))
    unifiedApi
      .latest(1, ctrl.signal)
      .then((r) => setLatest(r.items.map(toMangaCard)))
      .catch(() => setLatest([]))
    return () => ctrl.abort()
  }, [reloadKey])

  // SwipeRefresh replika: tarik dari atas saat scroll sudah di puncak
  const onTouchStart = (e: React.TouchEvent) => {
    if (window.scrollY <= 0) touchY.current = e.touches[0].clientY
  }
  const onTouchMove = (e: React.TouchEvent) => {
    if (!touchY.current || refreshing) return
    const dy = e.touches[0].clientY - touchY.current
    if (dy > 0 && window.scrollY <= 0) setPull(Math.min(dy * 0.4, 90))
  }
  const onTouchEnd = () => {
    if (pull > 55 && !refreshing) {
      setRefreshing(true)
      load().finally(() => {
        setRefreshing(false)
        setPull(0)
      })
    } else {
      setPull(0)
    }
    touchY.current = 0
  }

  // Halaman TIDAK boleh mati hanya karena homepage legacy Komiku gagal.
  // Tunggu sampai setidaknya satu feed unified selesai (null = masih jalan);
  // kalau semuanya kosong DAN legacy error, baru tampilkan pesan gagal.
  if (!data && popular === null && latest === null) {
    return <Spinner label="Memuat beranda…" />
  }
  if (!data && (popular?.length ?? 0) === 0 && (latest?.length ?? 0) === 0 && error) {
    return (
      <Empty
        title="Gagal memuat beranda"
        body="Coba lagi."
        action={
          <button
            type="button"
            onClick={() => {
              setError(null)
              setReloadKey((k) => k + 1)
            }}
            className="min-h-11 rounded-full bg-brand-amber px-5 py-2.5 text-[13px] font-bold text-white transition-colors active:scale-[0.97] active:duration-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-amber focus-visible:ring-offset-2 [@media(hover:hover)]:hover:bg-brand-amber-soft"
          >
            Coba lagi
          </button>
        }
      />
    )
  }

  const sections = Object.entries((data ?? {}) as Homepage)
    .filter(([k, v]) => k !== 'success' && typeof v === 'object' && v && 'data' in v)
    .map(([k, v]) => ({ key: k, ...(v as HomeSection) }))
    .filter((s) => s.data.length > 0)

  // (f) "Pilihan Komiku": dari seksi komiku lama, dipotong 12 kartu supaya
  // tidak menguasai beranda. Unik per id, urutan sesuai tiap seksi homepage.
  const komikuChoice = Array.from(
    new Map(
      sections
        .flatMap((s) => s.data)
        .map((m) => [m.id, m] as const),
    ).values(),
  ).slice(0, 12)

  // (a) backdrop carousel: 2 populer pertama (cukup sebagai pintu visual;
  // 5 slide membuat katalog baru terlihat di layar pertama). Fallback ke
  // seksi komiku pertama kalau unified mati — carousel tak pernah kosong.
  const featured = (popular ?? []).length > 0
    ? popular!.slice(0, 2)
    : (sections[0]?.data.slice(0, 2) ?? [])

  // Bila ada riwayat, "Lanjut membaca" tampil paling atas (tepat di bawah
  // header) supaya pembaca yang kembali bisa langsung melanjutkan bacaan.
  return (
    <div
      onTouchStart={onTouchStart}
      onTouchMove={onTouchMove}
      onTouchEnd={onTouchEnd}
      className="relative"
    >
      <h1 className="sr-only">Komik Hub</h1>
      {/* indikator tarik-untuk-refresh */}
      {(pull > 10 || refreshing) && (
        <div
          className="flex justify-center overflow-hidden transition-[height] duration-200"
          style={{ height: refreshing ? 48 : pull }}
        >
          <span
            className={`mt-3 size-5 rounded-full border-2 border-ink-300 border-t-brand-amber ${
              refreshing ? 'animate-spin' : ''
            }`}
          />
        </div>
      )}

      {/* Legacy Komiku gagal: beri tahu tanpa memblokir feed sumber lain. */}
      {error && (
        <div className="mx-2.5 mt-3 rounded-xl border border-ink-800 bg-ink-900 px-3 py-2 text-[12px] text-ink-300">
          Sebagian konten Komiku tidak tersedia — menampilkan sumber lain.
        </div>
      )}

      {/* "Lanjut membaca" tampil langsung di bawah header agar pembaca bisa
          segera lanjut — lebih dekat daripada carousel atau pintasan. */}
      <ContinueReading />

      {featured.length > 0 && <BackdropCarousel items={featured} />}

      <div className="mx-auto max-w-3xl pb-2">
        {/* (d) Populer (semua sumber) */}
        {popular && popular.length > 0 && (
          <Section id="populer" title="Populer (semua sumber)">
            {popular.map((m) => (
              <MangaCard key={`pop-${m.id}`} manga={m} />
            ))}
          </Section>
        )}

        {/* (e) Update terbaru (semua sumber) */}
        {latest && latest.length > 0 && (
          <Section id="terbaru" title="Update terbaru (semua sumber)">
            {latest.map((m) => (
              <MangaCard key={`new-${m.id}`} manga={m} />
            ))}
          </Section>
        )}

        {/* (f) Pilihan Komiku: komiku lama diringkas jadi SATU seksi (isinya
            HOT/Update Rekomendasi/Trending dari homepage legacy, 12 kartu). */}
        {komikuChoice.length > 0 && (
          <Section id="pilihan-komiku" title="Pilihan Komiku">
            {komikuChoice.map((m) => (
              <MangaCard key={`kom-${m.id}`} manga={m} />
            ))}
          </Section>
        )}
      </div>

    </div>
  )
}

/**
 * Backdrop carousel (item_index_backdrop): sampul full-bleed di wadah
 * rounded-xl (tanpa celah abu-abu), scrim gelap 85% di bawah untuk
 * judul/tipe/chapter. Auto-advance 4s + dots + scroll-snap; target 44px.
 */
function BackdropCarousel({ items }: { items: Manga[] }) {
  const [idx, setIdx] = useState(0)
  // autoplay = izin putar otomatis; jeda/henti user mematikannya permanen.
  const [autoplay, setAutoplay] = useState(true)
  const [tabHidden, setTabHidden] = useState(() => document.hidden)
  const [focusInside, setFocusInside] = useState(false)
  const scrollRef = useRef<HTMLDivElement>(null)
  // Gate fokus harus mencakup dot + tombol jeda (sibling di luar track).
  const wrapperRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const sync = () => setTabHidden(document.hidden)
    document.addEventListener('visibilitychange', sync)
    return () => document.removeEventListener('visibilitychange', sync)
  }, [])

  // Putar otomatis 4s HANYA saat tab terlihat, tak ada fokus di carousel, dan
  // OS tidak meminta reduced-motion. Interaksi user (sentuhan, klik dot, jeda)
  // mematikan autoplay sampai tombol Lanjutkan dipencet (WCAG 2.2.2 / 3.2.5).
  useEffect(() => {
    if (items.length <= 1 || !autoplay || tabHidden || focusInside) return
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)')
    if (mq.matches) return
    const t = setInterval(() => {
      // Setelan OS / visibilitas bisa berubah saat halaman terbuka.
      if (mq.matches || document.hidden) return
      if (wrapperRef.current?.contains(document.activeElement)) return
      setIdx((i) => (i + 1) % items.length)
    }, 4000)
    return () => clearInterval(t)
  }, [items.length, autoplay, tabHidden, focusInside])

  const goTo = (i: number) => {
    const el = scrollRef.current
    if (!el) return
    const target = Math.min(Math.max(i, 0), items.length - 1)
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    el.scrollTo({ left: target * el.clientWidth * 0.94, behavior: reduce ? 'auto' : 'smooth' })
    setIdx(target)
  }

  return (
    <div
      ref={wrapperRef}
      className="relative px-4 pt-3"
      onFocusCapture={() => setFocusInside(true)}
      onBlurCapture={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setFocusInside(false)
      }}
    >
      <div
        ref={scrollRef}
        className="no-bar flex snap-x snap-proximity gap-2.5 overflow-x-auto rounded-xl"
        onPointerDownCapture={() => setAutoplay(false)}
        onScroll={(e) => {
          const el = e.currentTarget
          const i = Math.round(el.scrollLeft / (el.clientWidth * 0.94))
          setIdx(Math.min(Math.max(i, 0), items.length - 1))
        }}
      >
        {items.map((m) => {
          const img = coverOf(m)
          const label = chapterLabel(m)
          const subtitle = [m.tipe?.[0], label ?? m.other?.[0]].filter(Boolean).join(' · ') || 'Manga'
          return (
            <Link
              key={m.id}
              to={m.handle ? `/manga/${m.handle}` : `/manga/${m.id}`}
              className="relative w-[94%] shrink-0 snap-start overflow-hidden rounded-xl border-[0.8px] border-ink-800 active:scale-[0.97] active:duration-100"
            >
              {/* Sampul mengisi seluruh kartu — tidak ada ruang abu-abu. */}
              <div className="relative aspect-[4/3] overflow-hidden bg-black">
                {img && (
                  <img referrerPolicy="no-referrer"
                    src={imgUrl(img)}
                    alt=""
                    role="presentation"
                    aria-hidden="true"
                    className="size-full object-cover"
                    loading="eager"
                    decoding="async"
                  />
                )}
                {/* scrim bawah ~85% untuk judul, tipe, dan chapter */}
                <div className="absolute inset-x-0 bottom-0 h-3/4 bg-gradient-to-t from-black/85 via-black/60 to-transparent" />
                <div className="absolute inset-x-0 bottom-0 px-3 pb-3">
                  <p className="line-clamp-2 font-display text-[16px] font-semibold text-white [text-shadow:_0_1px_4px_rgb(0_0_0_/_80%)]">
                    {m.title}
                  </p>
                  <p className="mt-0.5 line-clamp-1 text-[11.5px] font-bold text-white/90 [text-shadow:_0_1px_4px_rgb(0_0_0_/_80%)]">
                    {subtitle}
                  </p>
                  {m.update_date && (
                    <p className="mt-0.5 line-clamp-1 text-[10.5px] text-white/70 [text-shadow:_0_1px_4px_rgb(0_0_0_/_80%)]">
                      Update {m.update_date.trim()}
                    </p>
                  )}
                </div>
              </div>
            </Link>
          )
        })}
      </div>
      {/* kontrol jeda/putar otomatis */}
      {items.length > 1 && (
        <button
          type="button"
          onClick={() => setAutoplay((a) => !a)}
          aria-label={autoplay ? 'Jeda putar otomatis' : 'Lanjutkan putar otomatis'}
          aria-pressed={!autoplay}
          className="absolute right-4 top-4 grid size-11 place-items-center rounded-full bg-black/50 text-white backdrop-blur-sm transition-colors [@media(hover:hover)]:hover:bg-black/70"
        >
          {autoplay ? <IconPause className="size-3.5" /> : <IconPlaySolid className="size-3.5" />}
        </button>
      )}
      {/* dots — area sentuh 44px, titik visual tetap 6/16px */}
      {items.length > 1 && (
        <div className="mt-2 flex justify-center gap-1.5">
          {items.map((m, i) => (
            <button
              key={m.id}
              type="button"
              onClick={() => {
                setAutoplay(false)
                goTo(i)
              }}
              aria-label={`Menuju slide ${i + 1}`}
              aria-current={i === idx ? 'true' : undefined}
              className="grid size-11 place-items-center rounded-full"
            >
              <span
                aria-hidden="true"
                className={`h-1.5 rounded-full transition-[transform] duration-200 ease-out origin-left ${
                  i === idx ? 'w-2 scale-x-[2.5] bg-brand-amber' : 'w-2 bg-ink-300'
                }`}
              />
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

function IconPause(p: React.SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" {...p}>
      <path d="M6 5h4v14H6zM14 5h4v14h-4z" />
    </svg>
  )
}

/**
 * Seksi kartu horizontal. `id` dipakai anchor shortcut menu (/#populer,
 * /#terbaru) — react-router langsung scroll ke elemen dengan id itu.
 */
export function Section({
  id,
  title,
  moreTo,
  children,
}: {
  id?: string
  title: string
  moreTo?: string
  children: React.ReactNode
}) {
  return (
    <section id={id} className="mt-5 scroll-mt-16">
      <div className="flex items-baseline justify-between px-4">
        <h2 className="font-display text-[14.5px] font-semibold text-ink-100">{title}</h2>
        {moreTo && (
          <Link to={moreTo} className="grid min-h-11 min-w-11 place-items-center px-2 py-3 -mx-2 text-[12px] font-semibold text-brand-amber">
            Lihat semua
          </Link>
        )}
      </div>
      <div className="no-bar mt-3 flex snap-x snap-proximity gap-3 overflow-x-auto px-4 pb-1">
        {children}
      </div>
    </section>
  )
}

/** Kartu katalog: cover + judul 2 baris + label chapter eksplisit "Ch. N".
 *  Dipakai Home dan Search; label dibentuk di sini (bukan di Search) supaya
 *  formatnya konsisten. `other[0]` dari API biasanya last_chapter mentah. */
export function chapterLabel(manga: Manga): string | null {
  const first = manga.other?.[0]
  if (typeof first !== 'string') return null
  const raw = first.trim().replace(/^Chapter\s+/i, '')
  const number = raw.replace(/^Ch\.\s*/i, '')
  if (!/^\d+(?:[.,]\d+)?$/.test(number)) return null
  return `Ch. ${number}`
}

export const MangaCard = memo(function MangaCard({
  manga,
  compact = false,
}: {
  manga: Manga
  /** Baris hasil pencarian: cover 2:3 kecil, 4–6 judul per layar. */
  compact?: boolean
}) {
  const [failed, setFailed] = useState(false)
  const img = coverOf(manga)
  // kartu unified (handle 'sumber:id') → route handle; kartu komiku → id lama.
  const to = manga.handle ? `/manga/${manga.handle}` : `/manga/${manga.id}`
  const label = chapterLabel(manga)
  const meta = [
    sourceLabel(manga.source),
    manga.tipe?.[0],
    manga.update_date?.trim() ? `Update ${manga.update_date.trim()}` : null,
  ]
    .filter(Boolean)
    .join(' · ')
  const canFavorite = Boolean(manga.title_key && (manga.handle || manga.id != null))
  const { recent } = useProgress()
  const handle = manga.handle ?? String(manga.id)
  const progress = recent.find((p) =>
    [p.handle, p.seriesId, String(p.handle ?? '').split(':').pop()]
      .some((key) => key != null && (String(key) === handle || String(key) === String(manga.id))),
  ) ?? null

  // Long-press 350ms → sheet; geser >10px / pointercancel / lepas lebih awal
  // membatalkan. Klik setelah long-press ditelan supaya kartu tak navigasi.
  const [sheetOpen, setSheetOpen] = useState(false)
  const [pressing, setPressing] = useState(false)
  const openerRef = useRef<HTMLElement | null>(null)
  const press = useRef<{ x: number; y: number; timer: number | null } | null>(null)
  const suppressClick = useRef(false)
  const clearPress = () => {
    if (press.current?.timer != null) window.clearTimeout(press.current.timer)
    press.current = null
    setPressing(false)
  }
  const onPointerDown = (e: ReactPointerEvent<HTMLAnchorElement>) => {
    if (e.button !== 0 || !e.isPrimary) return
    if ((e.target as HTMLElement).closest('button')) return
    openerRef.current = e.currentTarget
    setPressing(true)
    const timer = window.setTimeout(() => {
      press.current = null
      setPressing(false)
      suppressClick.current = true
      setSheetOpen(true)
      try {
        navigator.vibrate?.(10)
      } catch {
        /* getar tidak didukung (jsdom / browser lama) */
      }
      window.setTimeout(() => { suppressClick.current = false }, 800)
    }, LONG_PRESS_MS)
    press.current = { x: e.clientX, y: e.clientY, timer }
  }
  const onPointerMove = (e: ReactPointerEvent<HTMLAnchorElement>) => {
    const state = press.current
    if (state && Math.hypot(e.clientX - state.x, e.clientY - state.y) > LONG_PRESS_SLOP_PX) clearPress()
  }
  const onClickCapture = (e: ReactMouseEvent<HTMLAnchorElement>) => {
    if (!suppressClick.current) return
    e.preventDefault()
    e.stopPropagation()
    suppressClick.current = false
  }
  const pressHandlers = {
    onPointerDown,
    onPointerMove,
    onPointerUp: clearPress,
    onPointerCancel: clearPress,
    onClickCapture,
  }
  const moreButton = (
    <button
      type="button"
      aria-label={`Aksi cepat ${manga.title}`}
      data-quick-action=""
      onPointerDown={(e) => e.stopPropagation()}
      onClick={(e) => {
        e.preventDefault()
        e.stopPropagation()
        openerRef.current = e.currentTarget
        setSheetOpen(true)
      }}
      className="absolute right-0 top-0 z-10 grid min-h-11 min-w-11 place-items-center rounded-lg bg-black/55 text-[16px] font-bold text-white backdrop-blur-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-amber"
    >
      ⋮
    </button>
  )
  const sheet = (
    <QuickActionSheet
      open={sheetOpen}
      onClose={() => setSheetOpen(false)}
      manga={manga}
      progress={progress}
      openerRef={openerRef}
    />
  )

  // Cover dipakai dua layout: rail Home (132px) dan baris Search (72px).
  // HeartButton sudah preventDefault + stopPropagation, jadi tidak membuka
  // series meski tombolnya bersarang di Link.
  const cover = (
    <div
      className={`relative aspect-[2/3] overflow-hidden rounded-xl border border-ink-800 bg-ink-850 ${
        compact ? 'w-[72px] shrink-0' : ''
      }`}
    >
      {img && !failed ? (
        <img referrerPolicy="no-referrer"
          src={imgUrl(img)}
          alt={manga.title}
          loading="lazy"
          decoding="async"
          onError={() => setFailed(true)}
          className="size-full object-cover card-cover"
        />
      ) : (
        <span className="grid size-full place-items-center px-2 text-center text-[11px] text-ink-500">
          {manga.title}
        </span>
      )}
      {label && !compact && (
        <span className="absolute right-1 top-1 max-w-[calc(100%-0.5rem)] truncate rounded bg-black/70 px-1.5 py-0.5 text-[10px] font-bold tabular-nums text-white">
          {label}
        </span>
      )}
      {canFavorite && (
        <HeartButton
          manga={{
            title_key: manga.title_key!,
            title: manga.title,
            cover_url: img ?? null,
            handle: manga.handle ?? String(manga.id),
            source: manga.source ?? 'komiku',
          }}
          className="absolute left-0 top-0 z-10 bg-black/55 text-white backdrop-blur-sm"
        />
      )}
      {moreButton}
    </div>
  )

  const chapter = label ? (
    <p className="mt-0.5 line-clamp-1 text-[11px] font-bold leading-snug tabular-nums text-ink-200">
      {label}
    </p>
  ) : manga.other?.[0] ? (
    <p className="mt-0.5 line-clamp-1 text-[11px] font-bold leading-snug tabular-nums text-ink-200">
      {manga.other[0]}
    </p>
  ) : null

  if (compact) {
    return (
      <>
        <Link
          to={to}
          {...pressHandlers}
          style={pressing ? { transform: 'scale(0.97)' } : undefined}
          className="tactile-press flex w-full items-start gap-3 rounded-xl border border-ink-800 bg-ink-900 p-2 active:scale-[0.99] active:duration-100"
        >
          {cover}
          <div className="min-w-0 flex-1 py-0.5">
            <p className="line-clamp-2 min-h-[2.6em] font-display text-[13px] font-medium leading-snug text-ink-100">
              {manga.title}
            </p>
            {chapter}
            {meta && (
              <p className="mt-0.5 line-clamp-1 text-[11px] leading-snug text-ink-300">{meta}</p>
            )}
          </div>
        </Link>
        {sheet}
      </>
    )
  }

  return (
    <>
      <Link to={to} {...pressHandlers} style={pressing ? { transform: 'scale(0.97)' } : undefined} className="tactile-press group block w-[132px] shrink-0 snap-start sm:w-[150px]">
        {cover}
        <p className="mt-2 line-clamp-2 min-h-[2.6em] font-display text-[12.5px] font-medium leading-snug text-ink-100">
          {manga.title}
        </p>
        {chapter}
        {meta && (
          <p className="mt-0.5 line-clamp-1 text-[11px] leading-snug text-ink-300">{meta}</p>
        )}
      </Link>
      {sheet}
    </>
  )
})

/** Kartu kecil untuk daftar chapter / hasil pencarian list-style. */
export function Row({ manga }: { manga: Manga }) {
  const [failed, setFailed] = useState(false)
  const img = thumbOf(manga)
  const to = manga.handle ? `/manga/${manga.handle}` : `/manga/${manga.id}`

  return (
    <Link
      to={to}
      className="flex items-center gap-3 rounded-xl border border-ink-800 bg-ink-900 p-2.5 transition-colors active:scale-[0.97] active:duration-100 [@media(hover:hover)]:hover:border-ink-700"
    >
      <div className="size-12 shrink-0 overflow-hidden rounded-xl bg-ink-850">
        {img && !failed && (
          <img referrerPolicy="no-referrer"
            src={imgUrl(img)}
            alt=""
            loading="lazy"
            onError={() => setFailed(true)}
            className="size-full object-cover"
          />
        )}
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <p className="truncate text-[13px] font-medium text-ink-100">{manga.title}</p>
          {manga.source && manga.source !== 'komiku' && (
            <SourceBadge source={manga.source} className="shrink-0" />
          )}
        </div>
        <p className="truncate text-[11px] text-ink-500">
          {manga.tipe?.join(', ') || 'Manga'}
          {manga.score && manga.score !== '-' ? ` · ★ ${manga.score}` : ''}
        </p>
      </div>
      {/* favorit langsung dari hasil pencarian (semua kartu ber-title_key;
          kartu Komiku lama memakai id numerik sebagai handle rak) */}
      {manga.title_key && (manga.handle || manga.id != null) && (
        <HeartButton
          manga={{
            title_key: manga.title_key,
            title: manga.title,
            cover_url: img ?? null,
            handle: manga.handle ?? String(manga.id),
            source: manga.source ?? 'komiku',
          }}
          className="shrink-0 text-ink-300 [@media(hover:hover)]:hover:text-brand-amber"
        />
      )}
    </Link>
  )
}