import { imgUrl } from '../imgUrl'
import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { api, coverOf, thumbOf, toMangaCard, unifiedApi } from '../api'
import type { Homepage, HomeSection, Manga } from '../types'
import { Empty, Spinner } from '../App'
import SourceBadge from '../components/SourceBadge'
import HeartButton from '../components/HeartButton'
import { IconBolt, IconMagnifyingGlass, IconRectangleHistory, IconRotateRight } from '../icons'
import * as rakStore from '../rakStore'
import { resumeHref } from '../readerSource'
import ContinueReading from '../components/ContinueReading'

/**
 * Beranda: urutan replika Komiku+ v2.3.0 Home (fragment_home) tapi KONTEN
 * gabungan 4 sumber (unified):
 *   (a) backdrop carousel  → unifiedApi.popular(1) (item_index_backdrop)
 *   (b) shortcut menu       → ikon+label horizontal (item_index_menu_top):
 *                            Populer(#populer) · Terbaru(#terbaru) ·
 *                            Cari(/cari — mode eksplorasi penuh)
 *   (c) Lanjut membaca      → ContinueReading (item_index_history)
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
  const touchY = useRef(0)
  // FAB "Lanjut baca": entri sejarah rak terbaru. Kosong → FAB disembunyikan.
  const [resume, setResume] = useState<rakStore.HistoryEntry | null>(() =>
    rakStore.listHistory()[0] ?? null,
  )

  useEffect(() => {
    const onRak = () => setResume(rakStore.listHistory()[0] ?? null)
    window.addEventListener('rak-change', onRak)
    return () => window.removeEventListener('rak-change', onRak)
  }, [])

  const load = (sig?: AbortSignal) =>
    api.homepage(sig).then(setData).catch((e: Error) => {
      if (e.name !== 'AbortError') setError(e.message)
    })

  useEffect(() => {
    const ctrl = new AbortController()
    load(ctrl.signal)
    return () => ctrl.abort()
  }, [])

  // Kartu untuk (a) backdrop carousel + (d) section "Populer" — SATU fetch
  // popular(1) dipakai dua tempat (app juga memakai satu respons populer).
  const [popular, setPopular] = useState<Manga[] | null>(null)
  // "Update terbaru (semua sumber)" — seksi tambahan fleksibel: gagal fetch
  // (route unified belum siap) cukup membuat seksi ini tidak muncul, seksi
  // Komiku di atasnya tetap utuh.
  const [latest, setLatest] = useState<Manga[] | null>(null)
  useEffect(() => {
    if (error) return
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
  }, [error])

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

  if (error) return <Empty title="Gagal memuat beranda" body={error} />
  if (!data) return <Spinner label="Memuat beranda…" />

  const sections = Object.entries(data)
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

  // (a) backdrop carousel: 5 populer pertama dari unified (fallback ke
  // seksi komiku pertama kalau unified mati — carousel tak pernah kosong).
  const featured = (popular ?? []).length > 0
    ? popular!.slice(0, 5)
    : (sections[0]?.data.slice(0, 5) ?? [])

  return (
    <div
      onTouchStart={onTouchStart}
      onTouchMove={onTouchMove}
      onTouchEnd={onTouchEnd}
      className="relative"
    >
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

      {/* (a) Backdrop carousel replika item_index_backdrop — konten unified */}
      {featured.length > 0 && <BackdropCarousel items={featured} />}

      {/* (b) shortcut menu replika item_index_menu_top — empat pintu beranda */}
      <ShortcutMenu />

      {/* (c) "Lanjut membaca" replika item_index_history: grid 2 kolom dari
          rak. Kosong (riwayat tidak ada) → tidak dirender. */}
      <ContinueReading />

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

      {/* ExtendedFAB replika fragment_home: kanan-bawah, di atas bottom nav.
          Titik masuk resume sekarang dari rak (sejarah[0]) — FAB disembunyikan
          kalau rak masih kosong. */}
      {resume && resumeHref(resume) && (
        <Link
          to={resumeHref(resume) as string}
          aria-label="Lanjut baca"
          className="fixed bottom-24 right-4 z-30 flex items-center gap-2 rounded-2xl bg-brand-amber px-4 py-3.5 shadow-lg shadow-black/20 active:bg-brand-amber-soft"
        >
          <IconRotateRight className="size-4 text-white" />
          <span className="text-[12.5px] font-bold text-white">
            Lanjut baca · Ch {resume.last_chapter}
          </span>
        </Link>
      )}
    </div>
  )
}

