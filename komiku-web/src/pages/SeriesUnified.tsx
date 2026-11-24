import { useEffect, useMemo, useRef, useState } from 'react'
import { SourceStatus } from '../components/SourceStatus'
import { Link, useLocation, useNavigate, useParams } from 'react-router-dom'
import { imgUrl } from '../imgUrl'
import { unifiedApi } from '../api'
import { getUser } from '../account'
import type { MangaOut, UnifiedChapterOut } from '../types'
import { Empty, Spinner } from '../App'
import SourceBadge from '../components/SourceBadge'
import SimilarSeriesAccordion from '../components/SimilarSeriesAccordion'
import HeartButton from '../components/HeartButton'
import { useProgress } from '../hooks/useProgress'
import { useDownloadRun, useOffline, retryRun } from '../hooks/useDownloadRun'
import { useSeriesResume } from '../hooks/useSeriesResume'
import { sortByChapterNumber } from '../chapterOrder'
import { useReadMarks } from '../hooks/useReadMarks'
import { rememberSeriesLite, readerHref } from '../readerSource'
import { genreHref, resumeCta } from './Series'
import {
  cancelRun,
  startRun,
  startRunCache,
  runProgress,
  progressPct,
  type DlRun,
} from '../downloadStore'
import { RangeSelectBar, useRangeSelection, outOfRangeCount } from '../components/DownloadRangePicker'
import { doneNumbers } from '../downloadHistory'
import { friendlyError } from '../downloadBatch'
import { ensureDownloadReturn } from '../downloadReturn'
import {
  canGoBack,
  filterChapterIndices,
  resolveBackTarget,
} from '../components/ChapterJumpSearch'

/**
 * Detail manga unified (route /manga/:handle, handle 'sumber:native_id').
 * UI sengaja mengikuti Series.tsx lama supaya user tidak merasa "pindah
 * aplikasi"; sumber hanya tampil sebagai badge halus.
 */
