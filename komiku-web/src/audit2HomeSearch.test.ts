/**
 * Audit UI/UX 2 — kontrak Home/header/katalog/Search (mobile-first).
 * Vitest env = 'node': assertion `?raw` mengunci literal sumber, bukan DOM.
 */
import { describe, it, expect } from 'vitest'
import appSrc from './App.tsx?raw'
import homeSrc from './pages/Home.tsx?raw'
import searchSrc from './pages/Search.tsx?raw'
import heartSrc from './components/HeartButton.tsx?raw'

describe('TopBar audit2: HP logo + Menu/Notifikasi (Cari masuk burger); sisanya sm+', () => {
  it('logo kiri + Menu/Notifikasi kanan; Cari/Akun/Rak dan ThemeToggle sm+', () => {
    const circleTags = appSrc.match(/<CircleButton[^>]*>/g) ?? []
    const mobile = circleTags.filter((tag) => !tag.includes('hidden sm:grid') && !tag.includes('sm:hidden'))
    expect(mobile).toHaveLength(1)
    expect(appSrc).toContain('<CircleButton label="Cari" to="/cari" className="hidden sm:grid">')
    expect(appSrc).toContain('<CircleButton label="Rak buku" to="/rak" className="hidden sm:grid">')
    expect(appSrc).toContain('<CircleButton label="Akun" to="/akun" className="hidden sm:grid">')
    expect(appSrc.match(/<div className="hidden sm:flex">/g)?.length).toBe(1)
    expect(appSrc).toContain('<SourceHealthBadge />')
    expect(appSrc).toContain('<ThemeToggle />')
  })

  it('tombol Menu HP membuka dropdown Cari + Akun + Rak', () => {
    expect(appSrc).toContain('label="Menu"')
    expect(appSrc).toContain('className="sm:hidden"')
    expect(appSrc).toContain('role="menu"')
    expect(appSrc).toContain('aria-label="Menu utama"')
    expect(appSrc).toContain("navigate('/cari')")
    expect(appSrc).toContain('> Cari')
    expect(appSrc).toContain("navigate('/akun')")
    expect(appSrc).toContain('> Akun')
    expect(appSrc).toContain("navigate('/rak')")
    expect(appSrc).toContain('> Rak buku')
    expect(appSrc).toContain('if (e.key === \'Escape\') setMenuOpen(false)')
  })

  it('panel notifikasi dan target 44px tidak berubah', () => {
    expect(appSrc).toContain('aria-expanded={bellOpen}')
    expect(appSrc).toContain('<NotifPanel')
    expect(appSrc).toContain('boundaryRef={bellWrap}')
    expect(appSrc).toContain('grid size-11 place-items-center rounded-full bg-ink-850')
  })
})

describe('Hero audit2: sampul penuh, tidak setengah kosong', () => {
  it('cover full-bleed + scrim 85% berisi judul/tipe/chapter', () => {
    expect(homeSrc).toContain('relative aspect-[4/3] overflow-hidden bg-ink-900')
    expect(homeSrc).not.toContain('aspect-[16/7]')
    expect(homeSrc).not.toContain('max-h-[170px]')
    expect(homeSrc).toContain('className="size-full object-cover"')
    expect(homeSrc).toContain('h-3/4 bg-gradient-to-t from-black/85 via-black/60 to-transparent')
    expect(homeSrc).toContain("const subtitle = [m.tipe?.[0], label ?? m.other?.[0]]")
  })

  it('dots dan autoplay tetap 44px, pintasan ganda hilang', () => {
    expect(homeSrc).toContain('aria-label={`Menuju slide ${i + 1}`}')
    expect(homeSrc).toContain('className="grid size-11 place-items-center rounded-full"')
    expect(homeSrc).not.toContain('ShortcutMenu')
    expect(homeSrc).not.toContain('Pintasan beranda')
    expect(homeSrc).toMatch(/<ContinueReading \/>([\s\S]*?)<BackdropCarousel items=\{featured\} \/>/)
  })
})

describe('Kartu katalog audit2: 2:3, judul rata, favorit di cover', () => {
  it('cover 2:3 + min-h judul + metadata kontras', () => {
    expect(homeSrc).toContain('relative aspect-[2/3] overflow-hidden rounded-xl border border-ink-800 bg-ink-850')
    expect(homeSrc).toContain('line-clamp-2 min-h-[2.6em] font-display text-[12.5px]')
    expect(homeSrc).toContain('text-[11px] leading-snug text-ink-300')
    expect(homeSrc).not.toContain('text-ink-600')
    expect(homeSrc).toContain('referrerPolicy="no-referrer"')
  })

  it('heart 44px di sudut cover dan tidak membuka series', () => {
    expect(homeSrc).toContain('absolute bottom-0 left-0 z-10 bg-transparent text-white')
    expect(heartSrc).toContain('min-h-11 min-w-11')
    expect(heartSrc).toContain('e.preventDefault()')
    expect(heartSrc).toContain('e.stopPropagation()')
    expect(homeSrc).not.toContain('-ml-3 mt-0.5 flex items-center')
  })
})

describe('Search audit2: sheet filter + hasil kompak', () => {
  it('filter type/status/genre/source ada di draggable bottom sheet', () => {
    expect(searchSrc).toContain('useSheetDrag')
    expect(searchSrc).toContain('useSheetPresence')
    expect(searchSrc).toContain('{...drag}')
    expect(searchSrc).toContain('id="panel-filter-cari"')
    expect(searchSrc).toContain('role="dialog"')
    expect(searchSrc).toContain('sheet-panel flex max-h-[88dvh]')
    expect(searchSrc).toContain("filterOpen ? '' : 'sheet-closing'")
    expect(searchSrc).toContain("filterOpen ? 'sheet-backdrop' : 'sheet-backdrop-closing'")
    expect(searchSrc).toContain('aria-label="Filter tipe"')
    expect(searchSrc).toContain('aria-label="Filter status"')
    expect(searchSrc).toContain('aria-label="Filter genre"')
    expect(searchSrc).not.toContain('aria-label="Filter sumber"')
    expect(searchSrc).not.toContain('mt-3 space-y-3 rounded-2xl border border-ink-800 bg-ink-900/60 p-3')
  })

  it('hasil satu kolom 4-6 judul per layar; chip sumber 44px', () => {
    expect(searchSrc).toContain('<ul data-search-results className="flex flex-col gap-2">')
    expect(searchSrc).toContain('<MangaCard manga={m} compact />')
    expect(searchSrc).toContain('min-h-11 min-w-11 shrink-0 touch-manipulation')
    expect(searchSrc).toContain('aspect-[2/3] w-full rounded-xl bg-ink-850')
    expect(searchSrc).not.toContain('grid grid-cols-2 gap-x-3 gap-y-4')
    expect(searchSrc).not.toContain('aspect-[62/82]')
  })
})