/**
 * Backdrop carousel (item_index_backdrop): kartu rasio 2:1.1, radius 12,
 * sampul center-crop + gradien gelap, judul BR Hendrix putih bershadow,
 * meta + baris bawah. Auto-advance 4s + dots + scroll-snap.
 */
function BackdropCarousel({ items }: { items: Manga[] }) {
  const [idx, setIdx] = useState(0)

  useEffect(() => {
    if (items.length <= 1) return
    const t = setInterval(() => setIdx((i) => (i + 1) % items.length), 4000)
    return () => clearInterval(t)
  }, [items.length])

  return (
    <div className="px-2.5 pt-3">
      <div
        className="no-bar flex snap-x snap-mandatory gap-2.5 overflow-x-auto rounded-xl"
        onScroll={(e) => {
          const el = e.currentTarget
          const i = Math.round(el.scrollLeft / (el.clientWidth * 0.94))
          setIdx(Math.min(Math.max(i, 0), items.length - 1))
        }}
      >
        {items.map((m) => {
          const img = coverOf(m)
          return (
            <Link
              key={m.id}
              to={`/manga/${m.id}`}
              className="relative w-[94%] shrink-0 snap-start overflow-hidden rounded-xl border-[0.8px] border-ink-800"
            >
              <div className="relative aspect-[2/1.1]">
                {img && (
                  <img
                    src={imgUrl(img)}
                    alt=""
                    role="presentation"
                    aria-hidden="true"
                    className="size-full object-cover"
                    loading="eager"
                    decoding="async"
                  />
                )}
                {/* gradien gelap bawaan APK (bg_gradient_shape) */}
                <div className="absolute inset-0 bg-gradient-to-t from-black/80 via-black/25 to-transparent" />
                {m.tipe?.[0] && (
                  <span className="absolute right-2 top-2 rounded bg-brand-red/90 px-1.5 py-0.5 text-[9.5px] font-semibold text-white">
                    {m.tipe[0]}
                  </span>
                )}
                <div className="absolute inset-x-0 bottom-0 px-2 pb-2">
                  <p className="line-clamp-1 font-display text-[15px] font-medium text-white [text-shadow:_0_1px_4px_rgb(0_0_0_/_80%)]">
                    {m.title}
                  </p>
                  <p className="mt-0.5 line-clamp-1 text-[11.5px] font-bold text-white/90 [text-shadow:_0_1px_4px_rgb(0_0_0_/_80%)]">
                    {m.other?.slice(0, 2).join(' · ') || 'Manga'}
                  </p>
                  {m.update_date && (
                    <p className="mt-0.5 line-clamp-1 text-[10.5px] text-white/70">
                      Update {m.update_date.trim()}
                    </p>
                  )}
                </div>
              </div>
            </Link>
          )
        })}
      </div>
      {/* dots */}
      {items.length > 1 && (
        <div className="mt-2 flex justify-center gap-1.5">
          {items.map((m, i) => (
            <span
              key={m.id}
              className={`h-1.5 rounded-full transition-all ${
                i === idx ? 'w-4 bg-brand-amber' : 'w-1.5 bg-ink-300'
              }`}
            />
          ))}
        </div>
      )}
    </div>
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
          <Link to={moreTo} className="text-[12px] font-semibold text-brand-amber">
            Lihat semua
          </Link>
        )}
      </div>
      <div className="no-bar mt-3 flex snap-x snap-mandatory gap-3 overflow-x-auto px-4 pb-1">
        {children}
      </div>
    </section>
  )
}

/**
 * Shortcut menu replika item_index_menu_top: barisan menegak ikon+label,
 * 5 kolom sama lebar (weightSum=5 di app). Ikon diambil dari src/icons.tsx
 * supaya gaya sama dengan ikon lain di app web.
 */
const SHORTCUTS: { label: string; to: string; Icon: typeof IconBolt }[] = [
  { label: 'Populer', to: '/#populer', Icon: IconBolt },
  { label: 'Terbaru', to: '/#terbaru', Icon: IconRectangleHistory },
  { label: 'Cari', to: '/cari', Icon: IconMagnifyingGlass },
]

