import { ensureDownloadReturn } from '../downloadReturn'
import { imgUrl } from '../imgUrl'
import { useEffect, useMemo, useState } from 'react'
import { Link, useLocation, useNavigate, useParams } from 'react-router-dom'
import { api } from '../api'
import { getUser } from '../account'
import {
  cancelRun,
  startRun,
  startRunCache,
  jobTally,
  progressPct,
  runProgress,
} from '../downloadStore'
import type { Chapter, SeriesDetail } from '../types'
import { Empty, Spinner } from '../App'
import HeartButton from '../components/HeartButton'
import { useDownloadRun, useOffline, retryRun } from '../hooks/useDownloadRun'
import { friendlyError } from '../downloadBatch'
import { useSeriesResume } from '../hooks/useSeriesResume'
import { sortByChapterNumber } from '../chapterOrder'
import { chapterNumberOf } from '../readMarks'
import { useReadMarks } from '../hooks/useReadMarks'
import { marathonHref, readerHref } from '../readerSource'
import ChapterJumpSearch from '../components/ChapterJumpSearch'

type SeriesData = {
  series: SeriesDetail
  chapters: Chapter[]
  related: Chapter[]
}

/** Maksimal chapter terpilih per unduhan (spek parity Komiku+). */
const BATCH_MAX = 30

// Halaman /akun mengganti halaman series sehingga listener React di komponen
// tidak lagi hidup saat login selesai. Listener modul (downloadReturn) tetap
// aktif dan mengembalikan user ke URL yang disimpan sebelum navigasi.
ensureDownloadReturn()

/** Detail manga: sampul, metadata, lalu daftar chapter terbaru di atas.
 *
 * Route /manga/:handle melayani DUA flow: id angka komiku (halaman ini) dan
 * handle unified 'sumber:native_id' (diarahkan ke SeriesUnified oleh
 * SeriesRoute di App.tsx). Param bernama `handle` supaya satu pola route
 * cukup untuk keduanya. */
