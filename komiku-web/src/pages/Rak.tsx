import { useEffect, useRef, useState } from 'react'
import { Link, useLocation, useSearchParams } from 'react-router-dom'
import { imgUrl } from '../imgUrl'
import { accountHeaders, unifiedApi } from '../api'
import * as rakStore from '../rakStore'
import { resolveResumeTarget, resumeLabel } from '../progressResume'
import { resumeHref } from '../readerSource'
import { useProgress } from '../hooks/useProgress'
import { useMarathonMemory } from '../hooks/useMarathonMemory'
import { getUser } from '../account'
import { Empty, Spinner } from '../App'
import { IconArrowRight, IconXmark } from '../icons'
import { humanSize, saveGeneratedPdf } from '../downloadBatch'
// Store unduhan: import STATIS (bukan import.meta.glob lazy) — glob-lazy
// bisa membuat instance modul terpisah dari yang dipakai halaman series,
// sehingga dua singleton store dan Rak tak pernah melihat run-nya.
// Seam ini persis yang memicu kartu 'Sedang diunduh' tak muncul di Rak.
import { cancelRun, getRuns, isRunStale, runBusy, runProgress, subscribeRuns, type DlRun } from '../downloadStore'
import { useNotifCounts } from '../notifCounts'
import SourceBadge from '../components/SourceBadge'
import UpdateQueueStrip from '../components/UpdateQueueStrip'
import type { DownloadItem, DownloadsResponse } from '../types'

type TabKey = rakStore.RakTab

/** Urutan tab + label (dl untuk tablist ARIA di atas). Kunci lama tetap
 *  diterima sebagai alias URL; tampilan memakai 5 status dari plan UX. */
const TABS = [
  ['semua', 'Semua'],
  ['sedang', 'Sedang Dibaca'],
  ['ingin', 'Ingin Dibaca'],
  ['selesai', 'Selesai'],
  ['unduhan', 'Unduhan'],
] as const satisfies readonly (readonly [TabKey, string])[]

/** ?tab= lama (terbaru/sejarah/favorit) → status baru. Tanpa query = Semua. */
function tabFromQuery(value: string | null): TabKey {
  return rakStore.normalizeRakTab(value)
}

/** ID DOM lama dipertahankan supaya probe/tautan lama tidak putus. */
function tabDomId(key: TabKey): string {
  if (key === 'semua') return 'tab-terbaru'
  if (key === 'sedang') return 'tab-sejarah'
  if (key === 'ingin') return 'tab-favorit'
  return `tab-${key}`
}

/** Minimal shape run untuk teks progres (kompatibel dengan DlRun store). */
type RunProgressSource = { jobs: readonly { state: 'wait' | 'run' | 'ok' | 'fail' }[] }

/**
 * SATU definisi progres untuk mode pdf & cache: selesai = ok + fail,
 * dihitung via `runProgress` dari store.
 */
function runProgressText(run: RunProgressSource): string {
  const total = run.jobs.length
  const { selesai, ok, fail } = runProgress(run)
  return `${selesai}/${total} diproses · ${ok} tersimpan · ${fail} gagal`
}

/** Jumlah run aktif — untuk badge di tab Unduhan. */
function useActiveRunCount(): number {
  const [count, setCount] = useState(() => getRuns().filter(runBusy).length)
  useEffect(() => subscribeRuns((runs) => setCount(runs.filter(runBusy).length)), [])
  return count
}

/**
 * Halaman /rak — 4 tab: Terbaru (feed unified) · Sejarah · Favorit · Unduhan.
 *
 * Terbaru = feed `latest` gabungan sumber dengan filter sumber + urutan
 * (state di URL ?source=&sort=). Sejarah & Favorit dibaca dari rakStore
 * (localStorage, snapshot) — kebuka instan tanpa tunggu server. Unduhan hidup
 * di server (downloads/index.json).
 *
 * Tab awal boleh di-deep-link: /rak?tab=unduhan dipakai halaman series
 * setelah batch unduh selesai.
 */
