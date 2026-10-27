import { useEffect, useState } from 'react'
import { Link, useLocation, useSearchParams } from 'react-router-dom'
import { imgUrl } from '../imgUrl'
import { unifiedApi } from '../api'
import * as rakStore from '../rakStore'
import { readerHref } from '../readerSource'
import { Empty, Spinner } from '../App'
import { IconArrowRight, IconXmark } from '../icons'
import { humanSize } from '../downloadBatch'
// Store unduhan: import STATIS (bukan import.meta.glob lazy) — glob-lazy
// bisa membuat instance modul terpisah dari yang dipakai halaman series,
// sehingga dua singleton store dan Rak tak pernah melihat run-nya.
// Seam ini persis yang memicu kartu 'Sedang diunduh' tak muncul di Rak.
import { cancelRun, getRuns, subscribeRuns } from '../downloadStore'
import { useNotifCounts } from '../notifCounts'
import SourceBadge from '../components/SourceBadge'
import type { DownloadItem, DownloadsResponse } from '../types'

type TabKey = 'sejarah' | 'favorit' | 'unduhan'

/** Query ?tab= → tab aktif; nilai tak dikenal jatuh ke 'sejarah'. */
function tabFromQuery(value: string | null): TabKey {
  return value === 'favorit' || value === 'unduhan' ? value : 'sejarah'
}

/**
 * Halaman /rak — 3 tab: Sejarah · Favorit · Unduhan.
 *
 * Sejarah & Favorit dibaca dari rakStore (localStorage, snapshot) — kebuka
 * instan tanpa tunggu server. Unduhan hidup di server (downloads/index.json)
 * jadi tab ini fetch kontrak /api/unified/*.
 *
 * Tab awal boleh di-deep-link: /rak?tab=unduhan dipakai halaman series
 * setelah batch unduh selesai.
 */