export default function Series() {
  const { handle } = useParams<{ handle: string }>()
  const id = handle ?? ''
  const navigate = useNavigate()
  const [data, setData] = useState<SeriesData | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [showAll, setShowAll] = useState(false)
  // Mark "sudah dibaca" per akun: chapter yang pernah dibuka user jadi abu.
  // Kunci = title_key series + nomor chapter. title_key legacy di-suntik
  // server (routes.rs) dan nilainya sama dengan title_key unified untuk
  // judul yang sama → mark nyambung lintas kedua flow.
  const { isRead, count: readTotal } = useReadMarks(data?.series.title_key ?? null)
  // --- flow unduh range (paritas Komiku+): 2-tap rentang --------------------
  // Handle download legacy: kontrak unified butuh 'sumber:native_id' →
  // 'komiku:<id angka>'. Halaman ini hanya dilayani untuk id angka (App.tsx
  // mengarahkan handle ber-':' ke SeriesUnified).
  const dlHandle = /^\d+$/.test(id) ? `komiku:${id}` : null
  const [pickMode, setPickMode] = useState(false)
  const [showDlType, setShowDlType] = useState(false)
  /** index tampil anchor ujung rentang di `chapters` (inklusif, urutan tap bebas). */
  const [anchor, setAnchor] = useState<number | null>(null)
  const [rangeEnd, setRangeEnd] = useState<number | null>(null)
  const [dlMsg, setDlMsg] = useState<string | null>(null)
  // Cover yang gagal dimuat (host mati / 403 / DNS hilang) → tampilkan judul,
  // bukan ikon gambar rusak.
  const [coverFailed, setCoverFailed] = useState(false)
  const [reloadKey, setReloadKey] = useState(0)
  const location = useLocation()
  const selectionKey = `komik:download-selection:${dlHandle}`
  const returnKey = `komik:download-return:${dlHandle}`

  useEffect(() => {
    if (!data || !dlHandle) return
    try {
      const raw = sessionStorage.getItem(selectionKey)
      if (!raw) return
      sessionStorage.removeItem(selectionKey)
      const saved = JSON.parse(raw) as { start: string | null; end: string | null; showAll: boolean }
      const chapters = data.chapters
      const start = saved.start === null ? -1 : chapters.findIndex((c) => chapterNumber(c) === saved.start)
      const end = saved.end === null ? -1 : chapters.findIndex((c) => chapterNumber(c) === saved.end)
      setPickMode(true)
      setShowAll(saved.showAll || start >= 40 || end >= 40)
      setAnchor(start >= 0 ? start : null)
      setRangeEnd(end >= 0 ? end : null)
      if ((saved.start !== null && start < 0) || (saved.end !== null && end < 0)) {
        setDlMsg('Seleksi sebelumnya tidak bisa dipulihkan — pilih ulang chapter.')
      }
    } catch {
      setDlMsg('Seleksi sebelumnya tidak bisa dipulihkan — pilih ulang chapter.')
    }
  }, [data, dlHandle, selectionKey])

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
    // Lambat/tanpa respons: abort setelah 15 dtk supaya Spinner
    // "Memuat manga…" tidak menggantung selamanya.
    const timer = setTimeout(() => ctrl.abort(new DOMException('Waktu habis', 'TimeoutError')), 15_000)
    api
      .series(id, ctrl.signal)
      .then(setData)
      .catch((e: Error) => {
        if (e.name === 'AbortError') return
        setError(e.name === 'TimeoutError' ? 'Server tidak merespons — coba lagi.' : friendlyError(e))
      })
    return () => {
      clearTimeout(timer)
      // Hanya fetch halaman yang dibatalkan saat keluar; unduhan yang masih
      // jalan dibiarkan hidup (hanya tombol Batal yang membatalkannya) —
      // batch jalan di closure-nya sendiri dan hasilnya tetap masuk store.
      ctrl.abort()
    }
  }, [id, reloadKey])

  // Semua hook HARUS di atas early return (Rules of Hooks): kalau useMemo
  // diletakkan setelah `if (!data) return`, urutan hook berubah antar render.
  const genres = useMemo(() => data?.series.genre ?? [], [data])
  const statusNames = useMemo(
    () => (data?.series.statusmanga ?? []).map((x) => x.name),
    [data],
  )
  const tipeNames = useMemo(() => (data?.series.tipe ?? []).map((x) => x.name), [data])
  // chapters terurut TERBARU -> TERLAMA. Satu aturan yang sama dipakai tombol
  // mulai, daftar, dan lanjut/next. Maraton mulai dari paling awal supaya
  // auto-advance benar-benar berjalan, bukan langsung ketemu "Tuntas".
  const rawChapters = data?.chapters ?? []
  const chapters = useMemo(
    () => sortByChapterNumber(rawChapters, (c) => chapterNumberOf(c) ?? '', 'terbaru'),
    [rawChapters],
  )
  const rangeList = useMemo(() => {
    if (anchor == null || rangeEnd == null) return []
    const step = rangeEnd >= anchor ? 1 : -1
    const out: number[] = []
    for (let i = anchor; i !== rangeEnd + step; i += step) out.push(i)
    return out
  }, [anchor, rangeEnd])
  // Wiring unduhan batch + resume/maraton — hook bersama (useDownloadRun,
  // useSeriesResume) yang mengabstraksi subscribe downloadStore + transisi
  // run aktif → selesai, dan pemilihan target link reader/maraton.
  const { run, busy: dlBusy, slow: dlSlow, stale: dlStale } = useDownloadRun(dlHandle, (finishedRun) => {
    const ok = finishedRun.jobs.filter((j) => j.state === 'ok').length
    const failed = finishedRun.jobs.filter((j) => j.state === 'fail').length
    const cancels = finishedRun.jobs.filter((j) => j.error === 'Dibatalkan').length
    const realFailed = failed - cancels
    // PDF = file dihasilkan server + diunduh perangkat; cache = byte gambar
    // masuk Cache Storage (offline reader). Lokasi akhir JANGAN diklaim —
    // cuma sebut tempat mengambilnya (Rak → Unduhan / offline reader).
    const isCache = finishedRun.mode === 'cache'
    const msg =
      cancels > 0 && cancels === failed
        ? 'Unduhan dibatalkan.'
        : realFailed > 0
          ? isCache
            ? `${ok} tersimpan, ${realFailed} gagal`
            : `${ok} PDF siap diambil, ${realFailed} gagal`
          : isCache
            ? `${ok} chapter tersimpan offline`
            : `${ok} PDF siap diambil — lihat di Rak → Unduhan`
    setDlMsg(msg)
  })
  const offline = useOffline()
  /** Retry failed chapters from the last run (clears old summary). */
  const handleRetry = () => {
    setDlMsg(null)
    if (dlHandle) retryRun(dlHandle)
  }
  const { resume, marathonPos, resumeHref, marathonHref: marathonLink, label } =
    useSeriesResume(id)

  if (error) return (
    <div className="mx-auto max-w-3xl px-4 py-16 text-center">
      <Empty title="Gagal memuat manga" body={error} icon="📡" />
      <button
        type="button"
        onClick={() => setReloadKey((k) => k + 1)}
        className="mt-4 min-h-11 rounded-xl bg-brand-amber px-5 py-2.5 text-[13px] font-bold text-white transition-colors active:scale-[0.97] active:duration-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-amber focus-visible:ring-offset-2 [@media(hover:hover)]:hover:bg-brand-amber-soft"
      >
        Muat ulang
      </button>
    </div>
  )
  if (!data) return <Spinner label="Memuat manga…" />

  const { series: s } = data (Fix reading progress, chapter order, image retry and reader motion)
  const oldest = chapters.length > 0 ? chapters[chapters.length - 1] : null
  // rentang terpilih membentang > 40 chapter: perluas daftar supaya yang
  // terpilih benar-benar terlihat (bukan cuma sebagian). Tetap terpancar
  // selama unduhan berjalan walau mode pilih sudah keluar.
  const expanded = showAll || (anchor != null && rangeEnd != null) || dlBusy
  const visible = expanded ? chapters : chapters.slice(0, 40)

  // Indeks yang menunjuk di luar daftar (data menyusut / indeks basi) —
  // diperingatkan, bukan diam-diam dibuang.
  const outOfRange = rangeList.filter((i) => chapters[i] === undefined).length
  const pickedChapters = rangeList.map((i) => chapters[i]).filter(Boolean)
  const downloadable = pickedChapters.filter((c) => chapterNumber(c) != null)
  const selCount = anchor == null ? 0 : rangeEnd == null ? 1 : pickedChapters.length
  const dlCount = Math.min(selCount, BATCH_MAX)

  let hint: string | null = null
  if (pickMode) {
    if (anchor == null) hint = 'Tap dua chapter — semua di antaranya ikut terpilih, urutan bebas.'
    else if (rangeEnd == null) hint = 'Tap chapter kedua untuk menyelesaikan rentang.'
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

  /** Tap daftar chapter: pertama = satu ujung rentang, kedua = ujung lainnya; ketiga = mulai lagi. */
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

  /** Simpan seleksi lalu ke /akun; setelah masuk, listener 'account-change'
   *  mengembalikan user ke halaman ini dan effect restore memulihkan rentang. */
  const signInForDownload = () => {
    const back = location.pathname + location.search + location.hash
    if (anchor !== null && rangeEnd !== null) {
      try {
        sessionStorage.setItem(selectionKey, JSON.stringify({
          start: chapterNumber(chapters[anchor]),
          end: chapterNumber(chapters[rangeEnd]),
          showAll,
        }))
        sessionStorage.setItem(returnKey, back)
      } catch {
        setDlMsg('Seleksi belum bisa disimpan. Izinkan penyimpanan browser sebelum masuk agar seleksi tidak hilang.')
        return
      }
    }
    navigate('/akun', { state: { from: back } })
  }

  const runDownload = (cache: boolean) => {
    if (dlBusy || rangeList.length === 0 || !dlHandle) return
    if (offline) {
      setDlMsg('Tidak ada koneksi internet — tidak bisa mengunduh.')
      return
    }
    if (getUser() === null) {
      signInForDownload()
      return
    }
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
    setDlMsg(
      skipped > 0
        ? `${skipped} chapter dilewati: nomor tak terbaca`
        : cache
          ? null
          : 'Unduhan PDF dimulai — lihat di Rak → Unduhan',
    )
    if (cache) startRunCache(dlHandle, data?.series.title ?? id, numbers)
    else startRun(dlHandle, data?.series.title ?? id, numbers)
  }
  const startDownloadOffline = () => runDownload(true)
  const startDownloadPdf = () => runDownload(false)

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
            <img referrerPolicy="no-referrer" src={imgUrl(s.cover)} alt="" loading="lazy" width={225} height={300} className="size-full object-cover opacity-25 blur-md" />
            <div className="absolute inset-0 bg-gradient-to-b from-ink-950/60 to-ink-950" />
          </div>
        )}

        <div className="relative px-4 pb-4 pt-5">
          {/* py-3.5 memperluas area sentuh ke >=44px; font 13px agar setara halaman unified. */}
          <Link to="/" className="py-3.5 text-[13px] font-medium text-ink-400 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-amber focus-visible:ring-offset-2 [@media(hover:hover)]:hover:text-ink-200">
            ← Beranda
          </Link>

          <div className="mt-3 flex gap-4">
            <div className="w-28 shrink-0 sm:w-32">
              <div className="aspect-[3/4] overflow-hidden rounded-xl border border-ink-700 bg-ink-850 shadow-lg">
                {s.thumbnail && !coverFailed ? (
                  <img referrerPolicy="no-referrer" src={imgUrl(s.thumbnail)} alt={s.title} onError={() => setCoverFailed(true)} className="size-full object-cover" />
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
      <div className="sticky top-[calc(3.5rem+env(safe-area-inset-top))] z-30 border-y border-ink-800 bg-ink-950/95 px-4 py-2.5 backdrop-blur">
        <div className="grid grid-cols-2 gap-2">
          {cta && (
            <>
              <Link
                to={cta.to}
                className="flex min-h-11 flex-1 items-center justify-center rounded-xl bg-brand-amber py-2.5 text-center text-[13px] font-bold text-white transition-colors active:scale-[0.97] active:duration-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-amber focus-visible:ring-offset-2 [@media(hover:hover)]:hover:bg-brand-amber-soft"
              >
                {cta.label}
              </Link>
              {oldest && (
                <Link
                  to={
                    // lanjutkan sesi maraton tersimpan kalau ada (id numerik =
                    // identitas series di flow komiku lama)
                    marathonLink ?? marathonHref(String(oldest.id))
                  }
                  title={
                    marathonPos
                      ? 'Lanjutkan maraton dari posisi terakhir'
                      : `Mulai maraton dari ${oldest.name}`
                  }
                  className="flex min-h-11 items-center justify-center rounded-xl border border-brand-amber-dim px-3.5 py-2.5 text-center text-[13px] font-semibold text-brand-amber transition-colors active:scale-[0.97] active:duration-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-amber focus-visible:ring-offset-2 [@media(hover:hover)]:hover:bg-brand-amber-dim/20"
                >
                  Maraton
                </Link>
              )}
              {/* unduh PDF: aktifkan mode pilih rentang di daftar chapter */}
              {dlHandle && (
                <button
                  type="button"
                  onClick={togglePickMode}
                  disabled={dlBusy || chapters.length === 0}
                  title={chapters.length === 0 ? 'Tidak ada chapter untuk diunduh' : undefined}
                  aria-pressed={pickMode}
                  aria-label="Unduh chapter"
                  className={`flex min-h-11 items-center gap-1.5 rounded-xl px-3.5 py-2.5 text-[13px] font-bold transition-colors active:scale-[0.97] active:duration-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-amber focus-visible:ring-offset-2 disabled:opacity-50 ${
                    pickMode
                      ? 'bg-brand-amber-soft text-ink-100 ring-2 ring-brand-amber/50'
                      : 'bg-brand-amber text-white [@media(hover:hover)]:hover:bg-brand-amber-soft'
                  }`}
                >
                  <IconDownload className="size-4" />
                  Unduh
                </button>
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
            to={resumeHref as string}
            className="mt-2 block min-h-11 content-center text-center text-[12px] font-medium text-ink-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-amber focus-visible:ring-offset-2 [@media(hover:hover)]:hover:text-brand-amber"
          >
            Lanjut dari {label ?? `${resume.chapterName}`} · halaman {resume.page + 1}
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
          {readTotal > 0 && (
            <span className="ml-1.5 font-normal text-ink-500">
              · {readTotal} sudah dibaca
            </span>
          )}
        </h2>

        {/* Info seleksi + progres unduh (tetap tampil setelah run selesai) */}
        {dlHandle && getUser() === null && (
          <div className="mb-3 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-brand-amber-dim bg-brand-amber/10 p-3">
            <div>
              <p className="text-[12px] font-bold text-brand-amber">Masuk untuk mengunduh</p>
              <p className="mt-1 text-[11px] text-ink-300">Seleksi chapter dipertahankan setelah masuk.</p>
            </div>
            <button type="button" onClick={signInForDownload} className="min-h-11 rounded-lg bg-brand-amber px-4 py-2 text-[12px] font-bold text-white">Masuk</button>
          </div>
        )}
        {(pickMode || run || dlMsg) && (
          <div className="mb-3 rounded-xl border border-ink-800 bg-ink-900 p-3">
            {pickMode && (
              <div className="flex items-center justify-between gap-2">
                <p className="text-[12px] font-semibold text-ink-200">
                  {selCount} dipilih <span className="text-ink-500">· maks {BATCH_MAX}</span>
                </p>
                {!showDlType ? (
                  <button
                    type="button"
                    onClick={() => setShowDlType(true)}
                    disabled={dlBusy || rangeEnd == null || downloadable.length === 0}
                    className="min-h-11 min-w-11 rounded-lg bg-brand-amber px-4 py-2.5 text-[12px] font-bold text-white transition-colors active:scale-[0.97] active:duration-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-amber focus-visible:ring-offset-2 disabled:opacity-50"
                  >
                    {dlBusy ? 'Mengunduh…' : `Unduh (${dlCount})`}
                  </button>
                ) : (
                  <div className="flex gap-1.5">
                    <button
                      type="button"
                      onClick={() => {
                        setShowDlType(false)
                        startDownloadOffline()
                      }}
                      disabled={dlBusy}
                      className="min-h-11 min-w-11 rounded-lg border border-brand-amber-dim bg-brand-amber/10 px-4 py-2.5 text-[12px] font-semibold text-brand-amber transition-colors active:scale-[0.97] active:duration-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-amber focus-visible:ring-offset-2 disabled:opacity-50"
                    >
                      Offline
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setShowDlType(false)
                        startDownloadPdf()
                      }}
                      disabled={dlBusy}
                      className="min-h-11 min-w-11 rounded-lg border border-ink-600 px-4 py-2.5 text-[12px] font-semibold text-ink-200 transition-colors active:scale-[0.97] active:duration-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-amber focus-visible:ring-offset-2 [@media(hover:hover)]:hover:bg-ink-850 disabled:opacity-50"
                    >
                      PDF
                    </button>
                  </div>
                )}
              </div>
            )}
            {hint && <p className="mt-1.5 text-[11px] text-ink-400" aria-live="polite">{hint}</p>}
            {dlMsg && <p role="status" aria-live="polite" className="mt-1 text-[11px] font-medium text-brand-amber">{dlMsg}</p>}
            {outOfRange > 0 && (
              <p role="status" aria-live="polite" className="mt-1 text-[11px] font-semibold text-warn">{outOfRange} chapter di luar daftar — akan dilewati saat mengunduh.</p>
            )}
            {/* Offline banner */}
            {offline && (
              <p
                role="alert"
                className="mt-1.5 flex items-center gap-1 text-[11px] font-medium text-warn"
              >
                <span aria-hidden>⚠</span> Tidak ada koneksi internet — unduhan akan gagal
              </p>
            )}
            {/* Retry button: show when last run had non-cancel failures */}
            {!dlBusy && run && run.jobs.some((j) => j.state === 'fail' && j.error !== 'Dibatalkan') && (
              <button
                type="button"
                onClick={handleRetry}
                className="mt-1.5 inline-flex min-h-11 items-center text-[11px] font-semibold text-brand-amber underline"
              >
                Coba lagi chapter gagal
              </button>
            )}
            {/* Sedang berjalan: satu kartu ringkas + tombol Batal (tanpa daftar
                panjang). Data dari downloadStore — tetap tampil walau user
                sedang di halaman ini; Kalau pindah, progres lanjut di Rak. */}
            {run && dlBusy && (
              <div className="mt-2 rounded-lg border border-ink-800 bg-ink-850 p-2.5">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="flex items-center gap-1.5 text-[12px] font-semibold text-ink-100">
                      <span className="inline-block size-2 animate-pulse rounded-full bg-brand-amber" />
                      Mengunduh chapter…
                    </p>
                    <p className="truncate text-[11px] text-ink-300">
                      {run.jobs.length === 1
                        ? `Chapter ${run.jobs[0].number}`
                        : `Chapter ${run.jobs[0].number}–${run.jobs[run.jobs.length - 1].number}`}
                    </p>
                    <p className="mt-0.5 text-[10.5px] tabular-nums text-ink-500">
                      {runProgress(run).selesai}/
                      {run.jobs.length} chapter · {progressPct(run)}%
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={() => dlHandle && cancelRun(dlHandle)}
                    className="min-h-11 shrink-0 rounded-lg border border-ink-700 px-4 py-2.5 text-[12px] font-bold text-ink-200 transition-colors active:scale-[0.97] active:duration-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-amber focus-visible:ring-offset-2 [@media(hover:hover)]:hover:bg-ink-800"
                  >
                    Batal
                  </button>
                </div>
                {dlSlow && !dlStale && (
                  <p className="mt-1.5 text-[11px] font-semibold text-warn">
                    Koneksi lambat — sedang mencoba, harap tunggu…
                  </p>
                )}
                {dlStale && (
                  <p className="mt-1.5 text-[11px] font-semibold text-danger">
                    Unduhan tampak macet (≥15 menit tanpa hasil). Periksa koneksi, atau Batal lalu coba lagi.
                  </p>
                )}
                {/* Indikator per chapter: satu segmen per job, warna = status */}
                <div
                  className="mt-2 flex h-1.5 w-full gap-[2px]"
                  role="progressbar"
                  aria-label={`Progres unduhan ${data?.series.title ?? 'chapter'}`}
                  aria-valuemin={0}
                  aria-valuemax={run.jobs.length}
                  aria-valuenow={runProgress(run).selesai}
                  aria-valuetext={`${runProgress(run).selesai} dari ${run.jobs.length} chapter selesai`}
                >
                  {run.jobs.map((j, i) => (
                    <div
                      key={i}
                      title={`Chapter ${j.number} — ${j.state === 'wait' ? 'menunggu' : j.state === 'run' ? 'berjalan' : j.state === 'ok' ? 'selesai' : 'gagal'}`}
                      className={`h-full flex-1 rounded-full transition-colors ${
                        j.state === 'ok'
                          ? 'bg-healthy'
                          : j.state === 'fail'
                            ? 'bg-danger'
                            : j.state === 'run'
                              ? 'animate-pulse bg-brand-amber'
                              : 'bg-ink-700/60'
                      }`}
                    />
                  ))}
                </div>
                <div className="mt-1.5 flex flex-wrap items-center gap-x-2.5 gap-y-1 text-[10px] tabular-nums">
                  {(() => {
                    const t = jobTally(run) // wait/run saja; angka terminal dari runProgress
                    const pr = runProgress(run)
                    return (
                      <>
                        {t.wait > 0 && (
                          <span className="flex items-center gap-1 text-ink-400">
                            <span className="inline-block size-1.5 rounded-full bg-ink-600" />
                            Menunggu {t.wait}
                          </span>
                        )}
                        {t.run > 0 && (
                          <span className="flex items-center gap-1 text-brand-amber-soft">
                            <span className="inline-block size-1.5 animate-pulse rounded-full bg-brand-amber" />
                            Berjalan {t.run}
                          </span>
                        )}
                        <span className="flex items-center gap-1 text-healthy">
                          <span className="inline-block size-1.5 rounded-full bg-healthy" />
                          Tersimpan {pr.ok}
                        </span>
                        {pr.fail > 0 && (
                          <span className="flex items-center gap-1 text-danger">
                            <span className="inline-block size-1.5 rounded-full bg-danger" />
                            Gagal {pr.fail}
                          </span>
                        )}
                      </>
                    )
                  })()}
                </div>
              </div>
            )}
          </div>
        )}

        {/* Search + lompat chapter, sebelum daftar yang dipotong showAll. */}
        {chapters.length > 0 && <ChapterJumpSearch chapters={chapters} titleKey={s.title_key} />}

        {chapters.length === 0 ? (
          <div className="text-center">
            <p className="text-[12.5px] text-ink-500">Belum ada chapter.</p>
            <Link
              to="/cari"
              className="mt-3 inline-flex min-h-11 items-center rounded-xl bg-brand-amber px-5 py-2.5 text-[13px] font-bold text-white transition-colors active:scale-[0.97] active:duration-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-amber focus-visible:ring-offset-2 [@media(hover:hover)]:hover:bg-brand-amber-soft"
            >
              Cari judul lain
            </Link>
          </div>
        ) : (
          <ul className="divide-y divide-ink-800 overflow-hidden rounded-xl border border-ink-800 bg-ink-900">
            {visible.map((c, i) => (
              <ChapterRow
                key={c.id}
                chapter={c}
                mark={pickMode ? markOf(i) : undefined}
                onPick={pickMode ? () => pickRange(i) : undefined}
                read={isRead(chapterNumber(c))}
              />
            ))}
          </ul>
        )}

        {chapters.length > 40 && (
          <button
            onClick={() => setShowAll((v) => !v)}
            className="mt-3 min-h-11 w-full rounded-xl border border-ink-700 py-2.5 text-[13px] font-medium text-ink-300"
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
 *
 * Pakai helper yang sama dengan `readMarks` supaya mark "sudah dibaca" dan
 * kontrak unduhan tidak pernah berbeda soal nomor chapter.
 */
function chapterNumber(c: Chapter): string | null {
  return chapterNumberOf(c)
}

function ChapterRow({
  chapter,
  mark = 'plain',
  onPick,
  read = false,
}: {
  chapter: Chapter
  /** undefined = mode baca biasa (baris = link ke reader). */
  mark?: RowMark
  onPick?: () => void
  /** chapter sudah pernah dibuka user → judul jadi abu (redup). */
  read?: boolean
}) {
  const isAnchor = mark === 'start' || mark === 'end'
  const cls = `flex min-h-11 w-full items-center justify-between gap-3 px-3.5 py-3 text-left transition-colors ${
    isAnchor
      ? 'bg-brand-amber/15 ring-1 ring-inset ring-brand-amber/50'
      : mark === 'mid'
        ? 'bg-brand-amber/10'
        : '[@media(hover:hover)]:hover:bg-ink-850 active:bg-ink-850'
  }`
  const titleCls = read
    ? 'min-w-0 flex-1 truncate text-[13px] font-medium text-ink-500'
    : 'min-w-0 flex-1 truncate text-[13px] font-semibold text-ink-100'
  const body = (
    <>
      <span className={titleCls}>{chapter.name}</span>
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
      <Link
        to={readerHref(String(chapter.id))}
        className={cls}
        aria-label={read ? `${chapter.name} — sudah dibaca` : `${chapter.name} — belum dibaca`}
      >
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