export default function Rak() {
  const [params, setSearchParams] = useSearchParams()
  const location = useLocation()
  const flashFromNav = (location.state as { flash?: string } | null)?.flash ?? null
  const [tab, setTab] = useState<TabKey>(() => tabFromQuery(params.get('tab')))
  // Selaraskan tab dengan URL: CTA empty-state (?tab=favorit) dan deep-link
  // harus benar-benar memindahkan panel, bukan cuma mengganti query.
  const tabQuery = params.get('tab')
  useEffect(() => {
    setTab(tabFromQuery(tabQuery))
  }, [tabQuery])
  const goTab = (key: TabKey) => {
    setTab(key)
    setSearchParams(rakStore.rakTabQuery(key), { replace: true })
  }
  const [flash, setFlash] = useState<string | null>(flashFromNav)
  const [history, setHistory] = useState(() => rakStore.listHistory())
  const [favorites, setFavorites] = useState(() => rakStore.listFavorites())
  const activeRuns = useActiveRunCount()

  // re-render saat rakStore berubah (heart di series/reader, baca chapter)
  useEffect(() => {
    const onRak = () => {
      setHistory(rakStore.listHistory())
      setFavorites(rakStore.listFavorites())
    }
    window.addEventListener('rak-change', onRak)
    return () => window.removeEventListener('rak-change', onRak)
  }, [])

  // pesan dari halaman series (mis. "Unduhan selesai") — hilang sendiri
  useEffect(() => {
    if (!flash) return
    const t = setTimeout(() => setFlash(null), 6000)
    return () => clearTimeout(t)
  }, [flash])

  return (
    <div className="mx-auto max-w-3xl px-4 py-5">
      <h1 className="mb-4 text-lg font-semibold text-ink-100">Rak</h1>

      {/* banner dari navigasi (hasil batch unduh) */}
      {flash && (
        <div className="mb-4 flex items-center justify-between gap-2 rounded-xl border border-brand-amber-dim bg-brand-amber/10 px-3 py-2">
          <p className="text-[12px] font-semibold text-brand-amber">{flash}</p>
          <button
            onClick={() => setFlash(null)}
            aria-label="Tutup pesan"
            className="grid size-11 shrink-0 place-items-center text-ink-400"
          >
            <IconXmark className="size-4" />
          </button>
        </div>
      )}

      {/* Tab = ARIA tablist (bukan grid tombol): panah kiri/kanan pindah tab,
          aria-selected bawa keadaan aktif ke screen reader (dulu warna saja). */}
      <div
        role="tablist"
        aria-label="Rak"
        className="no-bar mb-4 flex gap-2 overflow-x-auto pb-1"
      >
        {TABS.map(([key, label]) => (
          <button
            key={key}
            role="tab"
            id={tabDomId(key)}
            data-testid={`tab-${key}`}
            aria-selected={tab === key}
            aria-controls={`panel-${key}`}
            tabIndex={tab === key ? 0 : -1}
            onClick={() => goTab(key)}
            onKeyDown={(e) => {
              const step =
                e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : e.key === 'Home' ? -99 : e.key === 'End' ? 99 : 0
              if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft' && e.key !== 'Home' && e.key !== 'End') return
              e.preventDefault()
              const current = TABS.findIndex(([k]) => k === tab)
              const next =
                step === -99 ? 0 : step === 99 ? TABS.length - 1 : (current + step + TABS.length) % TABS.length
              const nextKey = TABS[next][0]
              goTab(nextKey)
              document.getElementById(tabDomId(nextKey))?.focus()
            }}
            className={`min-h-11 shrink-0 rounded-xl px-3.5 py-2.5 text-[12px] font-bold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-amber focus-visible:ring-offset-2 ${
              tab === key
                ? 'bg-brand-amber text-white'
                : 'border border-ink-800 bg-ink-900 text-ink-300'
            }`}
          >
            <span className="inline-flex items-center justify-center gap-1.5">
              {label}
              {key === 'unduhan' && activeRuns > 0 && (
                <span
                  aria-hidden="true"
                  className="grid min-h-5 min-w-5 place-items-center rounded-full bg-white px-1 text-[10px] font-bold leading-none text-ink-900"
                >
                  {activeRuns > 9 ? '9+' : activeRuns}
                </span>
              )}
              {key === 'unduhan' && activeRuns > 0 && (
                <span className="sr-only">, {activeRuns} proses berjalan</span>
              )}
            </span>
          </button>
        ))}
      </div>

      {tab === 'semua' && (
        <section role="tabpanel" id="panel-semua" aria-labelledby="tab-terbaru">
          <LibraryTab mode="semua" history={history} favorites={favorites} />
        </section>
      )}
      {tab === 'sedang' && <section role="tabpanel" id="panel-sedang" aria-labelledby="tab-sejarah"><HistoryTab entries={history} /></section>}
      {tab === 'ingin' && <section role="tabpanel" id="panel-ingin" aria-labelledby="tab-favorit"><UpdateQueueStrip /><FavoritesTab entries={favorites} /></section>}
      {tab === 'selesai' && (
        <section role="tabpanel" id="panel-selesai" aria-labelledby="tab-selesai">
          <LibraryTab mode="selesai" history={history} favorites={favorites} />
        </section>
      )}
      {tab === 'unduhan' && <section role="tabpanel" id="panel-unduhan" aria-labelledby="tab-unduhan" aria-label="Unduhan tersimpan"><DownloadsTab /></section>}
    </div>
  )
}

