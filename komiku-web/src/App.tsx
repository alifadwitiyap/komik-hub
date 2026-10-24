import { Link, NavLink, Route, Routes, useLocation, useParams } from 'react-router-dom'
import { lazy, Suspense, useEffect, useRef, useState } from 'react'
import Home from './pages/Home'
import Search from './pages/Search'
import Series from './pages/Series'
import Rak from './pages/Rak'
const SeriesUnified = lazy(() => import('./pages/SeriesUnified'))
const Reader = lazy(() => import('./pages/Reader'))
const ReaderMarathon = lazy(() => import('./pages/ReaderMarathon'))
const Akun = lazy(() => import('./pages/Akun'))
const Notifikasi = lazy(() => import('./pages/Notifikasi'))
import { IconHouse, IconRectangleHistory, IconMoon, IconSun, IconMagnifyingGlass, IconBookHeart, IconBell, IconUser } from './icons'
import NotifPanel from './components/NotifPanel'
import SourceHealthBadge from './components/SourceHealthBadge'
import LoginPromoModal from './components/LoginPromoModal'
import { startFavoritesSync } from './notifStore'
import { startReadMarksSync } from './readMarks'
import { captureFromUrl } from './account'
import { NotifCountsProvider, useNotifCounts } from './notifCounts'
import { useTheme } from './hooks/useTheme'

const NAV = [
  { to: '/', label: 'Beranda', icon: IconHouse },
  { to: '/cari', label: 'Cari', icon: IconMagnifyingGlass },
  { to: '/rak', label: 'Rak', icon: IconRectangleHistory },
]

export default function App() {
  const { pathname } = useLocation()
  // Reader adalah halaman layar penuh: nav bawah disembunyikan
  const immersive = /^\/(baca|maraton)/.test(pathname)

  // Link akun (?u=<username>) bisa mendarat di route mana pun (default '/').
  // Tangkap identitasnya SEKALI, sebelum sync favorit mulai, supaya hydrate
  // langsung memakai akun yang benar; query lalu dibersihkan dari address bar.
  useState(() => captureFromUrl())

  // sinkron favorit → server notifikasi (PUT /api/notif/favorites)
  useState(() => startFavoritesSync())
  // sinkron mark "sudah dibaca" → server per-akun (PUT /api/read, union)
  useState(() => startReadMarksSync())
  const [bellOpen, setBellOpen] = useState(false)

  return (
    <NotifCountsProvider>
      <div className="min-h-full bg-ink-950">
        {!immersive && (
          <TopBar bellOpen={bellOpen} onToggleBell={() => setBellOpen((o) => !o)} onClosePanel={() => setBellOpen(false)} />
        )}

        <main className={immersive ? '' : 'pb-24 pt-14'}>
          <Suspense fallback={<Spinner label="Memuat…" />}>
            <Routes>
              <Route path="/" element={<Home />} />
              <Route path="/cari" element={<Search />} />
              <Route path="/rak" element={<Rak />} />
              <Route path="/akun" element={<Akun />} />
              <Route path="/notifikasi" element={<Notifikasi />} />
              {/* manga: id komiku lama (angka) ATAU handle unified 'sumber:id' */}
              <Route path="/manga/:handle" element={<SeriesRoute />} />
              <Route path="/baca/:chapterId" element={<Reader />} />
              <Route path="/baca/:handle/:number" element={<Reader />} />
              <Route path="/maraton/:chapterId" element={<ReaderMarathon />} />
              <Route path="/maraton/:handle/:number" element={<ReaderMarathon />} />
              <Route path="*" element={<NotFound />} />
            </Routes>
          </Suspense>
        </main>

        {!immersive && <BottomNav />}

        <LoginPromoModal />
      </div>
    </NotifCountsProvider>
  )
}

/**
 * Router /manga/:handle — sama seperti Series.tsx lama menerima id angka.
 * Handle mengandung ':' (sumber:native_id) → arahkan ke halaman unified;
 * selain itu tetap ke flow Komiku existing.
 */
function SeriesRoute() {
  const { handle = '' } = useParams<{ handle: string }>()
  return handle.includes(':') ? <SeriesUnified /> : <Series />
}

/**
 * AppBar replica app_bar_main_content: logo PNG Komik Hub
 * (app_text_logo dari aset baru) + 4 tombol lingkaran 35dp (isap gelap, cari,
 * rak buku, notifikasi) dengan ripple bg.
 */