function ShortcutMenu() {
  // react-router (BrowserRouter) tidak scroll ke hash seperti router data —
  // scroll manual supaya pintu "#populer"/"#terbaru" benar-benar membawa
  // user ke seksi itu di halaman yang sama.
  const go = (e: React.MouseEvent, to: string) => {
    if (!to.startsWith('/#')) return
    e.preventDefault()
    document.getElementById(to.slice(2))?.scrollIntoView({ behavior: 'smooth' })
  }

  return (
    <nav aria-label="Pintasan beranda" className="mx-auto max-w-3xl px-4 pt-4">
      <ul className="flex items-stretch gap-2">
        {SHORTCUTS.map(({ label, to, Icon }) => (
          <li key={label} className="flex-1">
            <Link
              to={to}
              onClick={(e) => go(e, to)}
              className="flex flex-col items-center gap-1.5 rounded-xl border border-ink-800 bg-ink-900 px-1 py-2.5 transition-colors active:bg-ink-850"
            >
              <Icon className="size-5 text-brand-amber" />
              <span className="text-[10.5px] font-semibold text-ink-200">{label}</span>
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  )
}

export function MangaCard({ manga }: { manga: Manga }) {
  const [failed, setFailed] = useState(false)
  const img = coverOf(manga)
  // kartu unified (handle 'sumber:id') → route handle; kartu komiku → id lama.
  const to = manga.handle ? `/manga/${manga.handle}` : `/manga/${manga.id}`

  return (
    <Link
      to={to}
      className="group w-[132px] shrink-0 snap-start sm:w-[150px]"
    >
      {/* cover replika item_trend: radius 6, badge tipe di kanan bawah */}
      <div className="relative aspect-[62/82] overflow-hidden rounded-md border border-ink-800 bg-ink-850">
        {img && !failed ? (
          <img
            src={imgUrl(img)}
            alt={manga.title}
            loading="lazy"
            decoding="async"
            onError={() => setFailed(true)}
            className="size-full object-cover transition-transform duration-300 group-hover:scale-[1.03]"
          />
        ) : (
          <span className="grid size-full place-items-center px-2 text-center text-[11px] text-ink-500">
            {manga.title}
          </span>
        )}

        {/* badge sumber + favorit: kolom kanan-atas cover (badge hanya non-komiku).
            Semua kartu ber-title_key dapat ♥ overlay — kartu Komiku lama
            (handle kosong) memakai id numerik sebagai handle rak. */}
        {manga.title_key && (manga.handle || manga.id != null) ? (
          <div className="absolute right-1 top-1 flex flex-col items-end gap-1">
            {manga.source && manga.source !== 'komiku' && (
              <SourceBadge source={manga.source} />
            )}
            <HeartButton
              manga={{
                title_key: manga.title_key,
                title: manga.title,
                cover_url: img ?? null,
                handle: manga.handle ?? String(manga.id),
                source: manga.source ?? 'komiku',
              }}
              className="size-9 bg-black/60 text-white backdrop-blur hover:bg-black/75"
            />
          </div>
        ) : (
          manga.source && manga.source !== 'komiku' && (
            <SourceBadge source={manga.source} className="absolute right-1 top-1" />
          )
        )}

        {manga.score && manga.score !== '-' && (
          <span className="absolute left-1 top-1 w-fit rounded bg-black/70 px-1.5 py-0.5 text-[10px] font-bold text-white">
            ★ {manga.score}
          </span>
        )}
        {manga.tipe?.[0] && (
          <span className="absolute bottom-1 right-1 w-fit max-w-[90%] truncate rounded bg-brand-red/90 px-1.5 py-0.5 text-[9.5px] font-semibold text-white">
            {manga.tipe[0]}
          </span>
        )}
      </div>

      {/* judul BR Hendrix (brhendrix_medium), meta nunito bold, baris aksen */}
      <p className="mt-2 line-clamp-2 font-display text-[12.5px] font-medium leading-snug text-ink-100">
        {manga.title}
      </p>
      {manga.other && manga.other.length > 0 && (
        <p className="mt-0.5 line-clamp-1 text-[11px] font-bold leading-snug text-ink-500">
          {manga.other[0]}
        </p>
      )}
    </Link>
  )
}

/** Kartu kecil untuk daftar chapter / hasil pencarian list-style. */
export function Row({ manga }: { manga: Manga }) {
  const [failed, setFailed] = useState(false)
  const img = thumbOf(manga)
  const to = manga.handle ? `/manga/${manga.handle}` : `/manga/${manga.id}`

  return (
    <Link
      to={to}
      className="flex items-center gap-3 rounded-xl border border-ink-800 bg-ink-900 p-2.5 transition-colors hover:border-ink-700"
    >
      <div className="size-12 shrink-0 overflow-hidden rounded-lg bg-ink-850">
        {img && !failed && (
          <img
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
          className="size-9 shrink-0 text-ink-300 hover:text-brand-amber"
        />
      )}
    </Link>
  )
}