// ---------------------------------------------------------------- Rak status

type LibraryMode = 'semua' | 'selesai'
type LibraryRow = {
  key: string
  title: string
  cover: string | null
  source: string
  handle: string
  href: string
  chapter: string | null
  at: number
  updates: number
}

/** Gabungan riwayat + favorit menjadi 5 status Rak. `updates` dan urutan
 *  "terbaru" berasal dari data notifikasi/progres yang sudah ada — tidak
 *  ada angka yang direkayasa kalau datanya kosong. */
function LibraryTab({
  mode,
  history,
  favorites,
}: {
  mode: LibraryMode
  history: rakStore.HistoryEntry[]
  favorites: rakStore.FavoriteEntry[]
}) {
  const { recent } = useProgress()
  const marathon = useMarathonMemory()
  const { unreadByTitle, latestByTitle } = useNotifCounts()
  const [onlyUpdates, setOnlyUpdates] = useState(false)

  const progressByHandle = new Map<string, (typeof recent)[number]>()
  for (const p of recent) {
    for (const key of [p.handle, p.seriesId, String(p.handle ?? '').split(':').pop()]) {
      if (key != null && key !== '') progressByHandle.set(String(key), p)
    }
  }

  const seen = new Set<string>()
  const rows: LibraryRow[] = []
  for (const entry of [...history, ...favorites]) {
    if (seen.has(entry.title_key)) continue
    seen.add(entry.title_key)

    const p = progressByHandle.get(String(entry.handle)) ?? progressByHandle.get(String(entry.handle).split(':').pop() ?? '')
    const done = p?.status === 'Selesai' || (p?.progress ?? 0) >= 1
    const status = done ? 'selesai' : p ? 'sedang' : 'ingin'
    if (mode !== 'semua' && status !== mode) continue

    const target = p ? resolveResumeTarget(p, marathon.forHandle(String(p.handle ?? p.seriesId))) : null
    const fallback = 'last_chapter' in entry ? resumeHref(entry) : null
    const updates = unreadByTitle[entry.title_key] ?? 0
    const notifAt = latestByTitle[entry.title_key]?.at ?? 0
    rows.push({
      key: entry.title_key,
      title: entry.title,
      cover: entry.cover_url,
      source: entry.source,
      handle: entry.handle,
      href: target?.href ?? fallback ?? `/manga/${entry.handle}`,
      chapter: target
        ? resumeLabel({ chapterId: target.chapterId, source: target.source, chapterName: p?.chapterName })
        : null,
      at: Math.max(
        'updated_at' in entry ? entry.updated_at : entry.loved_at,
        p?.at ?? 0,
        notifAt,
      ),
      updates,
    })
  }
  rows.sort((a, b) => b.at - a.at)
  const hasUpdates = rows.some((r) => r.updates > 0)
  const visible = hasUpdates && onlyUpdates ? rows.filter((r) => r.updates > 0) : rows

  if (rows.length === 0) {
    return (
      <Empty
        title={mode === 'selesai' ? 'Belum ada komik selesai' : 'Rak masih kosong'}
        body={mode === 'selesai' ? 'Tandai komik sebagai selesai dari halaman series.' : 'Simpan komik dari halaman series atau Cari.'}
      />
    )
  }

  return (
    <div>
      {hasUpdates && (
        <button
          type="button"
          aria-pressed={onlyUpdates}
          onClick={() => setOnlyUpdates((v) => !v)}
          className="mb-3 min-h-11 rounded-full border border-ink-800 bg-ink-900 px-4 text-[12px] font-bold text-ink-300 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-amber"
        >
          Hanya yang ada update
        </button>
      )}
      <ul className="space-y-2.5">
        {visible.map((r) => (
          <li key={r.key}>
            <Link
              to={r.href}
              className="relative flex items-center gap-3 rounded-xl border border-ink-800 bg-ink-900 p-2.5 transition-colors [@media(hover:hover)]:hover:border-ink-700 active:scale-[0.98]"
            >
              <Cover src={r.cover} title={r.title} />
              <div className="min-w-0 flex-1">
                <p className="truncate text-[13px] font-semibold text-ink-100">{r.title}</p>
                <p className="truncate text-[11px] text-ink-500">
                  {r.source} · {r.chapter ?? 'Belum dibaca'} · {new Date(r.at).toLocaleDateString('id-ID')}
                </p>
              </div>
              {r.updates > 0 && (
                <span
                  aria-label={`${r.updates} chapter update belum dibaca`}
                  className="shrink-0 rounded-full bg-brand-amber px-2 py-0.5 text-[10px] font-bold text-white"
                >
                  +{r.updates} Ch.
                </span>
              )}
            </Link>
          </li>
        ))}
      </ul>
    </div>
  )
}