export default function SeriesUnified() {
  const { handle = '' } = useParams<{ handle: string }>()
  const [data, setData] = useState<{
    manga: MangaOut
    chapters: UnifiedChapterOut[]
    representative_source: string | null
  } | null>(
    null,
  )
  /**
   * Sumber yang gagal dilaporkan server untuk halaman ini. Server sudah lama
   * mengirimnya; sebelumnya dibuang sehingga user tidak tahu daftar chapter
   * yang ia lihat lebih tipis dari seharusnya.
   */
  const [failedSources, setFailedSources] = useState<string[]>([])
  /** Naikkan untuk memicu muat ulang (tombol "Coba lagi" di SourceStatus). */
  const [reloadKey, setReloadKey] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const [showAll, setShowAll] = useState(false)
  const [chapterQuery, setChapterQuery] = useState('')
  const { recent } = useProgress()
  // --- unduh PDF mode range (2-tap rentang) --------------------------------
  const [pickMode, setPickMode] = useState(false)
  const [dlSummary, setDlSummary] = useState<DlSummary | null>(null)
  /** Catatan unduhan yang tidak bisa jalan (mis. offline) — tampil di atas daftar chapter. */
  const [dlNote, setDlNote] = useState<string | null>(null)
  // Tombol kecil salin tautan series (di header)
  const [copied, setCopied] = useState(false)
  const [copyError, setCopyError] = useState<string | null>(null)
  const offline = useOffline()
  /**
   * Run unduhan milik halaman ini (dari store module-level — hidup lintas
   * halaman). `dlBusy` masih dipakai UI (mode seleksi, tombol Batal) walau
   * state jobs tidak lagi tinggal di komponen.
   */
  // Wiring unduhan batch (dari store module-level, hidup lintas halaman) —
  // hook bersama. `dlRun`/`dlBusy` dipakai UI (mode seleksi, kartu progres,
  // tombol Batal); saat batch yang disaksikan instance ini selesai, hasilnya
  // diumumkan sekali lewat `onFinish`.
  const { run: dlRun, busy: dlBusy, slow: dlSlow, stale: dlStale } = useDownloadRun(handle, (finishedRun) => {
    const summary = announceFinish(finishedRun, { current: true })
    if (summary) setDlSummary(summary)
  })
  const range = useRangeSelection(data?.chapters.length ?? 0)
  const navigate = useNavigate()
  const location = useLocation()
  /** Kembali ke asal (state.from / history), bukan selalu Beranda. */
  const goBack = () => {
    const target = resolveBackTarget(
      (location.state as { from?: unknown } | null)?.from,
      canGoBack(window.history.state),
    )
    if (target.back) navigate(-1)
    else navigate(target.to)
  }
  const downloadTriggerRef = useRef<HTMLButtonElement>(null)
  const wasPickingRef = useRef(false)
  const selectionKey = `komik:download-selection:${handle}`
  const returnKey = `komik:download-return:${handle}`
  const resetRange = range.reset
  const selectRange = range.select

  // Listener modul aktif meski halaman series unmount saat /akun tampil.
  ensureDownloadReturn()

  useEffect(() => {
    if (wasPickingRef.current && !pickMode) downloadTriggerRef.current?.focus()
    wasPickingRef.current = pickMode
  }, [pickMode])

  // Sticky B+C — server coba sumber terakhir-dibaca untuk judul ini dulu
  // (kalau ada di riwayat), baru fallback primary. Ref supaya effect tidak
  // re-fetch setiap kali riwayat bertambah.
  const lastSourceRef = useRef<string | undefined>(undefined)
  lastSourceRef.current = recent.find((r) => String(r.seriesId) === handle)?.source ?? undefined

  useEffect(() => {
    if (!handle) return
    const ctrl = new AbortController()
    // Request menggantung (koneksi lambat / HP suspend) dulu = spinner tanpa
    // akhir. 15 detik lalu batalkan dan tampilkan pesan server bermasalah.
    const timer = setTimeout(() => ctrl.abort(new DOMException('Waktu habis', 'TimeoutError')), 15_000)
    setData(null)
    setError(null)
    setShowAll(false)
    setPickMode(false)
    unifiedApi
      .series(handle, ctrl.signal, lastSourceRef.current)
      .then((r) => {
        setData({
          manga: r.manga,
          chapters: r.chapters ?? [],
          representative_source: r.representative_source ?? null,
        })
        setFailedSources(r.failed_sources ?? [])
      })
      .catch((e: Error) => {
        if (e.name === 'AbortError') return
        setError(e.name === 'TimeoutError' ? 'Server tidak merespons — coba lagi.' : friendlyError(e))
      })
    return () => {
      clearTimeout(timer)
      ctrl.abort()
    }
  }, [handle, reloadKey])

  // Satu aturan urutan dipakai daftar, tombol mulai, dan lanjut/next.
  const chapters = useMemo(
    () => sortByChapterNumber(data?.chapters ?? [], (c) => c.number, 'terbaru'),
    [data],
  )
  // Simpan nomor chapter, bukan indeks: chapter baru dapat muncul selama login.
  useEffect(() => {
    if (!data) return
    try {
      const stored = sessionStorage.getItem(selectionKey)
      if (!stored) return
      sessionStorage.removeItem(selectionKey)
      const saved: unknown = JSON.parse(stored)
      if (!saved || typeof saved !== 'object' ||
          !('start' in saved) || !(saved.start === null || typeof saved.start === 'string') ||
          !('end' in saved) || !(saved.end === null || typeof saved.end === 'string') ||
          !('showAll' in saved) || typeof saved.showAll !== 'boolean' ||
          (saved.start === null && saved.end !== null)) {
        throw new Error('Seleksi tidak valid')
      }
      const start = chapters.findIndex((c) => c.number === saved.start)
      const end = chapters.findIndex((c) => c.number === saved.end)
      resetRange()
      setPickMode(true)
      setShowAll(saved.showAll || start >= 40 || end >= 40)
      if ((saved.start !== null && start < 0) || (saved.end !== null && end < 0)) {
        setDlNote('Daftar chapter berubah — pilih ulang rentang unduhan.')
        return
      }
      if (start >= 0) selectRange(start)
      if (end >= 0) selectRange(end)
    } catch {
      setDlNote('Seleksi sebelumnya tidak bisa dipulihkan — pilih ulang chapter.')
    }
  }, [data, chapters, selectionKey, resetRange, selectRange])

  const oldest = chapters.length > 0 ? chapters[chapters.length - 1] : null
  // Mark "sudah dibaca" per akun: chapter yang pernah dibuka user jadi abu.
  // Kunci = title_key series + nomor chapter (lihat readMarks.ts).
  const titleKey = data?.manga.title_key ?? null
  const { isRead, count: readTotal } = useReadMarks(titleKey)
  // Resume baca + sesi maraton untuk series ini — hook bersama. Progres
  // mengikuti identitas series dengan kunci chapter persis; bila sumber halaman
  // berbeda dari sumber progres, label menjelaskannya tanpa jatuh ke chapter
  // lokal paling awal.
  const {
    resume,
    target,
    resumeKey,
    marathonPos,
    resumeHref,
    marathonHref: marathonLink,
    label,
    sourceNotice,
  } = useSeriesResume(handle, undefined, data?.representative_source ?? handle.split(':')[0] ?? null)
  const lanjut = resume && resumeHref ? resumeCta(resume, target?.page) : null

  // Range mengikuti URUTAN TAMPIL. Pencarian nomor menyaring daftar yang SAMA
  // sambil mempertahankan index asli → index baris aman dipakai walau daftar
  // dipotong 40 atau sebagian chapter disembunyikan query.
  const selectedRefs = useMemo(
    () =>
      range.indices
        .map((i) => chapters[i])
        .filter((c): c is UnifiedChapterOut => c !== undefined)
        .map((c) => ({ handle, number: c.number })),
    [range.indices, handle, chapters],
  )
  // Chapter terpilih yang sudah tidak ada di daftar (daftar menyusut /
  // indeks basi) — diperingatkan, bukan diam-diam dibuang.
  const outOfRange = outOfRangeCount(range.indices, chapters.length)
  // Chapter terpilih yang sudah tersimpan sebelumnya (ledger tahan tab
  // ditutup) — diberi tahu supaya user tidak mengunduh ulang tanpa sadar.
  const alreadyDone = useMemo(() => {
    if (!pickMode) return 0
    const done = new Set(doneNumbers(handle))
    return selectedRefs.filter((r) => done.has(r.number)).length
  }, [pickMode, handle, selectedRefs])

  /** Tap di luar daftar chapter (dan bukan tombol "Unduh") → tutup mode seleksi. */
  useEffect(() => {
    // Saat mengunduh, mode dibiarkan terbuka supaya progres per chapter terlihat.
    if (!pickMode || dlBusy) return
    const onDown = (e: PointerEvent) => {
      const t = e.target as HTMLElement | null
      if (t?.closest('[data-range-toggle], [data-range-dock], section[data-series-list]')) return
      setPickMode(false)
      resetRange()
    }
    document.addEventListener('pointerdown', onDown as EventListener)
    return () => document.removeEventListener('pointerdown', onDown as EventListener)
  }, [pickMode, dlBusy, resetRange])

  /** Escape keluar dari mode pilih. */
  useEffect(() => {
    if (!pickMode) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { setPickMode(false); resetRange() }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [pickMode, resetRange])

  const signInForDownload = () => {
    try {
      sessionStorage.setItem(selectionKey, JSON.stringify({
        start: range.state.start === null ? null : chapters[range.state.start]?.number ?? null,
        end: range.state.end === null ? null : chapters[range.state.end]?.number ?? null,
        showAll,
      }))
      sessionStorage.setItem(returnKey, location.pathname + location.search + location.hash)
    } catch {
      setDlNote('Seleksi belum bisa disimpan. Izinkan penyimpanan browser sebelum masuk agar seleksi tidak hilang.')
      return
    }
    navigate('/akun', { state: { from: location.pathname + location.search + location.hash } })
  }

  const runDownload = (cache: boolean) => {
    downloadTriggerRef.current?.focus()
    if (dlBusy || selectedRefs.length === 0) return
    // Tidak ada koneksi → jangan kirim request yang pasti gagal; beri tahu
    // user lewat catatan inline (bukan alert).
    if (offline) {
      setDlNote('Tidak ada koneksi internet — tidak bisa mengunduh.')
      return
    }
    setDlNote(null)
    // Unduhan wajib akun (server menolak 401 tanpa X-Komik-User). Kalau
    // belum login, arahkan ke halaman akun — jangan kirim request yang
    // pasti 401.
    if (getUser() === null) {
      signInForDownload()
      return
    }
    // LANGSUNG keluar dari mode pilih: baris chapter kembali jadi Link ke
    // reader dan tombol Unduh tak lagi tertekan. Unduhan jalan di store
    // (lintas halaman) — hanya tombol Batal yang membatalkan, jadi user
    // bebas navigasi.
    setPickMode(false)
    setDlSummary(null)
    range.reset()
    const numbers = selectedRefs.map((r) => r.number)
    if (cache) startRunCache(handle, data?.manga.title ?? '', numbers)
    else startRun(handle, data?.manga.title ?? '', numbers)
  }
  const downloadSelectedOffline = () => runDownload(true)
  const downloadSelectedPdf = () => runDownload(false)

  // Cover gagal dimuat → tampilkan judul, bukan ikon gambar rusak.
  // WAJIB di atas `if (error) return ...`: hook setelah early return membuat
  // jumlah hook berbeda antar render → React error #310 (halaman blank).
  const [coverFailed, setCoverFailed] = useState(false)

  // Catatan: TIDAK ada abort saat unmount — store yang memegang run
  // (lihat downloadStore), navigasi ke chapter lain / halaman lain bukan
  // pembatalan. Yang membatalkan hanya tombol "Batal" (cancelRun).

  // ... cache untuk halaman baca (toolbar/rak) — di-effect supaya tidak
  // double-invoke saat StrictMode (side-effect tidak boleh di badan render).
  const manga = data?.manga
  useEffect(() => {
    if (!manga) return
    rememberSeriesLite(handle, {
      title: manga.title,
      title_key: manga.title_key,
      cover_url: manga.cover_url ?? null,
    })
  }, [manga, handle])

  if (error) return (
    <div className="mx-auto max-w-3xl px-4 py-16 text-center">
      <Empty title="Gagal memuat manga" body={error} icon="📡" />
      <button
        type="button"
        onClick={() => setReloadKey((k) => k + 1)}
        className="mt-4 min-h-11 rounded-xl bg-brand-amber px-5 py-2.5 text-[13px] font-bold text-white transition-colors active:scale-[0.97] active:duration-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-amber focus-visible:ring-offset-2 [@media(hover:hover)_and_(pointer:fine)]:hover:bg-brand-amber-soft"
      >
        Muat ulang
      </button>
    </div>
  )
  if (!data) return <Spinner label="Memuat manga…" />

  const { manga: m } = data
  // MangaOut belum punya field genre di kontrak API unified. Tampilkan chip
  // HANYA kalau server suatu hari mengirimnya — jangan mengarang genre.
  const unifiedGenres = (m as MangaOut & { genre?: { id?: string; name: string }[] }).genre
  // Satu daftar chapter saja; query menyaringnya tanpa mengubah index asli
  // (dipakai range.isAnchor/inRange/select dan resume lintas sumber).
  const chapterRows = filterChapterIndices(chapters, chapterQuery)
  const visibleRows =
    showAll || chapterQuery.trim() ? chapterRows : chapterRows.slice(0, 40)
  // Diproses = semua hasil terminal (tersimpan + gagal), bukan hanya sukses.
  const dlProg = dlRun ? runProgress(dlRun) : null
  const dlDone = dlProg?.selesai ?? 0
  const dlFail = dlProg?.fail ?? 0
  // Hitungan per-status untuk legenda kartu progres.
  const dlWait = dlRun ? dlRun.jobs.filter((j) => j.state === 'wait').length : 0
  const dlRunCount = dlRun ? dlRun.jobs.filter((j) => j.state === 'run').length : 0
  // Pesan kegagalan pertama — dirender supaya user tahu KENAPA gagal, bukan
  // cuma angka. (`job.error` sebelumnya tidak pernah tampil di UI.)
  const dlError = dlRun?.jobs.find((j) => j.state === 'fail' && j.error)?.error ?? null

  const chapterLabel = (c: UnifiedChapterOut) => c.title || `Chapter ${c.number}`

  // Salin URL kanonik halaman series (pola Akun.tsx: clipboard + reset 1500ms)
  async function copySeriesLink() {
    try {
      await navigator.clipboard.writeText(window.location.href)
      setCopied(true)
      setCopyError(null)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      setCopyError('Gagal menyalin — salin manual dari address bar.')
    }
  }

  return (
    <div className="mx-auto max-w-3xl">
      {/* Hero sampul */}
      <div className="relative">
        {m.cover_url && (
          <div className="absolute inset-0 h-56 overflow-hidden">
            <img referrerPolicy="no-referrer" src={imgUrl(m.cover_url)} alt="" loading="lazy" width={225} height={300} className="size-full object-cover opacity-25 blur-md" />
            <div className="absolute inset-0 bg-gradient-to-b from-ink-950/60 to-ink-950" />
          </div>
        )}

        <div className="relative px-4 pb-4 pt-5">
          {/* py-3.5 memperluas area sentuh ke >=44px; padding inline tak mengubah tinggi header. */}
          <div className="flex items-center justify-between">
            <button
              type="button"
              onClick={goBack}
              className="inline-flex min-h-11 items-center py-3.5 text-[12px] font-medium text-ink-400 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-amber focus-visible:ring-offset-2 [@media(hover:hover)_and_(pointer:fine)]:hover:text-ink-200"
            >
              ← Kembali
            </button>
            {/* Ikon inline — icons.tsx (ikon APK asli) tak diubah. -mr-3 menarik glyph sejajar tepi konten 16px. */}
            <button
              type="button"
              onClick={copySeriesLink}
              aria-label={copied ? 'Tautan tersalin' : 'Salin tautan series'}
              className="-mr-3 flex h-11 w-11 shrink-0 touch-manipulation items-center justify-center rounded-xl text-ink-400 transition-transform duration-150 [@media(hover:hover)_and_(pointer:fine)]:hover:text-ink-100 active:scale-[0.97] active:duration-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-amber focus-visible:ring-offset-2"
            >
              {copied ? (
                <svg viewBox="0 0 24 24" className="size-5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M20 6 9 17l-5-5" />
                </svg>
              ) : (
                <svg viewBox="0 0 24 24" className="size-5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
                  <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
                </svg>
              )}
            </button>
          </div>
          {copyError && <p className="mt-1 text-right text-[11px] text-brand-red">{copyError}</p>}

          <div className="mt-3 flex gap-4">
            <div className="w-28 shrink-0 sm:w-32">
              <div className="aspect-[3/4] overflow-hidden rounded-xl border border-ink-700 bg-ink-850 shadow-lg">
                {m.cover_url && !coverFailed ? (
                  <img referrerPolicy="no-referrer" src={imgUrl(m.cover_url)} alt={m.title} onError={() => setCoverFailed(true)} className="size-full object-cover" />
                ) : (
                  <span className="grid size-full place-items-center p-2 text-center text-[11px] text-ink-500">
                    {m.title}
                  </span>
                )}
              </div>
            </div>

            <div className="min-w-0 flex-1">
              <div className="flex items-start gap-1.5">
                <h1 className="text-lg font-bold leading-tight text-ink-100">{m.title}</h1>
                {/* badge sumber — selalu tampil di detail (bukan cuma di kartu) */}
                <SourceBadge source={m.source} className="mt-1 shrink-0" />
              </div>

              <dl className="mt-2.5 space-y-1 text-[12px]">
                {m.author && (
                  <div className="flex gap-2">
                    <dt className="w-16 shrink-0 text-ink-500">Penulis</dt>
                    <dd className="min-w-0 flex-1 truncate text-ink-200">{m.author}</dd>
                  </div>
                )}
                {m.status && (
                  <div className="flex gap-2">
                    <dt className="w-16 shrink-0 text-ink-500">Status</dt>
                    <dd className="min-w-0 flex-1 truncate text-ink-200">{m.status}</dd>
                  </div>
                )}
                {m.manga_type && (
                  <div className="flex gap-2">
                    <dt className="w-16 shrink-0 text-ink-500">Tipe</dt>
                    <dd className="min-w-0 flex-1 truncate text-ink-200">{m.manga_type}</dd>
                  </div>
                )}
                {hasScore(m.rating) && (
                  <div className="flex gap-2">
                    <dt className="w-16 shrink-0 text-ink-500">Skor</dt>
                    <dd className="min-w-0 flex-1 truncate text-ink-200">★ {m.rating}</dd>
                  </div>
                )}
              </dl>

              {unifiedGenres && unifiedGenres.length > 0 && (
                <div className="mt-2.5 flex flex-wrap gap-1.5">
                  {unifiedGenres.map((g, i) => (
                    <Link
                      key={`${g.id ?? g.name}-${i}`}
                      to={genreHref(g.id, g.name)}
                      className="inline-flex min-h-11 items-center rounded-full bg-brand-amber/10 px-2.5 py-1.5 text-[10.5px] font-semibold text-brand-amber transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-amber [@media(hover:hover)_and_(pointer:fine)]:hover:bg-brand-amber/20"
                    >
                      {g.name}
                    </Link>
                  ))}
                </div>
              )}

              {data.representative_source && (
                <p className="mt-1.5 inline-flex items-center gap-1 rounded-md border border-ink-700 bg-ink-900 px-1.5 py-0.5 text-[10.5px] font-medium text-ink-400">
                  Terbaru dari {data.representative_source}
                </p>
              )}

              {m.updated_at != null && (
                <p className="mt-1.5 text-[11px] text-ink-500">
                  Update {new Date(m.updated_at).toLocaleDateString('id-ID')}
                </p>
              )}

              {m.url && (
                <a
                  href={m.url}
                  target="_blank"
                  rel="noreferrer noopener"
                  className="mt-2.5 inline-flex min-h-11 items-center text-[11.5px] font-semibold text-brand-amber"
                >
                  Buka halaman asli ↗
                </a>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* Tombol baca / maraton */}
      <div className="sticky top-[calc(3.5rem+env(safe-area-inset-top))] z-30 border-y border-ink-800 bg-ink-950/95 px-4 py-2.5 backdrop-blur">
        <div className="grid grid-cols-2 gap-3">
          {oldest && (
            <>
              <Link
                to={resumeHref ?? `/baca/${handle}/${oldest.number}`}
                className="flex min-h-11 flex-1 items-center justify-center rounded-xl bg-brand-amber py-2.5 text-center text-[13px] font-bold text-white transition-colors active:scale-[0.97] active:duration-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-amber focus-visible:ring-offset-2 [@media(hover:hover)_and_(pointer:fine)]:hover:bg-brand-amber-soft"
              >
                {lanjut ? (
                  <span className="flex flex-col items-center">
                    <span>{lanjut.label}</span>
                    {lanjut.sub && (
                      <span className="mt-0.5 text-[10.5px] font-medium text-white/85">
                        {lanjut.sub}
                      </span>
                    )}
                    {sourceNotice && (
                      <span className="mt-0.5 text-[10px] font-medium text-white/80">
                        {sourceNotice}
                      </span>
                    )}
                  </span>
                ) : (
                  resumeKey
                    ? `Lanjut · ${label}${sourceNotice ? ` ${sourceNotice}` : ''}`
                    : `Baca ${chapterLabel(oldest)}`
                )}
              </Link>
              <Link
                to={
                  // Sesi maraton tersimpan menang: tombol "Maraton" harus
                  // MELANJUTKAN rantai, bukan mengulang dari chapter paling awal
                  // (itu keluhan aslinya: klik maraton → balik ke awal).
                  marathonLink ?? `/maraton/${handle}/${oldest.number}`
                }
                title={
                  marathonPos
                    ? 'Lanjutkan maraton dari posisi terakhir'
                    : `Mulai maraton dari ${chapterLabel(oldest)}`
                }
                className="flex min-h-11 items-center justify-center rounded-xl border border-brand-amber-dim px-3.5 py-2.5 text-center text-[13px] font-semibold text-brand-amber transition-colors active:scale-[0.97] active:duration-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-amber focus-visible:ring-offset-2 [@media(hover:hover)_and_(pointer:fine)]:hover:bg-brand-amber-dim/20"
              >
                Maraton
              </Link>
              {/* unduh PDF: aktifkan mode range 2-tap rentang pada daftar chapter */}
              {chapters.length > 0 && (
                <button
                  type="button"
                  data-range-toggle
                  ref={downloadTriggerRef}
                  aria-pressed={pickMode}
                  aria-label={pickMode ? 'Tutup mode pilih chapter' : 'Unduh chapter'}
                  onClick={() => {
                    if (pickMode) range.reset()
                    setPickMode(!pickMode)
                  }}
                  className={`flex min-h-11 shrink-0 items-center justify-center gap-1.5 rounded-xl border px-3 py-2.5 text-center text-[13px] font-semibold transition-colors active:scale-[0.97] active:duration-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-amber focus-visible:ring-offset-2 ${
                    pickMode
                      ? 'border-brand-amber bg-brand-amber/15 text-brand-amber'
                      : 'border-ink-700 text-ink-300 [@media(hover:hover)_and_(pointer:fine)]:hover:bg-ink-850'
                  }`}
                >
                  <svg
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2.5"
                    aria-hidden="true"
                    className="size-4"
                  >
                    <path d="M12 4v11m0 0 4-4m-4 4-4-4" strokeLinecap="round" strokeLinejoin="round" />
                    <path d="M5 20h14" strokeLinecap="round" />
                  </svg>
                  Unduh
                </button>
              )}
              {/* favorit: tombol berlabel di sebelah CTA baca (discoverability HP) */}
              {m.title_key && (
                <HeartButton
                  labeled
                  manga={{
                    title_key: m.title_key,
                    title: m.title,
                    cover_url: m.cover_url ?? null,
                    handle,
                    source: m.source,
                  }}
                />
              )}
            </>
          )}
        </div>
      </div>

      {/* Daftar chapter */}
      <section className="px-4 pb-6 pt-4" data-series-list>
        <h2 className="mb-2 text-[13px] font-semibold text-ink-100">
          Chapter <span className="text-ink-500">({chapters.length})</span>
          {readTotal > 0 && (
            <span className="ml-1.5 font-normal text-ink-500">
              · {readTotal} sudah dibaca
            </span>
          )}
        </h2>

        {/* Pencarian nomor chapter — menyaring SATU daftar di bawah, tanpa panel scroll tersendiri. */}
        <div className="mb-2 flex items-center gap-2">
          <input
            type="search"
            aria-label="Cari nomor chapter"
            placeholder="Cari nomor chapter…"
            value={chapterQuery}
            onChange={(e) => setChapterQuery(e.target.value)}
            inputMode="decimal"
            enterKeyHint="search"
            className="min-h-11 min-w-0 flex-1 rounded-xl border border-ink-700 bg-ink-900 px-3 text-base text-ink-100 placeholder:text-ink-500 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-amber sm:text-[12.5px]"
          />
          {chapterQuery.trim() && (
            <button
              type="button"
              onClick={() => setChapterQuery('')}
              className="min-h-11 shrink-0 px-2 text-[12px] font-semibold text-ink-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-amber"
            >
              Hapus
            </button>
          )}
        </div>

        {/* Kalau ada sumber yang gagal, katakan SEBELUM daftar chapter:
            user harus tahu daftar ini lebih tipis dari seharusnya, bukan
            menyimpulkan series-nya memang cuma segini. */}
        <SourceStatus
          failed={failedSources}
          onRetry={() => setReloadKey((k) => k + 1)}
          className="mb-3"
        />

        {/* Mode seleksi range (2-tap rentang) → POST /unified/download-pdf.
            Info seleksi + baris progres mengisi ulang tempat UI centang lama. */}
        {!pickMode && dlSummary && (
          <div
            role="status"
            aria-live="polite"
            className={`relative mb-3 rounded-xl border px-3 py-2 pr-11 text-[11.5px] ${
              dlSummary.fail > 0 || dlSummary.errors.length > 0
                ? 'border-danger/40 bg-danger/10 text-danger'
                : 'border-healthy/40 bg-healthy/10 text-healthy'
            }`}
          >
            <button
              type="button"
              aria-label="Tutup ringkasan unduhan"
              onClick={() => { setDlSummary(null); downloadTriggerRef.current?.focus() }}
              className="absolute right-1 top-1 grid size-11 place-items-center rounded-full text-current opacity-60 transition-opacity [@media(hover:hover)_and_(pointer:fine)]:hover:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-amber"
            >
              <span aria-hidden className="text-base leading-none">×</span>
            </button>
            <p className="flex items-center gap-1.5 font-semibold">
              {dlSummary.fail === 0 && dlSummary.errors.length === 0 && (
                <svg aria-hidden viewBox="0 0 20 20" fill="none" className="animate-heart-pop size-4 shrink-0" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M4 10.5l4 4L16 5.5" /></svg>
              )}
              {dlSummaryHeadline(dlSummary)}
            </p>
            {dlSummary.ok > 0 && (
              <Link
                to="/rak?tab=unduhan"
                className="mt-2 inline-flex min-h-11 items-center gap-1.5 rounded-full border border-healthy/50 bg-healthy/15 px-3 text-[11.5px] font-semibold text-healthy transition-[transform,background-color,border-color] duration-150 ease-[var(--ease-out)] active:scale-[0.97] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-amber"
              >
                Buka Rak → Unduhan
              </Link>
            )}
            <p className="mt-0.5 text-[11px] text-ink-400">
              Chapter {dlSummary.range} · {dlSummary.mode === 'cache' ? 'Offline di perangkat ini' : dlSummary.ok > 0 ? 'PDF siap diambil' : 'Belum ada PDF siap diambil'}
              {dlSummary.ok < dlSummary.total ? ' · sebagian' : ''}
            </p>
            {dlSummary.cancelled && dlSummary.fail > 0 && (
              <p className="mt-0.5 text-[11px]">{dlSummary.fail} gagal</p>
            )}
            {dlSummary.mode === 'pdf' && dlSummary.ok > 0 && (
              <p className="mt-0.5 text-[11px] text-ink-400">
                {dlSummary.saved} dari {dlSummary.ok} file PDF terkirim ke perangkat
              </p>
            )}
            {dlSummary.mode === 'pdf' && dlSummary.saveFailed > 0 && (
              <p className="mt-0.5 text-[11px] text-ink-400">
                {dlSummary.saveFailed} PDF gagal disimpan ke perangkat (sudah tersimpan di server)
              </p>
            )}
            {dlSummary.errors.length > 0 && (
              <p className="mt-1 text-[11px]">{dlSummary.errors[0].error}</p>
            )}
            {dlSummary.fail > 0 && (
              <button
                type="button"
                onClick={() => { setDlSummary(null); retryRun(handle) }}
                className="mt-2 min-h-11 w-full rounded-lg border border-ink-700 py-1.5 text-[11.5px] font-semibold text-ink-300 transition-colors active:scale-[0.97] active:duration-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-amber focus-visible:ring-offset-2 [@media(hover:hover)_and_(pointer:fine)]:hover:border-brand-amber/60 [@media(hover:hover)_and_(pointer:fine)]:hover:text-brand-amber"
              >
                Coba lagi chapter gagal
              </button>
            )}
          </div>
        )}
        {offline && (
          <div
            role="alert"
            className="mb-3 flex items-start gap-1.5 rounded-xl border border-warn/40 bg-warn/10 px-3 py-2 text-[11.5px] text-warn"
          >
            <span aria-hidden>⚠</span>
            <span>Tidak ada koneksi internet — unduhan akan gagal</span>
          </div>
        )}
        {dlNote && (
          <div
            role="status"
            className="mb-3 flex items-start gap-1.5 rounded-xl border border-warn/40 bg-warn/10 px-3 py-2 text-[11.5px] text-warn"
          >
            <span aria-hidden>⚠</span>
            <span>{dlNote}</span>
          </div>
        )}
        {/* Ringkasan compact: judul, rentang chapter, n/M, bar progres,
            tombol Batal. SENGAJA di LUAR blok pickMode — setelah "Unduh"
            diklik mode pilih keluar (baris kembali Link), tapi kartu progres
            + tombol Batal harus tetap terlihat sampai batch selesai.
            Tanpa daftar per chapter (server generate PDF bisa 30+ baris →
            user tak bisa lihat apa-apa). */}
        {dlBusy && dlRun && dlProg && (
          <div className="mb-3 rounded-xl border border-ink-800 bg-ink-900 p-3">
            <div className="rounded-xl border border-ink-800/60 bg-ink-950/60 p-2.5">
              <div className="flex items-center justify-between gap-2">
                <p className="flex items-center gap-1.5 text-[12px] font-semibold text-ink-100">
                  <span className="inline-block size-2 animate-pulse rounded-full bg-brand-amber" />
                  Mengunduh chapter…
                </p>
                <p className="text-[11px] tabular-nums text-ink-400">
                  {progressPct(dlRun)}%
                </p>
              </div>
              <p className="mt-0.5 truncate text-[11.5px] text-ink-300">
                Chapter {rangeLabel(dlRun.jobs)} · {dlRun.mode === 'cache' ? 'Offline di perangkat ini' : 'Menyiapkan PDF'}
              </p>
              <p className="mt-1 text-[11px] tabular-nums text-ink-400">
                {dlDone}/{dlRun.jobs.length} diproses · {dlProg.ok} tersimpan · {dlProg.fail} gagal
              </p>
              {/* Indikator per chapter: satu segmen per job, warna = status
                  (menunggu/berjalan/selesai/gagal) */}
              <div
                className="mt-2 flex h-1.5 w-full gap-[2px]"
                role="progressbar"
                aria-label={`Progres unduhan ${m.title}`}
                aria-valuemin={0}
                aria-valuemax={dlRun.jobs.length}
                aria-valuenow={dlDone}
                aria-valuetext={`${dlDone}/${dlRun.jobs.length} diproses · ${dlProg.ok} tersimpan · ${dlProg.fail} gagal`}
              >
                {dlRun.jobs.map((j, i) => (
                  <div
                    key={i}
                    title={`Chapter ${j.number} — ${j.state === 'wait' ? 'menunggu' : j.state === 'run' ? 'berjalan' : j.state === 'ok' ? 'selesai' : 'gagal'}`}
                    className={`h-full flex-1 rounded-full transition-colors ${
                      j.state === 'ok'
                        ? 'bg-healthy'
                        : j.state === 'fail'
                          ? 'bg-danger'
                          : j.state === 'run'
                            ? 'bar-shimmer bg-brand-amber'
                            : 'bg-ink-700/60'
                    }`}
                  />
                ))}
              </div>
              {/* Legenda tally — setiap status punya label + jumlah */}
              <div className="mt-1.5 flex flex-wrap items-center gap-x-2.5 gap-y-1 text-[10.5px] tabular-nums">
                {dlWait > 0 && (
                  <span className="flex items-center gap-1 text-ink-400">
                    <span className="inline-block size-1.5 rounded-full bg-ink-600" />
                    Menunggu {dlWait}
                  </span>
                )}
                {dlRunCount > 0 && (
                  <span className="flex items-center gap-1 text-brand-amber-soft">
                    <span className="inline-block size-1.5 animate-pulse rounded-full bg-brand-amber" />
                    Berjalan {dlRunCount}
                  </span>
                )}
                <span className="flex items-center gap-1 text-healthy">
                  <span className="inline-block size-1.5 rounded-full bg-healthy" />
                  Tersimpan {dlProg?.ok ?? 0}
                </span>
                {dlFail > 0 && (
                  <span className="flex items-center gap-1 text-danger">
                    <span className="inline-block size-1.5 rounded-full bg-danger" />
                    Gagal {dlFail}
                  </span>
                )}
              </div>
              <p className="mt-1.5 text-[11px] text-ink-500">
                Berjalan di latar belakang — boleh buka chapter lain.
              </p>
              {dlFail > 0 && (
                <p className="mt-1 truncate text-[11px] text-danger">
                  {dlFail} gagal{dlError ? ` · ${dlError}` : ''}
                </p>
              )}
              {dlSlow && !dlStale && (
                <p className="mt-1 text-[11px] font-semibold text-warn">
                  Koneksi lambat — sedang mencoba, harap tunggu…
                </p>
              )}
              {dlStale && (
                <p className="mt-1 text-[11px] font-semibold text-danger">
                  Unduhan tampak macet (≥15 menit tanpa hasil). Periksa koneksi, atau Batal lalu coba lagi.
                </p>
              )}
              <button
                type="button"
                onClick={() => cancelRun(handle)}
                className="mt-2 min-h-11 w-full rounded-lg border border-ink-700 py-1.5 text-[11.5px] font-semibold text-ink-300 transition-colors active:scale-[0.97] active:duration-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-amber focus-visible:ring-offset-2 [@media(hover:hover)_and_(pointer:fine)]:hover:border-danger/60 [@media(hover:hover)_and_(pointer:fine)]:hover:text-danger"
              >
                Batalkan sisa unduhan
              </button>
              <p className="mt-1 text-[11px] text-ink-500">Yang sudah tersimpan tetap tersedia.</p>
            </div>
          </div>
        )}
        {getUser() === null && chapters.length > 0 && (
          <div className="mb-3 text-[11px] text-ink-500">
            <button
              type="button"
              onClick={signInForDownload}
              className="min-h-11 rounded-lg font-semibold text-brand-amber focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-amber"
            >
              Masuk untuk mengunduh
            </button>
            <p>Perlu akun untuk mengunduh. Setelah masuk, kembali ke halaman ini; seleksi chapter dipertahankan.</p>
          </div>
        )}
        {pickMode && chapters.length > 0 && (
          <div>
            <RangeSelectBar
              count={selectedRefs.length}
              clamped={range.clamped}
              needEnd={range.needEnd}
              busy={dlBusy}
              onDownloadOffline={downloadSelectedOffline}
              onDownloadPdf={downloadSelectedPdf}
            >
              {outOfRange > 0 && (
                <p className="mt-1 text-[11px] font-semibold text-warn">
                  {outOfRange} chapter di luar daftar — akan dilewati saat mengunduh.
                </p>
              )}
              {alreadyDone > 0 && (
                <p className="mt-1 text-[11px] font-semibold text-ink-400">
                  {alreadyDone} chapter yang dipilih sudah terunduh sebelumnya — akan diunduh ulang.
                </p>
              )}
            </RangeSelectBar>
          </div>
        )}

        {chapters.length === 0 ? (
          <div className="text-center">
            <p className="text-3xl" aria-hidden>📕</p>
            <p className="mt-2 text-[13px] font-semibold text-ink-200">Belum ada chapter</p>
            <p className="mt-1 text-[11.5px] text-ink-500">
              Seri ini belum punya chapter yang bisa dibaca atau diunduh. Coba judul lain dari sumber yang sama.
            </p>
            <Link
              to="/cari"
              className="mt-3 inline-flex min-h-11 items-center rounded-xl bg-brand-amber px-5 py-2.5 text-[13px] font-bold text-white transition-colors active:scale-[0.97] active:duration-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-amber focus-visible:ring-offset-2 [@media(hover:hover)_and_(pointer:fine)]:hover:bg-brand-amber-soft"
            >
              Cari judul lain
            </Link>
          </div>
        ) : visibleRows.length === 0 ? (
          <p className="py-6 text-center text-[12.5px] text-ink-500">
            Tidak ada chapter yang cocok.
          </p>
        ) : (
          <ul className="divide-y divide-ink-800 overflow-hidden rounded-xl border border-ink-800 bg-ink-900">
            {visibleRows.map(({ chapter: c, index: i }) => {
              // Mode seleksi: tap dua baris menandai ujung rentang — tanpa centang 1-1.
              const anchor = pickMode && range.isAnchor(i)
              const selectedForRow = range.inRange(i) || (range.needEnd && anchor)
              // Chapter yang sudah pernah dibuka user → judul jadi abu (redup),
              // penanda tak hilang lewat aria-label "sudah dibaca".
              const read = isRead(c.number)
              const titleCls = read
                ? 'min-w-0 flex-1 truncate text-[13px] font-medium text-ink-500'
                : 'min-w-0 flex-1 truncate text-[13px] font-semibold text-ink-100'
              return (
                <li
                  key={c.native_id}
                  className={`reader-chapter-row relative flex items-center overflow-hidden ${
                    anchor
                      ? 'bg-brand-amber/10 ring-1 ring-inset ring-brand-amber/50'
                      : pickMode && selectedForRow
                        ? 'bg-brand-amber/5'
                        : ''
                  }`}
                >
                  {pickMode && selectedForRow && (
                    <span aria-hidden className="range-rail absolute left-0 top-0 h-full w-[3px] bg-brand-amber" />
                  )}
                  {pickMode ? (
                    <button
                      type="button"
                      aria-pressed={selectedForRow}
                      aria-label={
                        anchor
                          ? `Ujung rentang — chapter ${c.number}`
                          : selectedForRow
                            ? `Dalam rentang terpilih — chapter ${c.number}`
                            : `Pilih chapter ${c.number}${read ? ' — sudah dibaca' : ''}`
                      }
                      onClick={() => range.select(i)}
                      className="flex min-h-11 w-full items-center gap-3 px-3.5 py-3 text-left transition-colors [@media(hover:hover)_and_(pointer:fine)]:hover:bg-ink-850 active:bg-ink-850"
                    >
                      <span
                        aria-hidden
                        className={`grid size-5 shrink-0 place-items-center rounded-full border text-[11px] leading-none transition-[transform,background-color,border-color,opacity] duration-150 ease-[var(--ease-out)] ${
                          selectedForRow ? 'scale-100 border-brand-amber bg-brand-amber text-white opacity-100' : 'scale-95 border-ink-600 text-transparent opacity-60'
                        }`}
                      >
                        ✓
                      </span>
                      <span className={titleCls}>{chapterLabel(c)}</span>
                      <span className="shrink-0 text-[10.5px] font-medium text-ink-500">
                        {chapterDate(c)}
                      </span>
                    </button>
                  ) : (
                    <Link
                      to={readerHref(`${c.handle || handle}:${c.number}`)}
                      aria-label={
                        read
                          ? `${chapterLabel(c)} — sudah dibaca`
                          : `${chapterLabel(c)} — belum dibaca`
                      }
                      className="flex min-h-11 min-w-0 flex-1 items-center justify-between gap-3 px-3.5 py-3 transition-colors [@media(hover:hover)_and_(pointer:fine)]:hover:bg-ink-850 active:bg-ink-850"
                    >
                      <span className={titleCls}>{chapterLabel(c)}</span>
                      {c.source !== m.source && (
                        <SourceBadge source={c.source} className="shrink-0" />
                      )}
                      <span className="shrink-0 text-[10.5px] font-medium text-ink-500">
                        {chapterDate(c)}
                      </span>
                    </Link>
                  )}
                </li>
              )
            })}
          </ul>
        )}

        {pickMode && <div aria-hidden className="h-24" />}
        {!chapterQuery.trim() && chapters.length > 40 && (
          <button
            type="button"
            onClick={() => setShowAll((v) => !v)}
            className="mt-3 min-h-11 w-full rounded-xl border border-ink-700 py-2.5 text-[13px] font-medium text-ink-300 transition-colors active:scale-[0.97] active:duration-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-amber focus-visible:ring-offset-2"
          >
            {showAll ? 'Tampilkan lebih sedikit' : `Tampilkan semua ${chapters.length} chapter`}
          </button>
        )}
      </section>
      <SimilarSeriesAccordion key={handle} handle={handle} />
    </div>
  )
}

/**
 * Ringkasan hasil run yang baru selesai. Hanya dipanggil saat instance ini
 * MENYAKSIKAN transisi busy → selesai; kalau user sudah pindah halaman
 * (unmounted), Rak yang menampilkan progresnya.
 *
 * `errors` membawa `job.error` apa adanya supaya UI bisa menjelaskan
 * kegagalan (mis. "3 dari 40 halaman gagal disimpan"), bukan sekadar
 * menghitung chapter lalu menyebut semuanya "tersimpan".
 */
interface DlSummary {
  total: number
  range: string
  ok: number
  fail: number
  saved: number
  saveFailed: number
  mode: 'pdf' | 'cache'
  cancelled: boolean
  errors: { number: string; error: string }[]
}

function announceFinish(run: DlRun, mountedRef: { current: boolean }): DlSummary | null {
  if (!mountedRef.current) return null
  const ok = run.jobs.filter((j) => j.state === 'ok').length
  const failed = run.jobs.filter((j) => j.state === 'fail')
  const cancelled = failed.some((j) => j.error === 'Dibatalkan')
  // 'Dibatalkan' = penanda abort store, bukan kegagalan unduhan. Chapter yang
  // benar-benar gagal (error lain) tetap dilaporkan.
  const realFails = failed.filter((j) => j.error !== 'Dibatalkan')
  return {
    total: run.jobs.length,
    range: rangeLabel(run.jobs),
    ok,
    fail: realFails.length,
    saved: run.saved,
    saveFailed: run.saveFailed,
    mode: run.mode,
    cancelled,
    errors: realFails.map((j) => ({
      number: j.number,
      error: j.error || 'gagal diunduh',
    })),
  }
}

function dlSummaryHeadline(s: DlSummary): string {
  if (s.cancelled) {
    const saved = s.ok > 0 ? ` · ${s.ok} tersimpan` : ''
    return `Unduhan dibatalkan${saved}${s.fail > 0 ? ` · ${s.fail} gagal` : ''}`
  }
  return `${s.ok + s.fail}/${s.total} diproses · ${s.ok} tersimpan${s.fail > 0 ? ` · ${s.fail} gagal` : ''}`
}

/**
 * Label rentang untuk kartu ringkasan: "3–12" (1 chapter: "3").
 * Urutan tampil DESC (terbaru dulu), jadi angka diurutkan naik secara
 * numerik kalau bisa; nomor non-numerik jatuh ke urutan list apa adanya.
 */
function rangeLabel(list: readonly { number: string }[]): string {
  const first = list[0]?.number ?? ''
  const last = list[list.length - 1]?.number ?? ''
  if (list.length <= 1) return first
  const na = Number(first)
  const nb = Number(last)
  if (Number.isFinite(na) && Number.isFinite(nb) && na !== nb) {
    return na < nb ? `${first}–${last}` : `${last}–${first}`
  }
  return `${first}–${last}`
}

/** Placeholder tanggal kalau sumber tidak mengirim tanggal chapter. */
export const DATE_PLACEHOLDER = '—'

/**
 * Skor layak tampil? Server memakai "-" untuk "tanpa skor" (lihat api.ts),
 * dan sebagian sumber mengirim "0"/kosong — semuanya disembunyikan supaya
 * baris "Skor ★ 0" tidak muncul.
 */
export function hasScore(rating: string | null | undefined): boolean {
  if (rating == null) return false
  const s = String(rating).trim()
  if (!/\d/.test(s)) return false // '', '-', 'N/A' → tanpa skor
  const n = Number(s.replace(',', '.'))
  return !(Number.isFinite(n) && n === 0)
}

/**
 * Tanggal chapter untuk daftar: "12 Okt 2026" — atau placeholder "—" kalau
 * `updated_at` null/kosong/tidak valid, supaya baris tidak tampak pincang.
 */
export function chapterDate(c: { updated_at: number | null }): string {
  const t = c.updated_at
  if (t == null || !Number.isFinite(t)) return DATE_PLACEHOLDER
  const d = new Date(t)
  if (Number.isNaN(d.getTime())) return DATE_PLACEHOLDER
  return d.toLocaleDateString('id-ID')
}