export default function Rak() {
  const [params] = useSearchParams()
  const location = useLocation()
  const flashFromNav = (location.state as { flash?: string } | null)?.flash ?? null
  const [tab, setTab] = useState<TabKey>(() => tabFromQuery(params.get('tab')))
  const [flash, setFlash] = useState<string | null>(flashFromNav)
  const [history, setHistory] = useState(() => rakStore.listHistory())
  const [favorites, setFavorites] = useState(() => rakStore.listFavorites())

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
            className="shrink-0 p-1.5 text-ink-400"
          >
            <IconXmark className="size-4" />
          </button>
        </div>
      )}

      <div className="mb-4 grid grid-cols-3 gap-2">
        {(
          [
            ['sejarah', 'Sejarah'],
            ['favorit', 'Favorit'],
            ['unduhan', 'Unduhan'],
          ] as const
        ).map(([key, label]) => (
          <button
            key={key}
            onClick={() => setTab(key)}
            className={`rounded-xl py-2.5 text-[12.5px] font-bold transition-colors ${
              tab === key
                ? 'bg-brand-amber text-ink-950'
                : 'border border-ink-800 bg-ink-900 text-ink-300'
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      {tab === 'sejarah' && <HistoryTab entries={history} />}
      {tab === 'favorit' && <FavoritesTab entries={favorites} />}
      {tab === 'unduhan' && <DownloadsTab />}
    </div>
  )
}

// ---------------------------------------------------------------- Sejarah

function HistoryTab({ entries }: { entries: rakStore.HistoryEntry[] }) {
  if (entries.length === 0) {
    return <Empty title="Belum ada sejarah" body="Buka sebuah chapter, akan muncul di sini." />
  }
  return (
    <ul className="space-y-2.5">
      {entries.map((e) => (
        <li key={e.title_key}>
          <Link
            to={readerHref(`${e.handle}:${e.last_chapter}`)}
            className="flex items-center gap-3 rounded-xl border border-ink-800 bg-ink-900 p-2.5 transition-colors hover:border-ink-700"
          >
            <Cover src={e.cover_url} title={e.title} />
            <div className="min-w-0 flex-1">
              <p className="truncate text-[13px] font-semibold text-ink-100">{e.title}</p>
              <p className="truncate text-[11.5px] text-ink-400">
                Chapter {e.last_chapter} · {new Date(e.updated_at).toLocaleDateString('id-ID')}
              </p>
            </div>
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
    return <Empty title="Belum ada favorit" body="Tekan ikon hati di halaman series." />
  }
  return (
    <ul className="space-y-2.5">
      {entries.map((e) => {
        const count = unreadByTitle[e.title_key] ?? 0
        return (
          <li key={e.title_key} className="flex items-center gap-2">
            <Link
              to={`/manga/${e.handle}`}
              className="relative flex min-w-0 flex-1 items-center gap-3 rounded-xl border border-ink-800 bg-ink-900 p-2.5 transition-colors hover:border-ink-700"
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
                  className="pointer-events-none absolute -right-1 -top-1 grid h-[14px] min-w-[14px] place-items-center rounded-full bg-brand-amber px-0.5 text-[9px] font-bold leading-none text-ink-950"
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
  return (
    <div className="size-12 shrink-0 overflow-hidden rounded-lg bg-ink-850">
      {src ? (
        <img src={imgUrl(src)} alt="" loading="lazy" className="size-full object-cover" />
      ) : (
        <span className="grid size-full place-items-center text-[15px] font-bold text-ink-500">
          {title.slice(0, 1)}
        </span>
      )}
    </div>
  )
}

// ---------------------------------------------------------------- Unduhan

/**
 * Kontrak downloadStore (dibuat lane D1). Bentuknya ditiru di sini supaya
 * tab ini TIDAK menuntut file itu ada: modul dimuat opsional (lazy
 * import.meta.glob, bukan import statis). Kalau lane D1 belum mendarat,
 * glob-nya kosong → bagian "proses aktif" tidak dirender dan build tetap
 * hijau; begitu file-nya ada, pancaran aktif langsung menyala tanpa edit.
 */
interface DlJob {
  number: string
  state: 'wait' | 'run' | 'ok' | 'fail'
  error?: string
}
interface DlRun {
  handle: string
  seriesTitle: string
  /** 'pdf' = generate PDF + auto-unduh; 'cache' = simpan gambar offline. */
  mode?: 'pdf' | 'cache'
  /** jumlah PDF yang sudah terkirim ke perangkat (mode pdf). */
  saved?: number
  jobs: DlJob[]
  startedAt: number
}
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

/** Run yang masih punya chapter belum selesai (wait/run). */
function pendingOf(runs: DlRun[]): DlRun[] {
  return runs.filter((r) => r.jobs.some((j) => j.state === 'wait' || j.state === 'run'))
}

/**
 * Proses unduhan AKTIF lintas halaman: unduhan LANJUT walau user pindah
 * tab/halaman (paritas notifikasi sistem "Chapter 64 · Series — 61%").
 */
function usePendingRuns(): DlRun[] {
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
  return pendingOf(runs)
}

/** Kartu per SERIES untuk setiap proses yang sedang jalan (+ tombol Batal). */
function ActiveDownloads({ runs }: { runs: DlRun[] }) {
  if (runs.length === 0) return null
  return (
    <div className="mb-4 space-y-2.5">
      <p className="text-[11.5px] font-semibold text-ink-400">Sedang diunduh</p>
      {runs.map((run) => {
        const total = run.jobs.length
        const done = run.jobs.filter((j) => j.state === 'ok').length
        const fail = run.jobs.filter((j) => j.state === 'fail').length
        const failMsg = run.jobs.find((j) => j.state === 'fail' && j.error)?.error
        const pct = total > 0 ? Math.round((done / total) * 100) : 0
        const current =
          run.jobs.find((j) => j.state === 'run') ?? run.jobs.find((j) => j.state === 'wait')
        return (
          <div key={run.handle} className="rounded-xl border border-brand-amber-dim bg-ink-900 p-3">
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0">
                <p className="truncate text-[13px] font-semibold text-ink-100">{run.seriesTitle}</p>
                <p className="text-[11.5px] text-ink-400">
                  {done}/{total} chapter
                  {current ? ` · Chapter ${current.number}` : ''} · {pct}%
                  {run.mode === 'pdf' && run.saved ? ` · ${run.saved} PDF terkirim` : ''}
                </p>
                {fail > 0 && (
                  <p className="mt-0.5 truncate text-[11px] text-brand-red">
                    {fail} gagal{failMsg ? ` · ${failMsg}` : ''}
                  </p>
                )}
              </div>
              <button
                onClick={() => void loadStore().then((s) => s?.cancelRun(run.handle))}
                className="shrink-0 rounded-lg border border-ink-700 px-3 py-1.5 text-[11.5px] font-semibold text-ink-300"
              >
                Batal
              </button>
            </div>
            <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-ink-800">
              <div className="h-full rounded-full bg-brand-amber" style={{ width: `${pct}%` }} />
            </div>
          </div>
        )
      })}
    </div>
  )
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
    g.items.push(d)
    g.bytes += d.size_bytes
  }
  const newestAt = (g: SeriesGroup) =>
    g.items.reduce((a, d) => Math.max(a, d.downloaded_at ?? 0), 0)
  return groups.sort((a, b) => newestAt(b) - newestAt(a))
}

function DownloadsTab() {
  const [data, setData] = useState<DownloadsResponse | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  // buka/tutup kartu series; default terbuka kalau <=3 chapter
  const [openOverride, setOpenOverride] = useState<Record<string, boolean>>({})
  const pending = usePendingRuns()

  const load = () => {
    setError(null)
    unifiedApi
      .downloads()
      .then(setData)
      .catch((e: Error) => setError(e.message))
  }

  useEffect(() => {
    load()
  }, [])

  const items = data?.items ?? []
  const groups = groupBySeries(items)

  return (
    <div>
      {/* proses unduhan yang masih jalan (lintas halaman) */}
      <ActiveDownloads runs={pending} />

      {error && (
        <p className="mb-3 rounded-xl border border-brand-red/40 bg-brand-red/10 px-3 py-2 text-[12px] text-brand-red">
          {error}
        </p>
      )}

      {busy && !data && <Spinner label="Memuat unduhan…" />}

      {items.length === 0 && !busy && (
        <Empty
          title="Belum ada unduhan"
          body={'Buka halaman series, centang chapter, tekan "Unduh PDF".'}
        />
      )}

      <ul className="space-y-2.5">
        {groups.map((g) => {
          const open = openOverride[g.handle] ?? defaultOpen(g)
          return (
            <li key={g.handle} className="rounded-xl border border-ink-800 bg-ink-900">
              <button
                onClick={() => setOpenOverride((o) => ({ ...o, [g.handle]: !open }))}
                aria-expanded={open}
                className="flex w-full items-center gap-2.5 p-3 text-left"
              >
                <IconArrowRight
                  className={`size-3.5 shrink-0 text-ink-400 transition-transform ${
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
                  {g.items.map((d) => (
                    <li key={d.id} className="flex flex-wrap items-center gap-2 px-3 py-2.5">
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-[12.5px] text-ink-100">
                          {d.title || `Chapter ${d.number}`}
                        </span>
                        <span className="block text-[11.5px] text-ink-400">
                          {humanSize(d.size_bytes)}
                          {d.downloaded_at != null &&
                            ` · ${new Date(d.downloaded_at).toLocaleDateString('id-ID')}`}
                        </span>
                      </span>
                      <a
                        href={unifiedApi.downloadFileUrl(d.id, d.filename)}
                        target="_blank"
                        rel="noreferrer noopener"
                        className="rounded-lg bg-brand-amber px-3 py-1.5 text-[11.5px] font-bold text-ink-950"
                      >
                        Baca
                      </a>
                      <a
                        href={unifiedApi.downloadFileUrl(d.id, d.filename)}
                        download={d.filename || 'chapter.pdf'}
                        className="rounded-lg border border-ink-700 px-3 py-1.5 text-[11.5px] font-semibold text-ink-300"
                      >
                        Unduh lagi
                      </a>
                      <button
                        disabled={busy}
                        onClick={() => {
                          const label = d.title || `Chapter ${d.number}`
                          if (!window.confirm(`Hapus unduhan ${g.title} — ${label}?`)) return
                          setBusy(true)
                          unifiedApi
                            .deleteDownload(d.id)
                            .then(() => load())
                            .catch((e: Error) => setError(e.message))
                            .finally(() => setBusy(false))
                        }}
                        className="rounded-lg border border-brand-red/50 px-3 py-1.5 text-[11.5px] font-semibold text-brand-red disabled:opacity-60"
                      >
                        Hapus
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </li>
          )
        })}
      </ul>
    </div>
  )
}