// ---------------------------------------------------------------- Riwayat baca

function HistoryTab({ entries }: { entries: rakStore.HistoryEntry[] }) {
  const { recent } = useProgress()
  const marathon = useMarathonMemory()
  const byHandle = new Map<string, rakStore.HistoryEntry>()
  for (const e of entries) {
    byHandle.set(String(e.handle), e)
    const numeric = String(e.handle).split(':').pop()
    if (numeric) byHandle.set(numeric, e)
  }

  const rows = recent
    .map((p) => {
      const e = byHandle.get(String(p.handle ?? '')) ?? byHandle.get(String(p.seriesId))
      if (!e) return null
      const pos = marathon.forHandle(e.handle)
      const target = resolveResumeTarget(p, pos)
      if (!target) return null
      return {
        key: e.title_key,
        entry: e,
        href: target.href,
        chapter: resumeLabel({
          chapterId: target.chapterId,
          source: target.source,
          chapterName: p.chapterName,
        }),
        page: target.page,
        progress: Math.max(0, Math.min(1, p.progress || 0)),
      }
    })
    .filter((r): r is NonNullable<typeof r> => r !== null)

  if (rows.length === 0) {
    return <Empty title="Belum ada riwayat baca" body="Buka sebuah chapter, akan muncul di sini." />
  }
  return (
    <ul className="space-y-2.5">
      {rows.map((r) => (
        <li key={r.key}>
          <Link
            to={r.href}
            className="flex items-center gap-3 rounded-xl border border-ink-800 bg-ink-900 p-2.5 transition-colors [@media(hover:hover)]:hover:border-ink-700 active:scale-[0.98]"
          >
            <Cover src={r.entry.cover_url} title={r.entry.title} />
            <div className="min-w-0 flex-1">
              <p className="truncate text-[13px] font-semibold text-ink-100">{r.entry.title}</p>
              <p className="truncate text-[11.5px] text-ink-400">
                {r.chapter} · Halaman {Number.isFinite(r.page) ? r.page + 1 : 1} · {new Date(r.entry.updated_at).toLocaleDateString('id-ID')}
              </p>
              <div className="mt-1 h-1 w-full overflow-hidden rounded-full bg-ink-800">
                <div className="h-full rounded-full bg-brand-amber" style={{ width: `${Math.round(r.progress * 100)}%` }} />
              </div>
            </div>
            <span className="shrink-0 text-[11px] font-bold text-brand-amber">Lanjut</span>
          </Link>
        </li>
      ))}
    </ul>
  )
}

// ---------------------------------------------------------------- Favorit

function FavoritesTab({ entries }: { entries: rakStore.FavoriteEntry[] }) {
  const { unreadByTitle } = useNotifCounts()
  if (entries.length === 0) {
    return (
      <Empty
        title="Belum ada favorit"
        body="Tekan ikon hati di halaman series, atau cari komik baru untuk disimpan."
        action={
          <Link
            to="/cari"
            className="inline-flex min-h-11 items-center rounded-full bg-brand-amber px-5 text-[12px] font-bold text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-amber focus-visible:ring-offset-2"
          >
            Cari komik
          </Link>
        }
      />
    )
  }
  return (
    <ul className="space-y-2.5">
      {entries.map((e) => {
        const count = unreadByTitle[e.title_key] ?? 0
        return (
          <li key={e.title_key} className="flex items-center gap-2">
            <Link
              to={`/manga/${e.handle}`}
              className="relative flex min-w-0 flex-1 items-center gap-3 rounded-xl border border-ink-800 bg-ink-900 p-2.5 transition-colors [@media(hover:hover)]:hover:border-ink-700 active:scale-[0.98]"
            >
              <Cover src={e.cover_url} title={e.title} />
              <div className="min-w-0 flex-1">
                <p className="truncate text-[13px] font-semibold text-ink-100">{e.title}</p>
                <p className="truncate text-[11px] text-ink-500">
                  {e.source} · {new Date(e.loved_at).toLocaleDateString('id-ID')}
                </p>
              </div>
              {count > 0 && (
                <span
                  aria-hidden="true"
                  className="pointer-events-none absolute -right-1 -top-1 grid min-h-5 min-w-5 place-items-center rounded-full bg-brand-amber px-1 text-[10px] font-bold leading-none text-white"
                >
                  {count > 9 ? '9+' : count}
                </span>
              )}
            </Link>
          </li>
        )
      })}
    </ul>
  )
}