function TopBar({
  bellOpen,
  onToggleBell,
  onClosePanel,
}: {
  bellOpen: boolean
  onToggleBell: () => void
  onClosePanel: () => void
}) {
  const notif = useNotifCounts()
  // panel baru dibuka → tarik data terbaru
  const refreshNotif = notif.refresh
  useEffect(() => {
    if (bellOpen) refreshNotif()
  }, [bellOpen, refreshNotif])

  // batas "di dalam" untuk klik-luar panel: menu + lonceng sekaligus,
  // supaya klik lonceng tidak langsung ditutup listener luar.
  const bellWrap = useRef<HTMLDivElement>(null)

  return (
    <header className="fixed inset-x-0 top-0 z-40 border-b border-ink-800 bg-ink-950/95 backdrop-blur">
      <div className="mx-auto flex h-14 max-w-3xl items-center gap-1 px-3">
        <Link to="/" className="flex items-center" aria-label="Komik Hub">
          <img src="/logo-komik-hub.png" alt="Komik Hub" width={125} height={23} className="h-[23px] w-auto" />
        </Link>
        <div className="ml-auto flex items-center gap-1.5">
          <SourceHealthBadge />
          <ThemeToggle />
          <CircleButton label="Cari" to="/cari">
            <IconMagnifyingGlass className="size-4" />
          </CircleButton>
          <CircleButton label="Rak buku" to="/rak">
            <IconBookHeart className="size-4" />
          </CircleButton>
          <CircleButton label="Akun" to="/akun">
            <IconUser className="size-4" />
          </CircleButton>
          <div className="relative" ref={bellWrap}>
            <CircleButton
              label={notif.unread > 0 ? `Notifikasi, ${notif.unread} belum dibaca` : 'Notifikasi'}
              onClick={onToggleBell}
              aria-expanded={bellOpen}
            >
              <IconBell className="size-4" />
            </CircleButton>
            {notif.unread > 0 && (
              <span
                aria-hidden="true"
                className="pointer-events-none absolute -right-1 -top-1 grid min-w-4 place-items-center rounded-full bg-brand-amber px-1 text-[9px] font-bold leading-4 text-ink-950"
              >
                {notif.unread > 99 ? '99+' : notif.unread}
              </span>
            )}
            <NotifPanel
              open={bellOpen}
              items={notif.items}
              unread={notif.unread}
              loading={notif.loading}
              onClose={onClosePanel}
              onMarkRead={notif.markRead}
              onDismiss={notif.dismiss}
              boundaryRef={bellWrap}
            />
          </div>
        </div>
      </div>
    </header>
  )
}

/**
 * Tombol tema: bulan saat terang (klik → gelap), matahari saat gelap
 * (klik → terang). Ikon diganti dengan transisi 200ms (opacity + rotate)
 * supaya tidak berkedip kasar. Nilai disimpan di localStorage; sekali user
 * memilih, setelan OS tidak lagi diikuti.
 */
function ThemeToggle() {
  const { theme, toggle, toggleLabel } = useTheme()
  const dark = theme === 'dark'
  return (
    <button
      type="button"
      onClick={toggle}
      aria-label={toggleLabel}
      aria-pressed={dark}
      data-theme-toggle
      title={toggleLabel}
      className="grid size-[40px] place-items-center rounded-full bg-ink-850 text-ink-300 transition-colors active:bg-ink-800"
    >
      {/* dua ikon ditumpuk; yang aktif yang terlihat (fade + rotate 200ms) */}
      <span className="relative grid size-4 place-items-center">
        <IconMoon
          className={`absolute size-4 transition-all duration-200 ${
            dark ? 'scale-50 rotate-90 opacity-0' : 'scale-100 rotate-0 opacity-100'
          }`}
        />
        <IconSun
          className={`absolute size-4 transition-all duration-200 ${
            dark ? 'scale-100 rotate-0 opacity-100' : 'scale-50 -rotate-90 opacity-0'
          }`}
        />
      </span>
    </button>
  )
}

function CircleButton({
  label,
  to,
  onClick,
  children,
  ...rest
}: {
  label: string
  to?: string
  onClick?: () => void
  children: React.ReactNode
} & React.AriaAttributes) {
  const cls =
    'grid size-[40px] place-items-center rounded-full bg-ink-850 text-ink-300 transition-colors active:bg-ink-800'
  if (to) {
    return (
      <Link to={to} aria-label={label} className={cls} {...rest}>
        {children}
      </Link>
    )
  }
  return (
    <button aria-label={label} onClick={onClick} className={cls} {...rest}>
      {children}
    </button>
  )
}

/** BottomNav replica layout_navigation_main: ikon 16sdp + caption. */
function BottomNav() {
  return (
    <nav className="fixed inset-x-0 bottom-0 z-40 border-t border-ink-800 bg-ink-950/95 pb-[env(safe-area-inset-bottom)] backdrop-blur">
      <ul className="mx-auto flex max-w-3xl">
        {NAV.map(({ to, label, icon: Icon }) => (
          <li key={to} className="flex-1">
            <NavLink
              to={to}
              end={to === '/'}
              className={({ isActive }) =>
                `flex flex-col items-center gap-[3px] py-2 text-[10.5px] font-medium transition-colors ${
                  isActive ? 'text-brand-amber' : 'text-ink-500'
                }`
              }
            >
              <Icon className="size-4" />
              {label}
            </NavLink>
          </li>
        ))}
      </ul>
    </nav>
  )
}

function NotFound() {
  return <Empty title="Halaman tidak ada" body="Periksa lagi alamatnya." />
}

export function Empty({ title, body }: { title: string; body: string }) {
  return (
    <div className="mx-auto max-w-3xl px-4 py-16 text-center">
      <p className="text-base font-semibold text-ink-200">{title}</p>
      <p className="mt-1 text-sm text-ink-400">{body}</p>
    </div>
  )
}

export function Spinner({ label = 'Memuat…' }: { label?: string }) {
  return (
    <div className="flex items-center justify-center gap-3 py-14 text-sm text-ink-400">
      <span className="size-4 animate-spin rounded-full border-2 border-ink-600 border-t-brand-amber" />
      {label}
    </div>
  )
}
