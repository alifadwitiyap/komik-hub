import { useEffect, useMemo, useRef, useState } from 'react'
import { useLocation, useSearchParams } from 'react-router-dom'
import { api, toMangaCard, unifiedApi } from '../api'
import type { Manga, UnifiedGenre } from '../types'
import { Empty } from '../App'
import { MangaCard } from './Home'
import { clearRecent, listRecent, rememberSearch } from '../recentSearches'
import { useUnifiedSearch } from '../hooks/useUnifiedSearch'
import { SOURCES, SORTS, useSortFilter, useSourceFilter } from '../components/SourceSortBar'
import { IconMagnifyingGlass, IconSliders } from '../icons'
import {
  clearSearchReturn,
  readSearchReturn,
  writeSearchReturn,
  type SearchReturnState,
} from '../searchReturn'

/**
 * Cari — satu halaman berisi DUA mode (pengganti Search + Explore):
 *
 *   1. mode CARI (query `q` di URL): hasil dari unifiedApi.search (fallback
 *      legacy kalau unified mati) + tombol halaman.
 *   2. mode EKSPLORASI (tanpa query): feed `popular`, bertambah lewat tombol
 *      "Muat lebih".
 *
 * Kontrak URL: ?q=, ?tipe=, ?status=, ?genre=, ?source=, ?sort=.
 *
 * Interaksi (P1 search-ux):
 * - DI HP: kolom "Cari komik" → SATU tombol Filter → chip filter aktif →
 *   jumlah hasil → kartu. Panel filter (sumber/urutan/tipe/status/genre)
 *   dibuka tombol itu, dengan Terapkan + Reset.
 * - Pencarian judul HANYA jalan saat submit (Enter / tombol Cari). Tidak ada
 *   debounce: tiap ketikan tidak memicu request.
 * - SEMUA filter dijalankan SERVER-SIDE supaya jumlah hasil jujur sama dengan
 *   yang server kembalikan.
 * - Feed hibrida mode eksplorasi: tanpa filter → `popular` (feed lama yang
 *   terbukti); ada filter → `catalogue` (katalog menyaring di server).
 * - Saat kartu dibuka, query+filter+scroll disimpan; tombol "Kembali" di
 *   detail memulihkannya lewat state navigasi (lihat src/searchReturn.ts).
 */

/** Chip tipe (manga_type di MangaOut). */
const TIPE = ['Manga', 'Manhwa', 'Manhua']

/** Chip status (status di MangaOut, case-insensitive). */
const STATUS = ['Ongoing', 'Completed']

/** Chip kata kunci cepat, diturunkan dari nama genre yang tersedia. */
const QUICK_KEYWORDS = 6

/** text-base + min-h-11: cegah auto-zoom iOS saat fokus dan jaga target sentuh 44px. */
const selectBase =
  'min-w-0 flex-1 appearance-none rounded-full border border-ink-300 bg-ink-900 min-h-11 pl-3.5 pr-8 text-base font-medium text-ink-100 focus:border-brand-amber focus:outline-none'

/** Chevron kecil di kanan tiap dropdown (native select tak bisa di-style). */
function SelectChevron() {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 20 20"
      fill="currentColor"
      className="pointer-events-none absolute right-3 top-1/2 size-3.5 -translate-y-1/2 text-ink-500"
    >
      <path
        fillRule="evenodd"
        d="M5.23 7.21a.75.75 0 011.06.02L10 11.17l3.71-3.94a.75.75 0 111.08 1.04l-4.25 4.5a.75.75 0 01-1.08 0l-4.25-4.5a.75.75 0 01.02-1.06z"
        clipRule="evenodd"
      />
    </svg>
  )
}

/** Filter yang benar-benar mengubah hasil (default tidak dihitung aktif). */
type FilterValues = {
  source: string
  sort: string
  tipe: string
  status: string
  genre: string
}

