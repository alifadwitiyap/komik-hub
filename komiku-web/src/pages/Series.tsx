import { imgUrl } from '../imgUrl'
import { useEffect, useMemo, useRef, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { api } from '../api'
import {
  cancelRun,
  getRuns,
  runBusy,
  startRun,
  subscribeRuns,
} from '../downloadStore'
import type { DlRun } from '../downloadStore'
import type { Chapter, SeriesDetail } from '../types'
import { Empty, Spinner } from '../App'
import HeartButton from '../components/HeartButton'
import { useProgress } from '../hooks/useProgress'
import { marathonHref, readerHref } from '../readerSource'

type SeriesData = {
  series: SeriesDetail
  chapters: Chapter[]
  related: Chapter[]
}

/** Maksimal chapter terpilih per unduhan (spek parity Komiku+). */
const BATCH_MAX = 30

/** Detail manga: sampul, metadata, lalu daftar chapter terbaru di atas.
 *
 * Route /manga/:handle melayani DUA flow: id angka komiku (halaman ini) dan
 * handle unified 'sumber:native_id' (diarahkan ke SeriesUnified oleh
 * SeriesRoute di App.tsx). Param bernama `handle` supaya satu pola route
 * cukup untuk keduanya. */
export default function Series() {
  const { handle } = useParams<{ handle: string }>()
  const id = handle ?? ''
  const [data, setData] = useState<SeriesData | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [showAll, setShowAll] = useState(false)
  const { recent } = useProgress()
  // --- flow unduh range (paritas Komiku+): 2-tap Awal/Akhir ---------------
  // Handle download legacy: kontrak unified butuh 'sumber:native_id' →
  // 'komiku:<id angka>'. Halaman ini hanya dilayani untuk id angka (App.tsx
  // mengarahkan handle ber-':' ke SeriesUnified).
  const dlHandle = /^\d+$/.test(id) ? `komiku:${id}` : null
  const [pickMode, setPickMode] = useState(false)
  /** index tampil anchor "Awal" dan "Akhir" di `chapters` (inklusif). */
  const [anchor, setAnchor] = useState<number | null>(null)
  const [rangeEnd, setRangeEnd] = useState<number | null>(null)
  const [dlMsg, setDlMsg] = useState<string | null>(null)
  // Progres unduhan tinggal di downloadStore (module-level): batch tetap
  // jalan + terlihat walau user pindah halaman. Halaman ini cuma subscribe.
  const [runs, setRuns] = useState<DlRun[]>([])
  useEffect(() => {
    const sync = (r: DlRun[]) => setRuns(r)
    const unsub = subscribeRuns(sync)
    sync(getRuns())
    return unsub
  }, [])
  /**
   * true selama komponen ter-pasang. Unduhan SENGAJA tidak di-abort saat
   * unmount (navigasi ke reader): batch jalan di closure-nya sendiri dan
   * hasilnya tetap masuk store server + muncul di Rak. State setelah
   * unmount adalah no-op di React 18, jadi aman.
   */
  const mountedRef = useRef(true)
  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])
  const navigate = useNavigate()

  useEffect(() => {
    if (!id) return
    const ctrl = new AbortController()
    setData(null)
    setError(null)
    setShowAll(false)
    setPickMode(false)
    setAnchor(null)
    setRangeEnd(null)
    setDlMsg(null)
    api
      .series(id, ctrl.signal)
      .then(setData)
      .catch((e: Error) => e.name !== 'AbortError' && setError(e.message))
    return () => {
      // Hanya fetch halaman yang dibatalkan saat keluar; unduhan yang masih
      // jalan dibiarkan hidup (hanya tombol Batal yang membatalkannya) —
      // batch jalan di closure-nya sendiri dan hasilnya tetap masuk store.
      ctrl.abort()
    }
  }, [id])

  // Semua hook HARUS di atas early return (Rules of Hooks): kalau useMemo
  // diletakkan setelah `if (!data) return`, urutan hook berubah antar render.
  const genres = useMemo(() => data?.series.genre ?? [], [data])
  const statusNames = useMemo(
    () => (data?.series.statusmanga ?? []).map((x) => x.name),
    [data],
  )
  const tipeNames = useMemo(() => (data?.series.tipe ?? []).map((x) => x.name), [data])
  const rangeList = useMemo(() => {
    if (anchor == null || rangeEnd == null) return []
    const step = rangeEnd >= anchor ? 1 : -1
    const out: number[] = []
    for (let i = anchor; i !== rangeEnd + step; i += step) out.push(i)
    return out
  }, [anchor, rangeEnd])
  // Run unduhan milik series ini (store module-level; hidup lintas halaman).
  const run = runs.find((r) => r.handle === dlHandle) ?? null
  const dlBusy = run ? runBusy(run) : false
  /** guard sekali per run: pesan 'selesai' + deep-link tak diulang. */
  const handledRunAtRef = useRef<number | null>(null)
  const wasBusyRef = useRef(false)
  // Transisi run aktif -> selesai saat halaman ini masih terbuka: kabari
  // sekali + deep-link ke Rak. Kalau user sudah pergi, Rak (yang subscribe
  // store yang sama) yang menunjukkan progres — gak ada yang ditarik balik.
  useEffect(() => {
    if (wasBusyRef.current && !dlBusy && run && handledRunAtRef.current !== run.startedAt) {
      handledRunAtRef.current = run.startedAt
      if (mountedRef.current) {
        const failed = run.jobs.filter((j) => j.state === 'fail').length
        const cancels = run.jobs.filter((j) => j.error === 'Dibatalkan').length
        const msg =
          cancels > 0 && cancels === failed
            ? 'Unduhan dibatalkan.'
            : failed > 0
              ? `${run.jobs.length - failed} selesai, ${failed} gagal — yang berhasil tetap tersimpan.`
              : 'Unduhan selesai.'
        setDlMsg(msg)
        navigate('/rak?tab=unduhan', { state: { flash: msg } })
      }
    }
    wasBusyRef.current = dlBusy
  }, [dlBusy, run, navigate])

  if (error) return <Empty title="Gagal memuat manga" body={error} />
  if (!data) return <Spinner label="Memuat manga…" />

  const { series: s, chapters } = data
  // chapters terurut TERBARU -> TERLAMA. Untuk maraton kita mulai dari paling awal
  // supaya auto-advance benar-benar berjalan, bukan langsung ketemu "Tuntas".
  const oldest = chapters.length > 0 ? chapters[chapters.length - 1] : null
  // rentang terpilih membentang > 40 chapter: perluas daftar supaya yang
  // terpilih benar-benar terlihat (bukan cuma sebagian). Tetap terpancar
  // selama unduhan berjalan walau mode pilih sudah keluar.
  const expanded = showAll || (anchor != null && rangeEnd != null) || dlBusy
  const visible = expanded ? chapters : chapters.slice(0, 40)
  const resume = recent.find((r) => String(r.seriesId) === String(id))

  const pickedChapters = rangeList.map((i) => chapters[i]).filter(Boolean)
  const downloadable = pickedChapters.filter((c) => chapterNumber(c) != null)
  const selCount = anchor == null ? 0 : rangeEnd == null ? 1 : pickedChapters.length
  const dlCount = Math.min(selCount, BATCH_MAX)

  let hint: string | null = null
  if (pickMode) {
    if (anchor == null) hint = 'Tap chapter awal, lalu chapter akhir.'
    else if (rangeEnd == null) hint = 'Pilih chapter akhir.'
    else if (pickedChapters.length > BATCH_MAX)
      hint = `Maksimal ${BATCH_MAX} chapter — ${BATCH_MAX} pertama yang diambil`
    else hint = `${chapters[anchor].name} → ${chapters[rangeEnd].name}`
  }

  const togglePickMode = () => {
    if (dlBusy) return
    setPickMode((v) => !v)
    setAnchor(null)
    setRangeEnd(null)
    setDlMsg(null)
  }

  /** Tap daftar chapter: pertama = Awal, kedua = Akhir; ketiga = Awal baru. */
  const pickRange = (i: number) => {
    setDlMsg(null)
    if (anchor == null) {
      setAnchor(i)
      setRangeEnd(null)
    } else if (rangeEnd == null) {
      setRangeEnd(i)
    } else {
      setAnchor(i)
      setRangeEnd(null)
    }
  }

  const startDownload = () => {
    if (dlBusy || rangeList.length === 0 || !dlHandle) return
    // chapter tanpa nomor yang bisa diparse = dilewati, jangan dikarang
    const skipped = pickedChapters.length - downloadable.length
    if (downloadable.length === 0) {
      setDlMsg('Chapter terpilih tidak punya nomor yang bisa diunduh.')
      return
    }
    const numbers = downloadable.slice(0, BATCH_MAX).map((c) => chapterNumber(c) as string)
    // Keluar dari mode pilih SEGERA: baris chapter kembali jadi Link ke
    // reader dan tombol Unduh tak lagi tertekan (aria-pressed=false).
    // Unduhan tetap jalan di background (downloadStore) — hanya Batal yang
    // membatalkan; progres terlihat dari halaman mana pun (Rak → Unduhan).
    setPickMode(false)
    setAnchor(null)
    setRangeEnd(null)
    setDlMsg(skipped > 0 ? `${skipped} chapter dilewati: nomor tak terbaca` : null)
    startRun(dlHandle, data?.series.title ?? id, numbers)
  }

  // Tombol baca utama mengikuti riwayat:
  // - sudah pernah baca  -> "Baca <chapter sebelumnya>" (chapter tepat sebelum
  //   yang terakhir dibaca = yang belum dibaca berikutnya)
  // - habis chapter 1     -> "Baca Ulang" chapter itu
  // - belum pernah baca   -> mulai dari Chapter 1 (paling awal)
  const readIdx = resume
    ? chapters.findIndex((c) => String(c.id) === String(resume.chapterId))
    : -1
  let cta: { label: string; to: string } | null = null
  if (oldest) {
    if (readIdx >= 0 && readIdx < chapters.length - 1) {
      const prev = chapters[readIdx + 1]
      cta = { label: `Baca ${prev.name}`, to: readerHref(String(prev.id)) }
    } else if (readIdx >= 0) {
      cta = {
        label: `Baca Ulang ${chapters[readIdx].name}`,
        to: readerHref(String(chapters[readIdx].id)),
      }
    } else {
      cta = { label: `Baca ${oldest.name}`, to: readerHref(String(oldest.id)) }
    }
  }

  /** Tanda rentang sebuah baris: anchor vs di-dalam-rentang. */
  const markOf = (i: number): RowMark => {
    if (anchor == null) return 'plain'
    if (rangeEnd == null) return i === anchor ? 'start' : 'plain'
    if (i === anchor) return 'start'
    if (i === rangeEnd) return 'end'
    return (i - anchor) * (i - rangeEnd) < 0 ? 'mid' : 'plain'
  }

  return (
    <div className="mx-auto max-w-3xl">
      {/* Hero sampul */}
      <div className="relative">
        {s.cover && (
          <div className="absolute inset-0 h-56 overflow-hidden">
            <img src={imgUrl(s.cover)} alt="" className="size-full object-cover opacity-25 blur-md" />
            <div className="absolute inset-0 bg-gradient-to-b from-ink-950/60 to-ink-950" />
          </div>
        )}

        <div className="relative px-4 pb-4 pt-5">
          <Link to="/" className="text-[12px] font-medium text-ink-400 hover:text-ink-200">
            ← Beranda
          </Link>

          <div className="mt-3 flex gap-4">
            <div className="w-28 shrink-0 sm:w-32">
              <div className="aspect-[3/4] overflow-hidden rounded-xl border border-ink-700 bg-ink-850 shadow-lg">
                {s.thumbnail ? (
                  <img src={imgUrl(s.thumbnail)} alt={s.title} className="size-full object-cover" />
                ) : (
                  <span className="grid size-full place-items-center p-2 text-center text-[11px] text-ink-500">
                    {s.title}
                  </span>
                )}
              </div>
            </div>

            <div className="min-w-0 flex-1">
              <h1 className="text-lg font-bold leading-tight text-ink-100">{s.title}</h1>
              {s.title_alt && s.title_alt !== s.title && (
                <p className="mt-0.5 text-[12px] text-ink-400">{s.title_alt}</p>
              )}

              <dl className="mt-2.5 space-y-1 text-[12px]">
                <Meta label="Penulis" value={s.author} />
                <Meta label="Status" value={statusNames.join(', ')} />
                <Meta label="Tipe" value={tipeNames.join(', ')} />
                {s.score && s.score !== '-' && <Meta label="Skor" value={`★ ${s.score}`} />}
              </dl>

              {genres.length > 0 && (
                <div className="mt-2.5 flex flex-wrap gap-1.5">
                  {genres.map((g) => (
                    <span
                      key={g.id}
                      className="rounded-full bg-brand-amber/10 px-2.5 py-0.5 text-[10.5px] font-semibold text-brand-amber"
                    >
                      {g.name}
                    </span>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* Tombol baca */}
      <div className="sticky top-14 z-30 border-y border-ink-800 bg-ink-950/95 px-4 py-2.5 backdrop-blur">
        <div className="flex gap-2">
          {cta && (
            <>
              <Link
                to={cta.to}
                className="flex-1 rounded-xl bg-brand-amber py-2.5 text-center text-[13px] font-bold text-ink-950 transition-colors hover:bg-brand-amber-soft"
              >
                {cta.label}
              </Link>
              {/* unduh PDF: aktifkan mode pilih rentang Awal/Akhir di daftar chapter */}
              {dlHandle && (
                <button
                  type="button"
                  onClick={togglePickMode}
                  disabled={dlBusy}
                  aria-pressed={pickMode}
                  aria-label="Unduh chapter"
                  className={`flex items-center gap-1.5 rounded-xl px-3.5 py-2.5 text-[13px] font-bold transition-colors disabled:opacity-50 ${
                    pickMode
                      ? 'bg-brand-amber-soft text-ink-950 ring-2 ring-brand-amber/50'
                      : 'bg-brand-amber text-ink-950 hover:bg-brand-amber-soft'
                  }`}
                >
                  <IconDownload className="size-4" />
                  Unduh
                </button>
              )}
              {oldest && (
                <Link
                  to={marathonHref(String(oldest.id))}
                  title={`Mulai maraton dari ${oldest.name}`}
                  className="rounded-xl border border-brand-amber-dim px-3.5 py-2.5 text-center text-[13px] font-semibold text-brand-amber transition-colors hover:bg-brand-amber-dim/20"
                >
                  Maraton
                </Link>
              )}
              {/* favorit — identitas dari server (title_key), handle = id lama */}
              {s.title_key && (
                <HeartButton
                  labeled
                  manga={{
                    title_key: s.title_key,
                    title: s.title,
                    cover_url: s.thumbnail ?? s.cover ?? null,
                    handle: String(id),
                    source: 'komiku',
                  }}
                />
              )}
            </>
          )}
        </div>
        {resume && (
          <Link
            to={readerHref(String(resume.chapterId))}
            className="mt-2 block text-center text-[12px] font-medium text-ink-300 hover:text-brand-amber"
          >
            Lanjut dari {resume.chapterName} · halaman {resume.page + 1}
          </Link>
        )}
      </div>

      {/* Sinopsis */}
      {s.synopsis && (
        <section className="px-4 py-4">
          <h2 className="mb-1.5 text-[13px] font-semibold text-ink-100">Sinopsis</h2>
          <p className="text-[12.5px] leading-relaxed text-ink-300">{s.synopsis}</p>
        </section>
      )}

      {/* Daftar chapter */}
      <section className="px-4 pb-6">
        <h2 className="mb-2 text-[13px] font-semibold text-ink-100">
          Chapter <span className="text-ink-500">({chapters.length})</span>
        </h2>

        {/* Info seleksi + progres unduh (tetap tampil setelah run selesai) */}
        {(pickMode || run || dlMsg) && (
          <div className="mb-3 rounded-xl border border-ink-800 bg-ink-900 p-3">
            {pickMode && (
              <div className="flex items-center justify-between gap-2">
                <p className="text-[12px] font-semibold text-ink-200">
                  {selCount} dipilih <span className="text-ink-500">· maks {BATCH_MAX}</span>
                </p>
                <button
                  type="button"
                  onClick={startDownload}
                  disabled={dlBusy || rangeEnd == null || downloadable.length === 0}
                  className="rounded-lg bg-brand-amber px-3 py-1.5 text-[11.5px] font-bold text-ink-950 disabled:opacity-50"
                >
                  {dlBusy ? 'Mengunduh…' : `Unduh (${dlCount})`}
                </button>
              </div>
            )}
            {hint && <p className="mt-1.5 text-[11px] text-ink-400">{hint}</p>}
            {dlMsg && <p className="mt-1 text-[11px] font-medium text-brand-amber">{dlMsg}</p>}
            {/* Sedang berjalan: satu kartu ringkas + tombol Batal (tanpa daftar
                panjang). Data dari downloadStore — tetap tampil walau user
                sedang di halaman ini; Kalau pindah, progres lanjut di Rak. */}
            {run && dlBusy && (
              <div className="mt-2 rounded-lg border border-ink-800 bg-ink-850 p-2.5">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="text-[12px] font-semibold text-ink-100">Mengunduh</p>
                    <p className="truncate text-[11px] text-ink-300">
                      {run.jobs.length === 1
                        ? `Chapter ${run.jobs[0].number}`
                        : `Chapter ${run.jobs[0].number}–${run.jobs[run.jobs.length - 1].number}`}
                    </p>
                    <p className="mt-0.5 text-[10.5px] text-ink-500">
                      {run.jobs.filter((j) => j.state === 'ok' || j.state === 'fail').length}/
                      {run.jobs.length} chapter
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={() => dlHandle && cancelRun(dlHandle)}
                    className="shrink-0 rounded-lg border border-ink-700 px-2.5 py-1 text-[11px] font-bold text-ink-200 transition-colors hover:bg-ink-800"
                  >
                    Batal
                  </button>
                </div>
                <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-ink-800">
                  <div
                    className="h-full rounded-full bg-brand-amber transition-[width] duration-500"
                    style={{
                      width: `${Math.round(
                        (run.jobs.filter((j) => j.state === 'ok' || j.state === 'fail').length /
                          run.jobs.length) *
                          100,
                      )}%`,
                    }}
                  />
                </div>
              </div>
            )}
          </div>
        )}

        {chapters.length === 0 ? (
          <p className="text-[12.5px] text-ink-500">Belum ada chapter.</p>
        ) : (
          <ul className="divide-y divide-ink-800 overflow-hidden rounded-xl border border-ink-800 bg-ink-900">
            {visible.map((c, i) => (
              <ChapterRow
                key={c.id}
                chapter={c}
                mark={pickMode ? markOf(i) : undefined}
                onPick={pickMode ? () => pickRange(i) : undefined}
              />
            ))}
          </ul>
        )}

        {chapters.length > 40 && (
          <button
            onClick={() => setShowAll((v) => !v)}
            className="mt-3 w-full rounded-xl border border-ink-700 py-2.5 text-[13px] font-medium text-ink-300"
          >
            {showAll ? 'Tampilkan lebih sedikit' : `Tampilkan semua ${chapters.length} chapter`}
          </button>
        )}
      </section>
    </div>
  )
}

function Meta({ label, value }: { label: string; value?: string | null }) {
  if (!value) return null
  return (
    <div className="flex gap-2">
      <dt className="w-16 shrink-0 text-ink-500">{label}</dt>
      <dd className="min-w-0 flex-1 truncate text-ink-200">{value}</dd>
    </div>
  )
}

type RowMark = 'plain' | 'start' | 'mid' | 'end'

/**
 * Nomor chapter untuk kontrak download-pdf: field `number` dari daftar
 * legacy (string), atau parse dari nama ("Chapter 45.1" → "45.1"). null =
 * chapter ini tak bisa diunduh — jangan dikarang.
 */
function chapterNumber(c: Chapter): string | null {
  const n = c.number
  if (n != null && String(n).trim() !== '') return String(n).trim()
  const m = /chapter\s*([0-9]+(?:\.[0-9]+)?)/i.exec(c.name ?? '')
  return m ? m[1] : null
}

function ChapterRow({
  chapter,
  mark = 'plain',
  onPick,
}: {
  chapter: Chapter
  /** undefined = mode baca biasa (baris = link ke reader). */
  mark?: RowMark
  onPick?: () => void
}) {
  const isAnchor = mark === 'start' || mark === 'end'
  const cls = `flex w-full items-center justify-between gap-3 px-3.5 py-3 text-left transition-colors ${
    isAnchor
      ? 'bg-brand-amber/15 ring-1 ring-inset ring-brand-amber/50'
      : mark === 'mid'
        ? 'bg-brand-amber/10'
        : 'hover:bg-ink-850 active:bg-ink-850'
  }`
  const body = (
    <>
      <span className="min-w-0 flex-1 truncate text-[13px] font-semibold text-ink-100">
        {chapter.name}
      </span>
      {isAnchor && (
        <span className="shrink-0 rounded-full bg-brand-amber px-1.5 py-0.5 text-[9.5px] font-bold text-ink-950">
          {mark === 'start' ? 'Awal' : 'Akhir'}
        </span>
      )}
      <span className="shrink-0 text-[10.5px] font-medium text-ink-500">
        {chapter.date?.trim()}
      </span>
    </>
  )
  if (onPick) {
    return (
      <li>
        <button type="button" onClick={onPick} className={cls} aria-pressed={isAnchor}>
          {body}
        </button>
      </li>
    )
  }
  return (
    <li>
      <Link to={readerHref(String(chapter.id))} className={cls}>
        {body}
      </Link>
    </li>
  )
}

/** Ikon unduh (panah ke bawah + baki) — inline supaya icons.tsx tak diubah. */
function IconDownload({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      <path d="M12 3v12" />
      <path d="m7 10 5 5 5-5" />
      <path d="M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2" />
    </svg>
  )
}
