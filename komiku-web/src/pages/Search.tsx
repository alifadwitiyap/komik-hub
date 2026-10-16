import { useEffect, useMemo, useRef, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { api, toMangaCard, unifiedApi } from '../api'
import type { Manga, UnifiedGenre } from '../types'
import { Empty, Spinner } from '../App'
import { MangaCard } from './Home'
import { clearRecent, listRecent, rememberSearch } from '../recentSearches'
import { IconMagnifyingGlass } from '../icons'

/**
 * Cari — satu halaman berisi DUA mode (pengganti Search + Explore):
 *
 *   1. mode CARI (query `q` di URL): hasil dari unifiedApi.search (fallback
 *      legacy kalau unified mati) + tombol halaman.
 *   2. mode EKSPLORASI (tanpa query): feed `popular`, bertambah lewat tombol
 *      "Muat lebih".
 *
 * Kontrak URL: ?q=, ?tipe=, ?status=, ?genre=.
 *
 * Interaksi:
 * - Pencarian judul HANYA jalan saat submit (Enter / tombol Cari). Tidak ada
 *   debounce: tiap ketikan tidak memicu request.
 * - Filter memakai TIGA DROPDOWN (Tipe | Status | Genre) — bukan baris chip
 *   yang memakan beberapa baris. Perubahan filter langsung berlaku (satu aksi
 *   eksplisit = satu request).
 * - SEMUA filter (termasuk genre) dijalankan SERVER-SIDE supaya jumlah hasil
 *   jujur sama dengan yang server kembalikan.
 * - Feed hibrida mode eksplorasi: tanpa filter → `popular` (feed lama yang
 *   terbukti); ada filter → `catalogue` (katalog menyaring di server).
 */

/** Jumlah sumber yang digabung server (untuk chip "n/4 sumber gagal"). */
const TOTAL_SOURCES = 4

/** Chip tipe (manga_type di MangaOut). */
const TIPE = ['Manga', 'Manhwa', 'Manhua']

/** Chip status (status di MangaOut, case-insensitive). */
const STATUS = ['Ongoing', 'Completed']

/** Chip kata kunci cepat, diturunkan dari nama genre yang tersedia. */
const QUICK_KEYWORDS = 6

const selectBase =
  'min-w-0 flex-1 appearance-none rounded-full border border-ink-300 bg-ink-900 py-2 pl-3.5 pr-8 text-[12.5px] font-medium text-ink-100 focus:border-brand-amber focus:outline-none'

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

export default function Search() {
  // ---- URL = sumber tunggal mode + filter -------------------------------
  const [params, setParams] = useSearchParams()
  const query = params.get('q') ?? ''
  const genreSlug = params.get('genre')
  const tipe = params.get('tipe')
  const status = params.get('status')
  const searching = query.trim().length > 0

  const [input, setInput] = useState(query)
  const [page, setPage] = useState(1)
  const [recent, setRecent] = useState<string[]>(() => listRecent())

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
  const searchSig = `${query}\u0000${tipe ?? ''}\u0000${status ?? ''}\u0000${genreSlug ?? ''}`
  const searchSigRef = useRef(searchSig)
  if (searchSigRef.current !== searchSig) {
    searchSigRef.current = searchSig
    setPage(1)
  }

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
  const [results, setResults] = useState<Manga[]>([])
  // mulai true: tanpa ini render pertama (sebelum effect jalan) memicu
  // kedipan "Tidak ada hasil" sebelum pencarian sungguh dijalankan.
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  /** sumber yang gagal pada request terakhir (hanya mode unified). */
  const [failedSources, setFailedSources] = useState(0)

  useEffect(() => {
    if (!searching) return
    const ctrl = new AbortController()
    setLoading(true)
    setError(null)
    setFailedSources(0)
    unifiedApi
      // tipe/status/genre dikirim ke server: hasil & jumlahnya dari feed
      // yang sudah difilter, bukan chip yang menyaring sisa halaman.
      .search(query, page, ctrl.signal, { tipe, status, genre: genreSlug })
      .then((r) => {
        setResults(r.items.map(toMangaCard))
        setFailedSources(r.failed_sources?.length ?? 0)
        setLoading(false)
      })
      // Fallback ke flow Komiku lama kalau unified mati total (route belum
      // dikompilasi di server, 5xx, jaringan) — pencarian tetap berfungsi.
      // Hanya dipakai saat TIDAK ada filter: /api/search lama tidak menerima
      // tipe/status/genre, jadi memakainya dengan filter aktif akan
      // memalsukan jumlah hasil.
      .catch((e: Error) => {
        if (e.name === 'AbortError') return
        if (tipe || status || genreSlug) {
          setError('Filter butuh layanan gabungan (belum siap).')
          setLoading(false)
          return
        }
        api
          .search(query, page, ctrl.signal)
          .then((r) => setResults(r.manga))
          .catch((e2: Error) => e2.name !== 'AbortError' && setError(e2.message))
          .finally(() => setLoading(false))
      })
    return () => ctrl.abort()
  }, [query, page, searching, tipe, status, genreSlug])

  // ---- mode eksplorasi ---------------------------------------------------
  const [genres, setGenres] = useState<UnifiedGenre[]>([])
  const [items, setItems] = useState<Manga[]>([])
  const [listPage, setListPage] = useState(1)
  const [more, setMore] = useState(false)
  const [hasMore, setHasMore] = useState(false)
  const [listLoading, setListLoading] = useState(true)
  const [listError, setListError] = useState<string | null>(null)
  const [listFailed, setListFailed] = useState(0)
  /** handle yang sudah masuk daftar — cegah duplikat lintas halaman. */
  const seen = useRef<Set<string>>(new Set())
  /** filter aktif → feed pindah ke katalog (bukan populer). */
  const filtered = Boolean(tipe || status || genreSlug)
  const filterArg = { tipe, status, genre: genreSlug }

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
        setListLoading(false)
      })
      .catch((e: Error) => {
        if (e.name !== 'AbortError') {
          setListError(e.message)
          setListLoading(false)
        }
      })
    return () => ctrl.abort()
    // filterArg sengaja tidak jadi dependensi: nilainya sudah terwakili oleh
    // tipe/status/genreSlug di bawah (objek baru tiap render akan loop).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searching, filtered, tipe, status, genreSlug])

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
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="Judul, mis. solo leveling"
            inputMode="search"
            enterKeyHint="search"
            aria-label="Cari manga"
            className="min-w-0 flex-1 rounded-full border border-ink-300 bg-ink-900 py-2.5 pl-10 pr-3.5 text-sm text-ink-100 placeholder:text-ink-500 focus:border-brand-amber focus:outline-none"
          />
        </div>
        <button
          type="submit"
          className="shrink-0 rounded-full bg-brand-amber px-5 py-2.5 text-sm font-bold text-white transition-colors hover:bg-brand-amber-soft"
        >
          Cari
        </button>
      </form>

      {/* Tiga dropdown filter — menggantikan baris chip yang memakan 3 baris. */}
      <div className="mt-3 flex flex-wrap gap-2">
        <div className="relative min-w-0 flex-1">
          <select
            aria-label="Filter tipe"
            value={tipe ?? ''}
            onChange={(e) => setFilter('tipe', e.target.value || null)}
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
        <div className="relative min-w-0 flex-1">
          <select
            aria-label="Filter status"
            value={status ?? ''}
            onChange={(e) => setFilter('status', e.target.value || null)}
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
        <div className="relative min-w-0 flex-1">
          <select
            aria-label="Filter genre"
            value={genreSlug ?? ''}
            onChange={(e) => setFilter('genre', e.target.value || null)}
            className={selectBase}
          >
            <option value="">Semua genre</option>
            {genreList.map((g) => (
              <option key={g.slug} value={g.slug}>
                {g.name}
                {g.sources.length < TOTAL_SOURCES
                  ? ` (${g.sources.length}/${TOTAL_SOURCES})`
                  : ''}
              </option>
            ))}
          </select>
          <SelectChevron />
        </div>
      </div>

      {genreSlug && activeGenre && (
        <p className="mt-2 text-[11.5px] text-ink-500">
          Genre <b className="text-ink-300">{activeGenre.name}</b> menyaring hasil
          dari {activeGenre.sources.length} sumber.
        </p>
      )}

      {/* Riwayat pencarian + kata kunci cepat (diturunkan dari nama genre). */}
      <div data-recent-searches className="mt-3">
        {recent.length > 0 && (
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-[11.5px] text-ink-500">Terakhir dicari</span>
            {recent.map((r) => (
              <button
                key={r}
                type="button"
                onClick={() => commitQuery(r)}
                className="shrink-0 rounded-full border border-ink-800 bg-ink-900 px-3 py-1.5 text-[12px] font-medium text-ink-300 transition-colors hover:border-ink-700"
              >
                {r}
              </button>
            ))}
            <button
              type="button"
              aria-label="Hapus riwayat pencarian"
              onClick={() => setRecent(clearRecent())}
              className="shrink-0 rounded-full border border-ink-800 px-3 py-1.5 text-[12px] font-medium text-ink-500 transition-colors hover:border-ink-700 hover:text-ink-300"
            >
              Hapus
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
                className="shrink-0 rounded-full border border-ink-800 bg-ink-900 px-3 py-1.5 text-[12px] font-medium text-ink-300 transition-colors hover:border-ink-700"
              >
                {k}
              </button>
            ))}
          </div>
        )}
      </div>

      {searching ? (
        <div className="mt-5">
          {loading && <Spinner label="Mencari…" />}
          {error && <Empty title="Pencarian gagal" body={error} />}
          {!loading && !error && (
            <>
              <div className="mb-2 flex flex-wrap items-center gap-2">
                <p data-search-count className="text-[12px] text-ink-500">
                  {results.length} hasil untuk “{query}”{filterSuffix}
                </p>
                {failedSources > 0 && <FailedSourceChip count={failedSources} />}
              </div>
              {results.length === 0 ? (
                <Empty
                  title="Tidak ada hasil"
                  body={`Tidak menemukan apa pun untuk “${query}”.`}
                />
              ) : (
                <ResultGrid items={results} />
              )}

              {results.length > 0 && (
                <div className="mt-5 flex items-center justify-between">
                  <button
                    disabled={page <= 1}
                    onClick={() => setPage((p) => Math.max(1, p - 1))}
                    className="rounded-lg border border-ink-700 px-3.5 py-2 text-[13px] font-medium text-ink-300 disabled:opacity-40"
                  >
                    Sebelumnya
                  </button>
                  <span className="text-[12px] text-ink-500">Halaman {page}</span>
                  <button
                    disabled={results.length < 20}
                    onClick={() => setPage((p) => p + 1)}
                    className="rounded-lg border border-ink-700 px-3.5 py-2 text-[13px] font-medium text-ink-300 disabled:opacity-40"
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
          {listLoading && <Spinner label="Memuat daftar…" />}
          {listError && <Empty title="Gagal memuat daftar" body={listError} />}
          {!listLoading && !listError && (
            <>
              <div className="mb-2 flex flex-wrap items-center gap-2">
                <p className="text-[12px] text-ink-500" data-search-count>
                  {items.length} komik{filterSuffix}
                </p>
                {listFailed > 0 && <FailedSourceChip count={listFailed} />}
              </div>
              {items.length === 0 ? (
                <Empty
                  title="Tidak ada hasil"
                  body="Belum ada komik yang cocok dengan filter ini."
                />
              ) : (
                <ResultGrid items={items} />
              )}

              {hasMore && items.length > 0 && (
                <div className="mt-5 flex justify-center">
                  <button
                    disabled={more}
                    onClick={loadMore}
                    className="rounded-full border border-ink-700 px-5 py-2.5 text-[13px] font-medium text-ink-300 transition-colors hover:border-brand-amber hover:text-brand-amber disabled:opacity-40"
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
          <MangaCard manga={m} />
        </li>
      ))}
    </ul>
  )
}

/**
 * Chip ringkas sumber yang gagal — pengganti banner "⚠ n/4 sumber gagal
 * dimuat". Warna & bentuknya meniru pill kesehatan sumber di TopBar supaya
 * bahasa visualnya sama.
 */
function FailedSourceChip({ count }: { count: number }) {
  return (
    <span
      data-source-failed
      role="status"
      aria-label={`${count} dari ${TOTAL_SOURCES} sumber gagal dimuat`}
      title={`${count} dari ${TOTAL_SOURCES} sumber gagal dimuat`}
      className="inline-flex items-center gap-1 rounded-full bg-warn/12 px-2 py-0.5 text-[11px] font-bold text-warn ring-1 ring-warn/30"
    >
      <span aria-hidden="true">⚠</span>
      {count}/{TOTAL_SOURCES} sumber gagal
    </span>
  )
}