export default function Search() {
  // ---- URL = sumber tunggal mode + filter -------------------------------
  const [params, setParams] = useSearchParams()
  const location = useLocation()
  const query = params.get('q') ?? ''
  const genreSlug = params.get('genre')
  const tipe = params.get('tipe')
  const status = params.get('status')
  const searching = query.trim().length > 0

  // sumber & urutan aktif (dari URL); nilai default dipetakan ke null supaya
  // tidak dikirim server (server memakai default yang sama).
  const srcRaw = useSourceFilter()
  const srtRaw = useSortFilter()
  const src = srcRaw === 'semua' ? null : srcRaw
  const srt = srtRaw === 'terbaru' ? null : srtRaw

  const [input, setInput] = useState(query)
  const [page, setPage] = useState(1)
  const [recent, setRecent] = useState<string[]>(() => listRecent())
  const [filterOpen, setFilterOpen] = useState(false)

  // input mengikuti URL (termasuk navigasi back/forward)
  useEffect(() => setInput(query), [query])

  /**
   * Query atau filter baru selalu mulai dari halaman 1. Reset dilakukan SAAT
   * RENDER (pola "menyesuaikan state saat input berubah"), BUKAN lewat effect
   * terpisah: kalau page direset di effect, render pertama sesudah filter
   * berubah masih membawa page lama sehingga pencarian ter-fire DUA kali
   * (page lama + filter baru, lalu page 1 + filter baru) — dua fan-out ke
   * server per satu aksi filter. React me-render ulang sebelum commit, jadi
   * effect pencarian hanya pernah melihat page 1.
   */
  const searchSig = `${query}\u0000${tipe ?? ''}\u0000${status ?? ''}\u0000${genreSlug ?? ''}\u0000${src ?? ''}\u0000${srt ?? ''}`
  const searchSigRef = useRef(searchSig)
  if (searchSigRef.current !== searchSig) {
    searchSigRef.current = searchSig
    setPage(1)
  }

  // Pulihkan posisi scroll saat kembali dari detail (state navigasi), atau
  // explode URL '/cari?...#p1-scroll-1234' kalau halaman di-refresh.
  // requestAnimationFrame menunggu kartu selesai layout supaya tinggi halaman
  // sudah final sebelum window.scrollTo.
  useEffect(() => {
    const fromHash = /^#p1-scroll-(\d+)$/.exec(location.hash)
    // Hash dipakai HANYA kalau state navigasi tidak ada — kalau tidak, state
    // lama (dari kunjungan detail sebelumnya) kalah prioritas dari hash.
    const fromState = fromHash ? null : readSearchReturn(location.state)
    let scroll: number | null = null
    if (fromState && fromState.query === query && filtersEqual(fromState.filter, cloneFilters(params))) {
      scroll = fromState.scrollY
      clearSearchReturn()
    } else if (fromHash) {
      scroll = Number(fromHash[1])
    }
    if (scroll == null) {
      // Masuk Cari lewat navigasi (bukan Kembali dari detail) → selalu dari atas.
      window.scrollTo(0, 0)
      return
    }
    // Kartu hasil (mode eksplorasi) bisa tiba asynchronously: satu rAF saja
    // sering kelewat sebelum grid selesai layout. Ulangi sekali setelah data
    // sempat dirender.
    const raf = requestAnimationFrame(() => {
      window.scrollTo(0, scroll!)
      window.setTimeout(() => window.scrollTo(0, scroll!), 120)
    })
    return () => cancelAnimationFrame(raf)
    // Hanya saat mount: filter/query di sini dipakai untuk validasi state.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Simpan query+filter+scroll tiap kali kartu diklik (bukan pas unmount:
  // unmount juga jalan saat pindah tab, dan scroll bisa tertimpa layout baru).
  useEffect(() => {
    const root = document.querySelector('[data-search-results]')
    if (!root) return
    const onClick = (e: Event) => {
      const target = e.target
      if (!(target instanceof Element)) return
      const link = target.closest('a[href^="/manga/"]')
      if (!link) return
      writeSearchReturn({
        query,
        filter: cloneFilters(params),
        scrollY: window.scrollY,
        href: link.getAttribute('href') ?? '',
      })
    }
    root.addEventListener('click', onClick)
    return () => root.removeEventListener('click', onClick)
  }, [query, params])

  /**
   * Tulis q ke URL dengan REPLACE (bukan push) supaya history tidak dibanjiri.
   * Form fungsional setSearchParams dipakai supaya param tipe/status/genre
   * yang sudah ada tidak hilang.
   *
   * Dipanggil HANYA oleh submit form (Enter / tombol Cari) dan riwayat — tidak
   * ada efek debounce yang menulis URL saat mengetik.
   */
  const commitQuery = (v: string) => {
    setParams((prev) => {
      const next = new URLSearchParams(prev)
      if (v) next.set('q', v)
      else next.delete('q')
      return next
    }, { replace: true })
    if (v) setRecent(rememberSearch(v))
  }

  // ---- mode cari ---------------------------------------------------------
  /**
   * Seluruh protokol pencarian (termasuk fase 2 dan fallback legacy) tinggal
   * di hook. Halaman tidak perlu tahu ada dua fase.
   */
  const search = useUnifiedSearch(
    query,
    page,
    { tipe, status, genre: genreSlug, source: src, sort: srt },
    searching,
    // Fallback hanya saat TIDAK ada filter: /api/search lama tidak menerima
    // tipe/status/genre/sumber/urutan, jadi memakainya dengan filter aktif
    // akan memalsukan jumlah hasil.
    tipe || status || genreSlug || src || srt
      ? undefined
      : (signal) => api.search(query, page, signal).then((r) => r.manga),
  )
  const results = search.items
  const loading = search.loading
  const error = search.error
  /** total sumber dari server (untuk cakupan genre + chip) */
  const sourcesTotal = search.sourcesTotal
  /** sumber yang gagal pada request terakhir (hanya mode unified). */
  const failedSources = search.failedSources

  // ---- mode eksplorasi ---------------------------------------------------
  const [genres, setGenres] = useState<UnifiedGenre[]>([])
  const [items, setItems] = useState<Manga[]>([])
  const [listPage, setListPage] = useState(1)
  const [more, setMore] = useState(false)
  const [hasMore, setHasMore] = useState(false)
  const [listLoading, setListLoading] = useState(true)
  const [listError, setListError] = useState<string | null>(null)
  const [listFailed, setListFailed] = useState(0)
  /** total sumber dari server untuk chip mode eksplorasi (0 = belum dilaporkan) */
  const [listSourcesTotal, setListSourcesTotal] = useState(0)
  const [listReloadKey, setListReloadKey] = useState(0)
  /** handle yang sudah masuk daftar — cegah duplikat lintas halaman. */
  const seen = useRef<Set<string>>(new Set())
  /** filter aktif → feed pindah ke katalog (bukan populer). Termasuk
   *  sumber/urutan pilihan user (dulu diabaikan: klik sort tidak mengubah
   *  gambar karena tetap mengambil feed popular yang sama). */
  const filtered = Boolean(tipe || status || genreSlug || src || srt)
  const filterArg = { tipe, status, genre: genreSlug, source: src, sort: srt }

  // Union genre semua sumber. Gagal → dropdown genre kosong, halaman tetap
  // jalan (mode "Semua").
  useEffect(() => {
    const ctrl = new AbortController()
    unifiedApi
      .genres(ctrl.signal)
      .then((r) => setGenres(r.items))
      .catch(() => setGenres([]))
    return () => ctrl.abort()
  }, [])

  // Daftar: TANPA filter → popular digabung 4 sumber server (feed lama yang
  // terbukti). ADA filter tipe/status/genre → catalogue yang menyaring di
  // server. Halaman 1 dimuat SEKALI saat masuk mode eksplorasi (dan setiap
  // filter berubah); "Muat lebih" menambah halaman berikutnya.
  useEffect(() => {
    if (searching) return
    const ctrl = new AbortController()
    setListLoading(true)
    setListError(null)
    setListFailed(0)
    seen.current = new Set()
    setListPage(1)
    const feed = filtered
      ? unifiedApi.catalogue(1, ctrl.signal, filterArg)
      : unifiedApi.popular(1, ctrl.signal)
    feed
      .then((r) => {
        const mapped = r.items.map(toMangaCard).filter((m) => {
          if (seen.current.has(String(m.id))) return false
          seen.current.add(String(m.id))
          return true
        })
        setItems(mapped)
        setHasMore(mapped.length > 0)
        setListFailed(r.failed_sources?.length ?? 0)
        setListSourcesTotal(
          r.sources_total ?? (r.sources_ok ?? 0) + (r.failed_sources?.length ?? 0),
        )
        setListLoading(false)
      })
      .catch((e: unknown) => {
        if (e instanceof Error && e.name === 'AbortError') return
        console.error('[search] list failed', e)
        setListError('Terjadi kendala saat memuat daftar. Coba lagi.')
        setListLoading(false)
      })
    return () => ctrl.abort()
    // filterArg sengaja tidak jadi dependensi: nilainya sudah terwakili oleh
    // tipe/status/genreSlug/src/srt di bawah (objek baru tiap render akan loop).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searching, filtered, tipe, status, genreSlug, src, srt, listReloadKey])

  // "Muat lebih" menambah halaman berikutnya (append + dedup).
  const loadMore = () => {
    if (more || !hasMore || listLoading) return
    setMore(true)
    const feed = filtered
      ? unifiedApi.catalogue(listPage + 1, undefined, filterArg)
      : unifiedApi.popular(listPage + 1)
    feed
      .then((r) => {
        const mapped = r.items.map(toMangaCard).filter((m) => {
          if (seen.current.has(String(m.id))) return false
          seen.current.add(String(m.id))
          return true
        })
        setItems((prev) => [...prev, ...mapped])
        setListPage((p) => p + 1)
        setHasMore(mapped.length > 0)
        setMore(false)
      })
      .catch(() => setMore(false))
  }

  // ---- filter ------------------------------------------------------------
  // Satu setFilter: tulis ke query string (single source of truth filter).
  const setFilter = (key: string, value: string | null) => {
    const next = new URLSearchParams(params)
    if (value) next.set(key, value)
    else next.delete(key)
    setParams(next)
  }

  /** Reset filter tanpa mengubah query (dipakai tombol Reset di panel & empty). */
  const resetFilters = () => {
    setParams((prev) => {
      const next = new URLSearchParams(prev)
      for (const key of ['source', 'sort', 'tipe', 'status', 'genre']) next.delete(key)
      return next
    })
    setFilterOpen(false)
  }

  // ---- genre (FILTER AKTIF, dikirim ke server) ---------------------------
  // Union mentah punya duplikat NAMA ("Fighting" muncul dua kali karena beda
  // slug) — dropdown mengunci ke nama dan sumber digabung. Varian yang memang
  // beda nama ("Demon" vs "Demons") sengaja tetap terpisah.
  const genreList = useMemo(() => {
    const byName = new Map<string, UnifiedGenre>()
    for (const g of genres) {
      const key = g.name.trim().toLowerCase()
      if (!key) continue
      const cur = byName.get(key)
      if (!cur) {
        byName.set(key, { ...g, sources: [...g.sources] })
        continue
      }
      const sources = [...new Set([...cur.sources, ...g.sources])]
      // slug pemegang = yang paling banyak sumber (entri paling lengkap)
      byName.set(
        key,
        sources.length > cur.sources.length ? { ...g, sources } : { ...cur, sources },
      )
    }
    return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name))
  }, [genres])

  // Kata kunci cepat diturunkan dari nama genre yang tersedia (bukan judul
  // hardcode) supaya tetap relevan dengan isi katalog.
  const quickKeywords = genreList.slice(0, QUICK_KEYWORDS).map((g) => g.name)
  const activeGenre = genreList.find((g) => g.slug === genreSlug)
  const filterSuffix = [
    tipe ? ` · ${tipe}` : '',
    status ? ` · ${status}` : '',
    activeGenre ? ` · ${activeGenre.name}` : '',
  ].join('')

  const defaults: FilterValues = { source: 'semua', sort: 'terbaru', tipe: '', status: '', genre: '' }
  const activeFilters: FilterValues = {
    source: srcRaw,
    sort: srtRaw,
    tipe: tipe ?? '',
    status: status ?? '',
    genre: genreSlug ?? '',
  }
  const [draft, setDraft] = useState<FilterValues>(activeFilters)

  /** Buka panel dari nilai URL terkini (bukan draft lama yang sudah diterapkan). */
  const openFilter = () => {
    setDraft(activeFilters)
    setFilterOpen((v) => !v)
  }

  /** Terapkan semua field sekaligus — satu aksi = satu request. */
  const applyFilters = () => {
    setParams((prev) => {
      const next = new URLSearchParams(prev)
      for (const [key, value] of Object.entries(draft)) {
        const isDefault =
          (key === 'source' && value === 'semua') || (key === 'sort' && value === 'terbaru')
        if (!value || isDefault) next.delete(key)
        else next.set(key, value)
      }
      return next
    })
    setFilterOpen(false)
  }

  const activeChips = useMemo(() => {
    const chips: { key: keyof FilterValues; label: string }[] = []
    if (srcRaw !== 'semua') {
      chips.push({
        key: 'source',
        label: `Sumber: ${SOURCES.find((s) => s.id === srcRaw)?.label ?? srcRaw}`,
      })
    }
    if (srtRaw !== 'terbaru') {
      chips.push({
        key: 'sort',
        label: `Urutan: ${SORTS.find((s) => s.value === srtRaw)?.label ?? srtRaw}`,
      })
    }
    if (tipe) chips.push({ key: 'tipe', label: `Tipe: ${tipe}` })
    if (status) chips.push({ key: 'status', label: `Status: ${status}` })
    if (genreSlug) chips.push({ key: 'genre', label: `Genre: ${activeGenre?.name ?? genreSlug}` })
    return chips
  }, [srcRaw, srtRaw, tipe, status, genreSlug, activeGenre])

  return (
    <div className="mx-auto max-w-3xl px-4 py-5">
      <h1 className="mb-3 text-lg font-semibold">Cari manga</h1>

      <form
        onSubmit={(e) => {
          e.preventDefault()
          commitQuery(input.trim())
        }}
        className="flex gap-2"
      >
        <div className="relative flex min-w-0 flex-1 items-center">
          <IconMagnifyingGlass className="pointer-events-none absolute left-3.5 size-4 text-ink-500" />
          {/* text-base (16px): di bawah 16px iOS Safari auto-zoom saat input difokuskan. */}
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="Judul, mis. Solo Leveling"
            inputMode="search"
            enterKeyHint="search"
            aria-label="Cari komik"
            className="min-h-11 min-w-0 flex-1 rounded-full border border-ink-300 bg-ink-900 py-2.5 pl-10 pr-10 text-base text-ink-100 placeholder:text-ink-500 focus:border-brand-amber focus:outline-none"
          />
          {input && (
            <button
              type="button"
              aria-label="Hapus teks"
              onClick={() => setInput('')}
              className="absolute right-2 min-h-11 min-w-11 rounded-full text-ink-500 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-amber active:text-ink-300"
            >
              ×
            </button>
          )}
        </div>
        <button
          type="submit"
          className="shrink-0 min-h-11 rounded-full bg-brand-amber px-5 py-2.5 text-sm font-bold text-white transition-colors active:bg-brand-amber/80 active:scale-[0.97] touch-manipulation focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-amber focus-visible:ring-offset-2 [@media(hover:hover)]:hover:bg-brand-amber-soft"
        >
          Cari
        </button>
      </form>

      {/* Dua kontrol utama tampil di awal: Filter dan Urutkan. Sumber/tipe/
          status/genre masuk panel; Urutkan bisa diubah langsung tanpa panel. */}
      <div className="mt-3 flex gap-2">
        <button
          type="button"
          aria-expanded={filterOpen}
          aria-controls="panel-filter-cari"
          onClick={openFilter}
          className={`inline-flex min-h-11 flex-1 touch-manipulation items-center justify-center gap-2 rounded-full px-4 py-2 text-[13px] font-bold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-amber focus-visible:ring-offset-2 active:scale-[0.97] ${
            filterOpen || activeChips.length > 0
              ? 'bg-brand-amber text-white'
              : 'border border-ink-700 bg-ink-900 text-ink-300'
          }`}
        >
          <IconSliders className="size-3.5" />
          Filter{activeChips.length > 0 ? ` (${activeChips.length})` : ''}
        </button>
        <div className="relative flex min-h-11 min-w-0 flex-1 items-center">
          <select
            aria-label="Urutkan hasil"
            value={srt ?? 'terbaru'}
            onChange={(e) => setFilter('sort', e.target.value)}
            className="min-h-11 w-full appearance-none rounded-full border border-ink-700 bg-ink-900 py-2 pl-4 pr-9 text-[13px] font-semibold text-ink-300 focus:border-brand-amber focus:outline-none"
          >
            {SORTS.map((s) => (
              <option key={s.value} value={s.value}>{s.label}</option>
            ))}
          </select>
          <SelectChevron />
        </div>
      </div>

      {filterOpen && (
        <div
          id="panel-filter-cari"
          className="mt-3 space-y-3 rounded-2xl border border-ink-800 bg-ink-900/60 p-3"
        >
          <fieldset>
            <legend className="mb-1.5 text-[11.5px] font-bold text-ink-400">Sumber</legend>
            <div className="flex flex-wrap gap-2" role="group" aria-label="Filter sumber">
              {SOURCES.map((s) => (
                <button
                  key={s.id}
                  type="button"
                  aria-pressed={draft.source === s.id}
                  onClick={() => setDraft((d) => ({ ...d, source: s.id }))}
                  className={`min-h-11 touch-manipulation rounded-full px-3 py-1.5 text-[13px] font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-amber ${
                    draft.source === s.id
                      ? 'bg-brand-amber text-white'
                      : 'border border-ink-800 text-ink-300 active:border-brand-amber'
                  }`}
                >
                  {s.label}
                </button>
              ))}
            </div>
          </fieldset>

          <div className="grid grid-cols-2 gap-2">
            <div className="relative flex min-w-0">
              <select
                aria-label="Filter tipe"
                value={draft.tipe}
                onChange={(e) => setDraft((d) => ({ ...d, tipe: e.target.value }))}
                className={selectBase}
              >
                <option value="">Semua tipe</option>
                {TIPE.map((t) => (
                  <option key={t} value={t}>
                    {t}
                  </option>
                ))}
              </select>
              <SelectChevron />
            </div>
            <div className="relative flex min-w-0">
              <select
                aria-label="Filter status"
                value={draft.status}
                onChange={(e) => setDraft((d) => ({ ...d, status: e.target.value }))}
                className={selectBase}
              >
                <option value="">Semua status</option>
                {STATUS.map((s) => (
                  <option key={s} value={s}>
                    {s}
                  </option>
                ))}
              </select>
              <SelectChevron />
            </div>
            <div className="relative flex min-w-0">
              <select
                aria-label="Filter genre"
                value={draft.genre}
                onChange={(e) => setDraft((d) => ({ ...d, genre: e.target.value }))}
                className={selectBase}
              >
                <option value="">Semua genre</option>
                {genreList.map((g) => (
                  <option key={g.slug} value={g.slug}>
                    {g.name}
                    {sourcesTotal > 0 && g.sources.length < sourcesTotal
                      ? ` (${g.sources.length}/${sourcesTotal})`
                      : ''}
                  </option>
                ))}
              </select>
              <SelectChevron />
            </div>
          </div>

          <div className="flex gap-2">
            <button
              type="button"
              onClick={applyFilters}
              className="min-h-11 flex-1 rounded-full bg-brand-amber px-5 py-2.5 text-[13px] font-bold text-white transition-colors active:scale-[0.97] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-amber focus-visible:ring-offset-2"
            >
              Terapkan
            </button>
            <button
              type="button"
              onClick={() => setDraft(defaults)}
              className="min-h-11 flex-1 rounded-full border border-ink-700 px-5 py-2.5 text-[13px] font-semibold text-ink-300 transition-colors active:scale-[0.97] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-amber focus-visible:ring-offset-2"
            >
              Reset
            </button>
          </div>
        </div>
      )}

      {/* Chip filter aktif — sebelum jumlah hasil (urutan HP P1). Tiap chip
          bisa dilepas tanpa membuka panel. */}
      {activeChips.length > 0 && (
        <div data-active-filters className="mt-3 flex flex-wrap gap-2">
          {activeChips.map((chip) => (
            <button
              key={chip.key}
              type="button"
              aria-label={`Hapus ${chip.label}`}
              onClick={() => setFilter(chip.key, null)}
              className="min-h-11 rounded-full border border-brand-amber/40 bg-brand-amber/10 px-3 py-1.5 text-[12px] font-semibold text-brand-amber transition-colors active:scale-[0.97] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-amber"
            >
              {chip.label} ×
            </button>
          ))}
        </div>
      )}

      {genreSlug && activeGenre && (
        <p className="mt-2 text-[11.5px] text-ink-500">
          Genre <b className="text-ink-300">{activeGenre.name}</b> menyaring hasil
          dari {activeGenre.sources.length} sumber
          {sourcesTotal > 0 && activeGenre.sources.length < sourcesTotal
            ? ` dari ${sourcesTotal} sumber yang tersedia`
            : ''}
          .
        </p>
      )}

      {/* Riwayat pencarian + kata kunci cepat (diturunkan dari nama genre) —
          tampil saat kolom kosong. */}
      {!searching && (
        <div data-recent-searches className="mt-3">
          {recent.length > 0 && (
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-[11.5px] text-ink-500">Terakhir dicari</span>
              {recent.map((r) => (
                <button
                  key={r}
                  type="button"
                  onClick={() => commitQuery(r)}
                  className="min-h-11 shrink-0 rounded-full border border-ink-800 bg-ink-900 px-3 py-1.5 text-[12px] font-medium text-ink-300 transition-colors [@media(hover:hover)]:hover:border-ink-700"
                >
                  {r}
                </button>
              ))}
              <button
                type="button"
                aria-label="Hapus riwayat pencarian"
                onClick={() => setRecent(clearRecent())}
                className="min-h-11 shrink-0 rounded-full border border-ink-800 px-3 py-1.5 text-[12px] font-medium text-ink-500 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-amber [@media(hover:hover)]:hover:border-ink-700 [@media(hover:hover)]:hover:text-ink-300"
              >
                Hapus riwayat
              </button>
            </div>
          )}
          {quickKeywords.length > 0 && (
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <span className="text-[11.5px] text-ink-500">Coba cari</span>
              {quickKeywords.map((k) => (
                <button
                  key={k}
                  type="button"
                  onClick={() => commitQuery(k)}
                  className="min-h-11 shrink-0 rounded-full border border-ink-800 bg-ink-900 px-3 py-1.5 text-[12px] font-medium text-ink-300 transition-colors [@media(hover:hover)]:hover:border-ink-700"
                >
                  {k}
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      {searching ? (
        <div className="mt-5">
          {loading && <SkeletonCards />}
          {/* lane5_microcopy.md:80 (High) — "Pencarian gagal — coba lagi." tanpa error mentah. */}
          {error && (
            <div className="mx-auto max-w-3xl px-4 py-16 text-center">
              <Empty title="Pencarian gagal" body="Coba lagi." />
              <button
                type="button"
                onClick={() => search.refresh()}
                className="mt-4 min-h-11 rounded-full bg-brand-amber px-5 py-2.5 text-[13px] font-bold text-white transition-colors active:scale-[0.97] active:duration-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-amber focus-visible:ring-offset-2 [@media(hover:hover)]:hover:bg-brand-amber-soft"
              >
                Coba lagi
              </button>
            </div>
          )}
          {!loading && !error && (
            <>
              <div className="mb-2 flex flex-wrap items-center gap-2">
                <p data-search-count className="text-[12px] text-ink-500">
                  {results.length} hasil untuk “{query}”{filterSuffix}
                  {sourcesTotal > 1 ? ` · dari ${sourcesTotal} sumber` : ''}
                </p>
                {search.completing && (
                  <span
                    data-search-completing
                    role="status"
                    aria-live="polite"
                    className="inline-flex items-center gap-1 rounded-full bg-ink-500/10 px-2 py-0.5 text-[11px] text-ink-400"
                  >
                    <span className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-ink-400" />
                    Masih mencari di sumber lain
                  </span>
                )}
                {failedSources > 0 && (
                  <FailedSourceChip count={failedSources} total={search.sourcesTotal} />
                )}
              </div>
              {results.length === 0 ? (
                <div className="mx-auto max-w-3xl px-4 py-16 text-center">
                  <Empty
                    title="Tidak ada hasil"
                    body={`Tidak menemukan apa pun untuk “${query}”.`}
                  />
                  <div className="mt-4 flex flex-wrap justify-center gap-2">
                    <button
                      type="button"
                      onClick={() => commitQuery('')}
                      className="min-h-11 rounded-full border border-ink-700 px-5 py-2.5 text-[13px] font-semibold text-ink-300 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-amber focus-visible:ring-offset-2 [@media(hover:hover)]:hover:border-brand-amber [@media(hover:hover)]:hover:text-brand-amber"
                    >
                      Bersihkan pencarian
                    </button>
                    {filtered && (
                      <button
                        type="button"
                        onClick={resetFilters}
                        className="min-h-11 rounded-full bg-brand-amber px-5 py-2.5 text-[13px] font-bold text-white transition-colors active:scale-[0.97] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-amber focus-visible:ring-offset-2"
                      >
                        Reset filter
                      </button>
                    )}
                  </div>
                </div>
              ) : (
                <ResultGrid items={results} />
              )}

              {results.length > 0 && (
                <div className="mt-5 flex items-center justify-between">
                  <button
                    disabled={page <= 1}
                    onClick={() => setPage((p) => Math.max(1, p - 1))}
                    className="min-h-11 min-w-11 rounded-lg border border-ink-700 px-3.5 py-2 text-[13px] font-medium text-ink-300 transition-colors active:scale-[0.97] active:bg-ink-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-amber disabled:opacity-40"
                  >
                    Sebelumnya
                  </button>
                  <span className="text-[12px] text-ink-500">Halaman {page}</span>
                  <button
                    disabled={!search.hasMore}
                    onClick={() => setPage((p) => p + 1)}
                    className="min-h-11 min-w-11 rounded-lg border border-ink-700 px-3.5 py-2 text-[13px] font-medium text-ink-300 transition-colors active:scale-[0.97] active:bg-ink-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-amber disabled:opacity-40"
                  >
                    Berikutnya
                  </button>
                </div>
              )}
            </>
          )}
        </div>
      ) : (
        <div className="mt-5">
          {listLoading && <SkeletonCards />}
          {/* lane5_microcopy.md:81 (High) — "Gagal memuat daftar — coba lagi." tanpa error mentah. */}
          {listError && (
            <div className="mx-auto max-w-3xl px-4 py-16 text-center">
              <Empty title="Gagal memuat daftar" body="Coba lagi." />
              <button
                type="button"
                onClick={() => setListReloadKey((k) => k + 1)}
                className="mt-4 min-h-11 rounded-full bg-brand-amber px-5 py-2.5 text-[13px] font-bold text-white transition-colors active:scale-[0.97] active:duration-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-amber focus-visible:ring-offset-2 [@media(hover:hover)]:hover:bg-brand-amber-soft"
              >
                Coba lagi
              </button>
            </div>
          )}
          {!listLoading && !listError && (
            <>
              <div className="mb-2 flex flex-wrap items-center gap-2">
                <p className="text-[12px] text-ink-500" data-search-count>
                  {items.length} komik{filterSuffix}
                  {listSourcesTotal > 1 ? ` · dari ${listSourcesTotal} sumber` : ''}
                </p>
                {listFailed > 0 && <FailedSourceChip count={listFailed} total={listSourcesTotal} />}
              </div>
              {items.length === 0 ? (
                <div className="mx-auto max-w-3xl px-4 py-16 text-center">
                  <Empty
                    title="Tidak ada hasil"
                    body="Belum ada komik yang cocok dengan filter ini."
                  />
                  {filtered && (
                    <button
                      type="button"
                      onClick={resetFilters}
                      className="mt-4 min-h-11 rounded-full bg-brand-amber px-5 py-2.5 text-[13px] font-bold text-white transition-colors active:scale-[0.97] active:duration-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-amber focus-visible:ring-offset-2"
                    >
                      Reset filter
                    </button>
                  )}
                </div>
              ) : (
                <ResultGrid items={items} />
              )}

              {hasMore && items.length > 0 && (
                <div className="mt-5 flex justify-center">
                  <button
                    disabled={more}
                    onClick={loadMore}
                    className="min-h-11 rounded-full border border-ink-700 px-5 py-2.5 text-[13px] font-medium text-ink-300 transition-colors active:scale-[0.97] active:duration-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-amber focus-visible:ring-offset-2 [@media(hover:hover)]:hover:border-brand-amber [@media(hover:hover)]:hover:text-brand-amber disabled:opacity-40"
                  >
                    {more ? 'Memuat…' : 'Muat lebih'}
                  </button>
                </div>
              )}
            </>
          )}
        </div>
      )}
    </div>
  )
}

/** Salin filter aktif dari URL ke bentuk nilai panel (tanpa referensi params). */
function cloneFilters(params: URLSearchParams): SearchReturnState['filter'] {
  return {
    source: params.get('source') ?? 'semua',
    sort: params.get('sort') ?? 'terbaru',
    tipe: params.get('tipe') ?? '',
    status: params.get('status') ?? '',
    genre: params.get('genre') ?? '',
  }
}

/** Bandingkan filter state navigasi dengan filter URL terkini. */
function filtersEqual(a: SearchReturnState['filter'], b: SearchReturnState['filter']): boolean {
  return (
    a.source === b.source &&
    a.sort === b.sort &&
    a.tipe === b.tipe &&
    a.status === b.status &&
    a.genre === b.genre
  )
}

/**
 * Grid 2 kolom kartu (kedua mode). MangaCard dipakai apa adanya — kelas
 * `[&_a]:w-full` menimpa lebar tetap kartu (132px) supaya mengisi kolom;
 * selector turunan lebih spesifik daripada `.w-[132px]`, jadi urutan CSS
 * tidak menentukan hasil.
 */
function ResultGrid({ items }: { items: Manga[] }) {
  return (
    <ul data-search-results className="grid grid-cols-2 gap-x-3 gap-y-4">
      {items.map((m) => (
        <li key={m.id} className="[&_a]:w-full">
          <MangaCard manga={withChapterLabel(m)} />
        </li>
      ))}
    </ul>
  )
}

/**
 * MangaCard (Home.tsx, milik subagent lain) menampilkan `other[0]` apa adanya.
 * Di sini nomor chapter terakhir diberi label "Terbaru · Ch. …" sebelum kartu
 * dirender — salinan objek, data asli tidak diubah.
 */
function withChapterLabel(m: Manga): Manga {
  const first = m.other?.[0]
  if (typeof first !== 'string') return m
  const number = first.trim().replace(/^Chapter\s+/i, '')
  if (!/^\d+(?:[.,]\d+)?$/.test(number)) return m
  return { ...m, other: [`Terbaru · Ch. ${number}`, ...(m.other?.slice(1) ?? [])] }
}

/** Kartu skeleton pemuatan (mode cari + eksplorasi): grid 2 kolom + aspect
 *  sama seperti kartu asli (62/82) supaya daftar tidak melompat saat data
 *  tiba. */
function SkeletonCards() {
  return (
    <ul className="grid grid-cols-2 gap-x-3 gap-y-4" aria-hidden="true">
      {Array.from({ length: 6 }).map((_, i) => (
        <li key={i} className="aspect-[62/82] animate-pulse rounded-xl bg-ink-850" />
      ))}
    </ul>
  )
}

/**
 * Chip ringkas sumber yang gagal — pengganti banner "⚠ n/4 sumber gagal
 * dimuat". Warna & bentuknya meniru pill kesehatan sumber di TopBar supaya
 * bahasa visualnya sama.
 */
function FailedSourceChip({ count, total }: { count: number; total: number }) {
  // `total` datang dari server (`sources_total`), bukan konstanta di web:
  // tambah sumber ke-5 di Rust dan chip ini tetap benar tanpa disentuh.
  const label = total > 0 ? `${count} dari ${total} sumber gagal` : `${count} sumber gagal`
  return (
    <span
      data-source-failed
      role="status"
      aria-label={label}
      title={label}
      className="inline-flex items-center gap-1 rounded-full bg-warn/12 px-2 py-0.5 text-[11px] font-bold text-warn ring-1 ring-warn/30"
    >
      <span aria-hidden="true">⚠</span>
      {total > 0 ? `${count}/${total}` : count} sumber gagal
    </span>
  )
}