function Cover({ src, title }: { src: string | null; title: string }) {
  // `failed` menutup kasus cover yang URL-nya ADA tapi gagal dimuat (host mati,
  // 403, DNS hilang). Tanpa ini, <img> gagal tampil sebagai ikon rusak dan
  // seluruh kartu terlihat broken — padahal fallback inisial sudah tersedia.
  const [failed, setFailed] = useState(false)
  const showImg = !!src && !failed
  return (
    <div className="size-12 shrink-0 overflow-hidden rounded-lg bg-ink-850">
      {showImg ? (
        <img referrerPolicy="no-referrer" src={imgUrl(src)} alt="" loading="lazy" onError={() => setFailed(true)} className="size-full object-cover" />
      ) : (
        <span className="grid size-full place-items-center text-[15px] font-bold text-ink-500">
          {title.slice(0, 1)}
        </span>
      )}
    </div>
  )
}

// ---------------------------------------------------------------- Unduhan

// Store unduhan diimpor statis; kontrak run dikonsumsi lewat type import.
interface DlStoreModule {
  getRuns: () => DlRun[]
  subscribeRuns: (cb: (runs: DlRun[]) => void) => () => void
  cancelRun: (handle: string) => void
}

let storePromise: Promise<DlStoreModule> | null = null
/** Store di-load sekali; modul asli (singleton bersama halaman series). */
function loadStore(): Promise<DlStoreModule> {
  if (!storePromise) {
    storePromise = Promise.resolve({ getRuns, subscribeRuns, cancelRun })
  }
  return storePromise
}

/**
 * Proses unduhan lintas halaman (aktif + ringkasan terminal): unduhan
 * LANJUT walau user pindah tab/halaman (paritas notifikasi sistem
 * "Chapter 64 · Series — 61%").
 */
function useAllRuns(): DlRun[] {
  const [runs, setRuns] = useState<DlRun[]>([])
  useEffect(() => {
    let alive = true
    let unsub: (() => void) | undefined
    void loadStore().then((store) => {
      if (!store || !alive) return
      setRuns(store.getRuns())
      unsub = store.subscribeRuns(setRuns)
    })
    return () => {
      alive = false
      unsub?.()
    }
  }, [])
  return runs
}

/** Kartu per SERIES: proses yang jalan (+ tombol Batal) dan ringkasan run terminal. */
function ActiveDownloads({ runs }: { runs: DlRun[] }) {
  // Detak 30 dtk untuk label "macet" (startedAt tua + masih aktif).
  const [now, setNow] = useState(() => Date.now())
  // Double-tap Batal: satu permintaan batal per handle, dibuka lagi setelah
  // 10 dtk (atau Run hilang dari daftar karena selesai/batal).
  const [cancelling, setCancelling] = useState<ReadonlySet<string>>(() => new Set())
  const busyRuns = runs.filter(runBusy)
  const terminalRuns = runs.filter((r) => !runBusy(r))
  useEffect(() => {
    if (busyRuns.length === 0) return
    const t = setInterval(() => setNow(Date.now()), 30_000)
    return () => clearInterval(t)
  }, [busyRuns.length])
  if (runs.length === 0) return null
  const requestCancel = (handle: string) => {
    setCancelling((prev) => new Set(prev).add(handle))
    void loadStore().then((s) => s?.cancelRun(handle))
    window.setTimeout(() => {
      setCancelling((prev) => {
        const next = new Set(prev)
        next.delete(handle)
        return next
      })
    }, 10_000)
  }
  return (
    <div className="mb-4 space-y-2.5">
      {busyRuns.length > 0 && (
        <p className="text-[11.5px] font-semibold text-ink-400">Sedang diunduh</p>
      )}
      {busyRuns.map((run) => {
        const { selesai, fail } = runProgress(run)
        const total = run.jobs.length
        const failMsg = run.jobs.find((j) => j.state === 'fail' && j.error)?.error
        const pct = total > 0 ? Math.round((selesai / total) * 100) : 0
        const current =
          run.jobs.find((j) => j.state === 'run') ?? run.jobs.find((j) => j.state === 'wait')
        const isCancelling = cancelling.has(run.handle)
        const stale = isRunStale(run, now)
        return (
          <div key={run.handle} className="rounded-xl border border-brand-amber-dim bg-ink-900 p-3">
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0">
                <p className="truncate text-[13px] font-semibold text-ink-100">{run.seriesTitle}</p>
                <p className="text-[11.5px] text-ink-400">
                  {runProgressText(run)}
                  {current ? ` · Chapter ${current.number}` : ''}
                </p>
                {fail > 0 && (
                  <p className="mt-0.5 truncate text-[11px] text-brand-red">
                    {fail} gagal{failMsg ? ` · ${failMsg}` : ''}
                  </p>
                )}
                {stale && (
                  <p className="mt-0.5 text-[11px] font-semibold text-brand-red">
                    Unduhan tampak macet (≥15 menit tanpa hasil). Batal lalu coba lagi.
                  </p>
                )}
              </div>
              <button
                disabled={isCancelling}
                onClick={() => requestCancel(run.handle)}
                aria-label={isCancelling ? `Membatalkan unduhan ${run.seriesTitle}` : `Batalkan unduhan ${run.seriesTitle}`}
                className="min-h-11 min-w-11 shrink-0 rounded-lg border border-ink-700 px-4 py-2.5 text-[12px] font-semibold text-ink-300 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-amber focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50 [@media(hover:hover)]:hover:bg-ink-800"
              >
                {isCancelling ? 'Membatalkan…' : 'Batal'}
              </button>
            </div>
            <div
              className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-ink-800"
              role="progressbar"
              aria-label={`Progres unduhan ${run.seriesTitle}`}
              aria-valuemin={0}
              aria-valuemax={total}
              aria-valuenow={selesai}
              aria-valuetext={`${selesai} dari ${total} diproses`}
            >
              <div className="h-full rounded-full bg-brand-amber transition-[width]" style={{ width: `${pct}%` }} />
            </div>
          </div>
        )
      })}
      {terminalRuns.length > 0 && (
        <section aria-label="Ringkasan unduhan">
          <p className="text-[11.5px] font-semibold text-ink-400">Ringkasan unduhan</p>
          <ul className="mt-1 space-y-1.5">
            {terminalRuns.map((run) => (
              <li
                key={run.handle}
                className="flex items-center justify-between gap-3 rounded-xl border border-ink-800 bg-ink-900 px-3 py-2 text-[12px]"
              >
                <span className="min-w-0 truncate text-ink-200">
                  {run.seriesTitle}
                  <span className="text-ink-500"> · {run.mode === 'cache' ? 'Cache' : 'PDF'}</span>
                </span>
                <span className="shrink-0 text-ink-400">{runProgressText(run)}</span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  )
}

/** Urutkan chapter berdasarkan nomor (numerik bila mungkin), lalu string. */
const byChapterNumber = (a: DownloadItem, b: DownloadItem) => {
  const na = parseFloat(a.number)
  const nb = parseFloat(b.number)
  if (Number.isFinite(na) && Number.isFinite(nb) && na !== nb) return na - nb
  return String(a.number).localeCompare(String(b.number), undefined, { numeric: true })
}

/** Satu kartu series: judul + badge sumber + jumlah chapter + total ukuran. */
export interface SeriesGroup {
  handle: string
  title: string
  source: string
  items: DownloadItem[]
  bytes: number
}

/** Default buka/tutup: kartu <=3 chapter langsung terbuka, sisanya tertutup. */
export function defaultOpen(g: SeriesGroup): boolean {
  return g.items.length <= 3
}

/** Kelompokkan daftar unduhan per series (handle), terbaru dulu. */
export function groupBySeries(items: DownloadItem[]): SeriesGroup[] {
  const groups: SeriesGroup[] = []
  const byHandle = new Map<string, SeriesGroup>()
  for (const d of items) {
    // runtime guard: server bisa kirim baris rusak — lewati diam-diam
    if (!d || typeof d !== 'object') continue
    if (typeof d.handle !== 'string' || !d.handle.includes(':')) continue
    if (typeof d.series_title !== 'string') continue
    const size = Number(d.size_bytes)
    if (!Number.isFinite(size)) continue
    const dlRaw = d.downloaded_at
    const dlNum = dlRaw == null ? null : Number(dlRaw)
    const downloaded_at = dlNum != null && Number.isFinite(dlNum) ? dlNum : null
    let g = byHandle.get(d.handle)
    if (!g) {
      g = {
        handle: d.handle,
        title: d.series_title,
        source: d.handle.split(':')[0],
        items: [],
        bytes: 0,
      }
      byHandle.set(d.handle, g)
      groups.push(g)
    }
    g.items.push({ ...d, size_bytes: size, downloaded_at })
    g.bytes += size
  }
  const newestAt = (g: SeriesGroup) =>
    g.items.reduce((a, d) => Math.max(a, d.downloaded_at ?? 0), 0)
  return groups.sort((a, b) => newestAt(b) - newestAt(a))
}

function DownloadsTab() {
  const [data, setData] = useState<DownloadsResponse | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  // buka/tutup kartu series; default terbuka kalau <=3 chapter
  const [openOverride, setOpenOverride] = useState<Record<string, boolean>>({})
  // chapter tengah tersembunyi per grup (ringkasan endpoint: terkecil+terbesar)
  const [expandedGroups, setExpandedGroups] = useState<Record<string, boolean>>({})
  // galat aksi per baris (Baca/Unduh lagi), terpisah dari state error list
  const [rowError, setRowError] = useState<string | null>(null)
  const runs = useAllRuns()

  const friendlyError = 'Terjadi kendala saat memuat unduhan. Coba lagi.'

  const load = () => {
    setError(null)
    unifiedApi
      .downloads()
      .then(setData)
      .catch((e: unknown) => {
        console.error('[rak] downloads failed', e)
        setError(friendlyError)
      })
      .finally(() => setLoading(false))
  }

  const loadRef = useRef(load)
  loadRef.current = load

  useEffect(() => {
    load()
  }, [])

  // Re-fetch setelah run transisi ke terminal (done/error), debounced.
  useEffect(() => {
    const prev = new Map(getRuns().map((r) => [r.handle, runBusy(r)]))
    let timer: number | undefined
    const unsub = subscribeRuns((snapshot) => {
      let wentTerminal = false
      for (const run of snapshot) {
        const was = prev.get(run.handle)
        const nowBusy = runBusy(run)
        if (was === true && !nowBusy) wentTerminal = true
        prev.set(run.handle, nowBusy)
      }
      if (!wentTerminal) return
      if (timer !== undefined) window.clearTimeout(timer)
      timer = window.setTimeout(() => loadRef.current(), 400)
    })
    return () => {
      unsub()
      if (timer !== undefined) window.clearTimeout(timer)
    }
  }, [])

  // Server mewajibkan header X-Komik-User; anchor top-level tidak bisa
  // membawanya — fetch + blob saja (pola yang sama dengan saveGeneratedPdf).
  const openDownloadedPdf = async (d: DownloadItem, mode: 'read' | 'save') => {
    setRowError(null)
    if (mode === 'save') {
      const ok = await saveGeneratedPdf(d.id, d.filename)
      if (!ok) setRowError('Gagal mengunduh ulang — coba lagi sebentar lagi.')
      return
    }
    try {
      const res = await fetch(unifiedApi.downloadFileUrl(d.id, d.filename), {
        headers: accountHeaders(),
      })
      if (!res.ok) throw new Error(String(res.status))
      const blob = await res.blob()
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.target = '_blank'
      a.rel = 'noopener'
      a.style.display = 'none'
      document.body.appendChild(a)
      a.click()
      window.setTimeout(() => {
        a.remove()
        URL.revokeObjectURL(url)
      }, 1000)
    } catch (e) {
      console.error('[rak] buka PDF gagal', e)
      setRowError('Gagal membuka PDF — coba Unduh lagi.')
    }
  }

  const items = Array.isArray(data?.items) ? data.items : []
  const groups = groupBySeries(items)

  return (
    <div>
      {/* proses unduhan yang masih jalan (lintas halaman) */}
      <ActiveDownloads runs={runs} />

      {getUser() === null && (
        <Empty
          icon="🔒"
          title="Masuk untuk mengunduh"
          body="Unduhan tersimpan di akunmu. Masuk untuk melihat dan mengelola chapter yang sudah diunduh."
          action={
            <Link
              to="/akun"
              className="inline-flex min-h-11 items-center rounded-full bg-brand-amber px-5 text-[12px] font-bold text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-amber focus-visible:ring-offset-2"
            >
              Masuk
            </Link>
          }
        />
      )}

      {getUser() !== null && error && (
        <div className="mb-3 flex items-center justify-between gap-3 rounded-xl border border-brand-red/40 bg-brand-red/10 px-3 py-2 text-[12px] text-brand-red">
          <p>{error}</p>
          <button
            type="button"
            onClick={load}
            className="min-h-11 shrink-0 whitespace-nowrap rounded-lg border border-brand-red/50 px-3 py-2 font-semibold"
          >
            Coba lagi
          </button>
        </div>
      )}

      {getUser() !== null && loading && !data && !error && (
        <div role="status">
          <Spinner label="Memuat unduhan…" />
        </div>
      )}

      {getUser() !== null && !loading && !error && items.length === 0 && (
        <Empty
          icon="📥"
          title="Belum ada unduhan"
          body={'Buka halaman series, pilih chapter yang ingin disimpan, lalu tekan "Unduh Offline" atau "Unduh PDF".'}
          action={
            <div className="flex flex-wrap items-center justify-center gap-2">
              <Link
                to="/rak?tab=favorit"
                className="inline-flex min-h-11 items-center rounded-full border border-ink-700 px-5 text-[12px] font-semibold text-ink-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-amber focus-visible:ring-offset-2"
              >
                Favorit
              </Link>
              <Link
                to="/cari"
                className="inline-flex min-h-11 items-center rounded-full bg-brand-amber px-5 text-[12px] font-bold text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-amber focus-visible:ring-offset-2"
              >
                Cari komik
              </Link>
            </div>
          }
        />
      )}

      {rowError && (
        <div
          role="alert"
          className="mb-3 rounded-xl border border-brand-red/40 bg-brand-red/10 px-3 py-2 text-[12px] text-brand-red"
        >
          {rowError}
        </div>
      )}

      <ul className="space-y-2.5">
        {groups.map((g) => {
          const open = openOverride[g.handle] ?? defaultOpen(g)
          const expanded = !!expandedGroups[g.handle]
          const ordered = [...g.items].sort(byChapterNumber)
          const shown = ordered.length > 2 && !expanded ? [ordered[0], ordered[ordered.length - 1]] : ordered
          const hiddenCount = ordered.length - shown.length
          return (
            <li key={g.handle} className="rounded-xl border border-ink-800 bg-ink-900">
              <button
                onClick={() => setOpenOverride((o) => ({ ...o, [g.handle]: !open }))}
                aria-expanded={open}
                className="flex w-full items-center gap-2.5 p-3 text-left"
              >
                <IconArrowRight
                  className={`size-3.5 shrink-0 text-ink-400 transition-transform duration-200 ease-[var(--ease-out)] ${
                    open ? 'rotate-90' : ''
                  }`}
                />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[13px] font-semibold text-ink-100">
                    {g.title}
                  </span>
                  <span className="mt-0.5 flex items-center gap-1.5 text-[11.5px] text-ink-400">
                    <SourceBadge source={g.source} />
                    {g.items.length} chapter · {humanSize(g.bytes)}
                  </span>
                </span>
              </button>
              {open && (
                <ul className="divide-y divide-ink-800 border-t border-ink-800">
                  {shown.map((d) => {
                    const label = d.title || `Chapter ${d.number}`
                    return (
                      <li key={d.id} className="flex flex-wrap items-center gap-2 px-3 py-2.5">
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-[12.5px] text-ink-100">
                            {label}
                          </span>
                          <span className="block text-[11.5px] text-ink-400">
                            {humanSize(d.size_bytes)}
                            {d.downloaded_at != null &&
                              ` · ${new Date(d.downloaded_at).toLocaleDateString('id-ID')}`}
                          </span>
                        </span>
                        <button
                          type="button"
                          onClick={() => void openDownloadedPdf(d, 'read')}
                          aria-label={`Baca ${label} — ${g.title} (tab baru)`}
                          className="min-h-11 min-w-11 rounded-lg bg-brand-amber px-4 py-2.5 text-[12px] font-bold text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-amber focus-visible:ring-offset-2"
                        >
                          Baca
                        </button>
                        <button
                          type="button"
                          onClick={() => void openDownloadedPdf(d, 'save')}
                          aria-label={`Unduh lagi ${label} — ${g.title} sebagai PDF`}
                          className="min-h-11 min-w-11 rounded-lg border border-ink-700 px-4 py-2.5 text-[12px] font-semibold text-ink-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-amber focus-visible:ring-offset-2"
                        >
                          Unduh lagi
                        </button>
                        <button
                          disabled={busy}
                          aria-label={`Hapus unduhan ${label} — ${g.title}`}
                          onClick={() => {
                            if (!window.confirm(`Hapus unduhan ${g.title} — ${label}?`)) return
                            setBusy(true)
                            unifiedApi
                              .deleteDownload(d.id)
                              .then(() => load())
                              .catch((e: unknown) => {
                                console.error('[rak] downloads failed', e)
                                setError(friendlyError)
                              })
                              .finally(() => setBusy(false))
                          }}
                          className="min-h-11 min-w-11 rounded-lg border border-brand-red/50 px-4 py-2.5 text-[12px] font-semibold text-brand-red focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-red focus-visible:ring-offset-2 disabled:opacity-60"
                        >
                          Hapus
                        </button>
                      </li>
                    )
                  })}
                  {(hiddenCount > 0 || expanded) && ordered.length > 2 && (
                    <li className="px-2 py-1.5 text-center">
                      <button
                        type="button"
                        aria-expanded={expanded}
                        onClick={() => setExpandedGroups((m) => ({ ...m, [g.handle]: !expanded }))}
                        className="min-h-11 rounded-lg px-4 text-[11.5px] font-semibold text-ink-400 underline-offset-2 hover:text-ink-200 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-amber"
                      >
                        {expanded ? 'Sembunyikan chapter lain' : `Tampilkan ${hiddenCount} chapter lainnya`}
                      </button>
                    </li>
                  )}
                </ul>
              )}
            </li>
          )
        })}
      </ul>
    </div>
  )
}

