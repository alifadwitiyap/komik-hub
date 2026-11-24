import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom'
import Toast, { showToast as pushToast, showToastWithAction } from '../components/Toast'
import '../styles/reader.css'
import QueueDrawer from '../components/QueueDrawer'
import QueueNextCard from '../components/QueueNextCard'
import ChapterPickerSheet from '../components/ChapterPickerSheet'
import ComicImage from '../components/ComicImage'
import HeartButton from '../components/HeartButton'
import ReaderFooter from '../components/ReaderFooter'
import ReaderDownloadActions from '../components/ReaderDownloadActions'
import ReaderMenu from '../components/ReaderMenu'
import ReaderSettingsSheet from '../components/ReaderSettingsSheet'
import ReaderToolbar from '../components/ReaderToolbar'
import SourceBadge from '../components/SourceBadge'
import { imgSrc, imgUrl, mountAheadPx, slowLink } from '../imgUrl'
import { nextFillFrontier } from '../fillAhead'
import { tapHitsReaderControl } from '../readerControls'
import { createTapTracker } from '../tapTracker'
import { downloadChapterImages } from '../chapterOffline'
import { saveGeneratedPdf } from '../downloadBatch'
import { unifiedApi } from '../api'
import { getReaderSettings } from '../readerSettings'
import { useReaderSettings } from '../hooks/useReaderSettings'
import { useChromeOnScroll } from '../hooks/useChromeOnScroll'
import { useAutoFullscreen } from '../hooks/useAutoFullscreen'
import type { ChapterResponse } from '../types'
import { Empty } from '../App'
import { useProgress, type ProgressEntry } from '../hooks/useProgress'
import { useReaderOverlayHistory } from '../hooks/useReaderOverlayHistory'
import { useModeSwitch } from '../hooks/useModeSwitch'
import { didOpenChapter, rakMangaOf } from '../readingEvents'
import { isFavorite } from '../rakStore'
import { readingStatusForPage, visiblePageProgress, type ReadingStatus } from '../readingStatus'
import {
  advanceReadingQueue,
  loadReadingQueue,
  markQueueItemRead,
  queueReaderHref,
  saveReadingQueue,
  type ReadingQueueState,
} from '../readingQueue'
export { rakMangaOf }
import { anchorFrom, usableAnchor } from '../pageMemory'
import type { ReadingAnchor } from '../pageMemory'
import { measurePages, setScrollToAnchor } from '../readingPosition'
import {
  chapterKeyOf,
  loadChapter,
  parseUnifiedKey,
  readerHref,
  seriesHref,
} from '../readerSource'

/**
 * Reader satu chapter — UI replika Komiku+ v2.3.0 (activity_reader +
 * item_reader_header/footer + sheet_reader_settings):
 * toolbar transparan di atas gambar, tap tengah toggle chrome, footer reaksi
 * + komentar + "Baca Chapter Berikutnya", menu melayang + sheet preferensi.
 *
 * DUA ROUTE, SATU KOMPONEN:
 *   /baca/:chapterId            → flow Komiku lama (id numerik)
 *   /baca/:handle/:number       → flow unified (handle 'sumber:native_id')
 * Kunci chapter memakai bentuk "id" atau "sumber:id:n" (lihat readerSource.ts)
 * supaya anchor posisi, riwayat, dan cache offline jalan untuk keduanya.
 *
 * POSISI BACA PRESISI (Lane A): yang disimpan bukan "scroll ke-N" tapi anchor
 * {chapterId, pageId, offsetRatio} — halaman yang sedang ditatap (pageId =
 * URL gambar seperti di atribut src) + kedalaman posisi mata di halaman itu.
 * Saat chapter dibuka lagi, scroll dipulihkan tepat ke posisi itu, dan
 * karena rasio aspek tiap halaman diingat (ComicImage), tinggi halaman sudah
 * terpesan sebelum gambar decode — posisi tidak bergeser oleh layout-shift.
 */
type AlternateSourceLink = { label: string; href: string }

/**
 * A2 — fallback sumber: HANYA memakai tautan eksplisit yang memang sudah ada
 * di data chapter yang termuat. Tidak pernah merakit URL, menebak source, atau
 * mengarahkan ke endpoint baru. `ChapterResponse` hari ini tidak punya field
 * alternatif, jadi pill otomatis tersembunyi bila datanya tidak menyediakannya.
 */
function alternateSourceLinks(data: unknown): AlternateSourceLink[] {
  const raw = data as Record<string, unknown>
  const out: AlternateSourceLink[] = []
  const seen = new Set<string>()
  for (const bucket of [raw.alternate_sources, raw.alternates, raw.sources]) {
    const rows = Array.isArray(bucket)
      ? bucket
      : bucket && typeof bucket === 'object'
        ? Object.values(bucket)
        : []
    for (const row of rows) {
      if (!row || typeof row !== 'object') continue
      const r = row as Record<string, unknown>
      const href =
        typeof r.href === 'string'
          ? r.href
          : typeof r.url === 'string'
            ? r.url
            : null
      if (!href || seen.has(href)) continue
      // tolak skema non-http dan jangan pernah mengarang path relatif
      if (!href.startsWith('/') && !/^https?:\/\//i.test(href)) continue
      const label = [r.label, r.name, r.source, r.title].find(
        (v): v is string => typeof v === 'string' && v.length > 0,
      ) ?? 'Sumber lain'
      seen.add(href)
      out.push({ label, href })
      if (out.length >= 3) return out
    }
  }
  return out
}

function SourceFallback({
  source,
  links,
}: {
  source: string
  links: AlternateSourceLink[]
}) {
  if (links.length === 0) return null
  return (
    <div
      role="status"
      aria-live="polite"
      className="mx-auto mt-4 max-w-3xl rounded-2xl border border-brand-amber-dim/60 bg-black/70 px-4 py-3 text-center"
    >
      <p className="text-[12.5px] font-semibold text-white">
        Gambar bermasalah di {source} · Coba sumber lain
      </p>
      <div className="mt-2 flex flex-wrap items-center justify-center gap-2">
        {links.map((link) => (
          <a
            key={link.href}
            href={link.href}
            className="inline-flex min-h-11 items-center rounded-xl bg-brand-amber px-4 py-2.5 text-[12.5px] font-bold text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-amber"
          >
            {link.label}
          </a>
        ))}
      </div>
    </div>
  )
}

export default function Reader() {
  const params = useParams<{
    chapterId?: string
    handle?: string
    number?: string
  }>()
  const chapterId = chapterKeyOf(params.chapterId, params.handle, params.number)
  const [searchParams] = useSearchParams()
  const inQueue = searchParams.get('queue') === '1'
  const [queueState, setQueueState] = useState<ReadingQueueState | null>(() =>
    inQueue ? loadReadingQueue() : null,
  )
  const [queueDrawerOpen, setQueueDrawerOpen] = useState(false)
  const queueMarkedRef = useRef<string | null>(null)
  const [data, setData] = useState<ChapterResponse | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [attempt, setAttempt] = useState(0)
  // jumlah halaman yang BENAR-BENAR selesai dimuat (bukan prefix berurutan:
  // gambar bisa selesai decode bersilang, jadi yang dihitung himpunan
  // halaman complete — lihat onLoad ComicImage di flow bawah)
  const [loadedPages, setLoadedPages] = useState<Set<number>>(() => new Set())
  /** Panel yang gagal dimuat — dipakai pill fallback sumber (ambang >3). */
  const [failedPages, setFailedPages] = useState<Set<number>>(() => new Set())
  const loadedCount = loadedPages.size
  /** Halaman aktif untuk label "Hal. X dari N" — diisi dari efek anchor yang
   *  sama dengan penulisan progres (sumber tunggal, bukan hitungan baru). */
  const [activePage, setActivePage] = useState(1)
  /** Status baca eksplisit — tidak pernah ditebak dari gambar termuat. */
  const [readingStatus, setReadingStatus] = useState<ReadingStatus>('Sedang dibaca')
  /** true kalau viewport sudah menyentuh bawah halaman terakhir. */
  const atChapterEnd = useRef(false)
  // chrome (toolbar + footer) ikut arah scroll; selama restore anchor
  // (`pending.current`) berjalan scroll programatik TIDAK memicunya
  const chrome = useChromeOnScroll(() => pending.current !== null)
  const { settings, onChange, onReset, filterStyle, dimOpacity, warmOpacity } = useReaderSettings()
  const autoFS = useAutoFullscreen()
  const [menuOpen, setMenuOpen] = useState(false)
  const [sheetOpen, setSheetOpen] = useState(false)
  const [chapterPickerOpen, setChapterPickerOpen] = useState(false)
  const dismissOverlay = useReaderOverlayHistory(
    chapterPickerOpen ? 'chapter' : sheetOpen ? 'settings' : menuOpen ? 'menu' : null,
    () => {
      setChapterPickerOpen(false)
      setSheetOpen(false)
      setMenuOpen(false)
    },
  )
  void dismissOverlay
  // setToast dipertahankan karena ReaderSettingsSheet menerima prop ini;
  // sekarang semua notifikasi lewat store Toast (satu pesan, replace).
  const setToast = (m: string | null) => {
    if (m) pushToast(m)
  }
  const hairlineRef = useRef<HTMLDivElement | null>(null)
  const tap = useRef(createTapTracker(tapHitsReaderControl)).current
  const [zoom, setZoom] = useState(1)
  const [zoomOrigin, setZoomOrigin] = useState('50% 50%')
  const hudTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const restoreToastShown = useRef(false)
  const announceRestore = useCallback((pageIndex: number) => {
    if (restoreToastShown.current) return
    restoreToastShown.current = true
    showToastWithAction(`Melanjutkan dari Hal. ${pageIndex + 1}`, 'Ke awal', () => {
      window.scrollTo({
        top: 0,
        behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches
          ? 'instant'
          : 'smooth',
      })
    })
  }, [])
  useEffect(() => {
    restoreToastShown.current = false
  }, [chapterId])
  useEffect(() => () => {
    if (hudTimer.current) clearTimeout(hudTimer.current)
  }, [])
  const onTapUp = (e: ReactPointerEvent<HTMLDivElement>) => {
    tap.up(e.pointerId)
    const action = tap.resolve(
      e.clientX,
      e.clientY,
      performance.now(),
      window.innerWidth,
      settings.tapScroll,
    )
    if (hudTimer.current) clearTimeout(hudTimer.current)
    if (action.type === 'hud') {
      hudTimer.current = setTimeout(() => chrome.toggle(), 140)
    } else if (action.type === 'zoom') {
      const rect = flowRef.current?.getBoundingClientRect()
      setZoomOrigin(
        rect ? `${action.x - rect.left}px ${action.y - rect.top}px` : `${action.x}px ${action.y}px`,
      )
      setZoom((z) => (z > 1 ? 1 : 1.8))
    } else if (action.type === 'scroll') {
      window.scrollBy({
        top: action.direction * window.innerHeight * 0.75,
        behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches
          ? 'instant'
          : 'smooth',
      })
    }
  }
  const { save, recent } = useProgress()
  const { gotoMarathon } = useModeSwitch(chapterId)
  const navigate = useNavigate()

  // ---- antrean update (aktif hanya dengan ?queue=1) ------------------------
  const queueEnd = inQueue && data !== null && !!queueState?.active && readingStatus === 'Selesai'
  const queueItem = queueState?.items[queueState.currentIndex]
  const nextQueueItem = queueState?.items[queueState.currentIndex + 1]

  useEffect(() => {
    if (!queueEnd || !queueState || !queueItem) return
    const key = `${queueState.currentIndex}:${queueItem.titleKey}:${queueItem.targetChapter}`
    if (queueMarkedRef.current === key) return
    queueMarkedRef.current = key
    markQueueItemRead(queueState)
  }, [queueEnd, queueState, queueItem])

  const exitQueue = () => {
    if (!queueState) return
    markQueueItemRead(queueState)
    const exited = { ...queueState, active: false }
    saveReadingQueue(exited)
    setQueueState(exited)
    setQueueDrawerOpen(false)
  }

  const goQueueIndex = (index: number) => {
    if (!queueState) return
    markQueueItemRead(queueState)
    const picked = { ...queueState, currentIndex: index, active: true }
    saveReadingQueue(picked)
    setQueueState(picked)
    setQueueDrawerOpen(false)
    const item = picked.items[index]
    if (item) navigate(queueReaderHref(item))
  }

  const goQueueNext = () => {
    if (!queueState || !nextQueueItem) return
    markQueueItemRead(queueState)
    const advanced = advanceReadingQueue(queueState)
    saveReadingQueue(advanced)
    setQueueState(advanced)
    navigate(queueReaderHref(nextQueueItem))
  }

  // URL sumber asli halaman ini (hanya flow unified) — dipakai badge toolbar.
  // Kontrak v2: `source` = sumber yang MELAYANI halaman ini (bisa beda dari
  // handle di URL kalau terjadi fallback lintas-sumber).
  const source = data?.source ?? data?.series?.source ?? null

  const flowRef = useRef<HTMLDivElement | null>(null)
  /** anchor tersimpan chapter ini yang sedang dipulihkan (null = selesai) */
  const pending = useRef<ReadingAnchor | null>(null)
  /** penulis anchor aktif (dipasang efek; dipanggil juga saat gambar memuat) */
  const writeRef = useRef<(force: boolean) => void>(() => {})
  /** prefetch chapter berikutnya sudah dipicu (sekali per chapter) */
  const prefetchedNext = useRef(false)
  /** toast "tidak ada chapter berikutnya" cukup sekali per chapter */
  const noNextToast = useRef(false)
  /** frontier fill-ahead background: index halaman berikut yang dipanaskan */
  const [bgFillIdx, setBgFillIdx] = useState(0)

  // reset saat chapter berganti
  useEffect(() => {
    if (!chapterId) return
    setData(null)
    setError(null)
    setLoadedPages(new Set())
    setFailedPages(new Set())
    setImagesReady(false)
    pending.current = null
    prefetchedNext.current = false
    noNextToast.current = false
    setBgFillIdx(0)
    setActivePage(1)
    setReadingStatus('Sedang dibaca')
    atChapterEnd.current = false
    setQueueDrawerOpen(false)
    queueMarkedRef.current = null
    if (inQueue) {
      const saved = loadReadingQueue()
      if (saved) setQueueState(saved)
    }
    // React Router v7 TIDAK reset scroll saat rute berubah → chapter baru
    // akan tampil di posisi scroll chapter lama (bawah). Scroll ke atas
    // SEBELUM fetch; kalau chapter ini punya anchor tersimpan, efek restore
    // di bawah yang memindahkannya ke posisi baca terakhir.
    window.scrollTo({ top: 0 })
    // chapter baru = konteks baru: chrome tampil lagi, jangan warisi
    // keadaan tersembunyi dari chapter sebelumnya
    chrome.show()
    autoFS.reset()
    const ctrl = new AbortController()
    // A1 — naikkan generasi SEBELUM fetch; respons yang kembali membawa
    // nomor generasi ini. Kalau user sudah pindah chapter, nomor basi.
    const gen = ++genRef.current
    loadChapter(chapterId, ctrl.signal)
      .then((d) => {
        // A1 — respons basi: abaikan total (gambar/badge/riwayat tidak disentuh)
        if (genRef.current !== gen) return
        setData(d)
        if (d.switched_from) pushToast('Sumber bacaan diganti otomatis')
        // CHAPTER DIBUKA → tandai "sudah dibaca" + catat riwayat rak (satu
        // definisi di readingEvents.ts). Reader: penuh (mark + rak).
        //
        // Field WAJIB dipetakan eksplisit: `ChapterResponse` memakai
        // snake_case (`title_key`, `series_handle`), sedangkan `ChapterOpen`
        // memakai camelCase (`titleKey`, `handle`). Meneruskan `d` mentah
        // membuat `d.titleKey` undefined -> `markChapterRead` early-return
        // -> mark "sudah dibaca" tak pernah dibuat (bug senyap: semua field
        // ChapterOpen opsional, jadi TS tak menangkapnya).
        didOpenChapter({
          titleKey: d.title_key ?? null,
          number: d.chapter.number == null ? null : String(d.chapter.number),
          historyNumber: d.chapter.number == null ? null : String(d.chapter.number),
          title: d.series?.title ?? d.chapter.name,
          coverUrl: d.series_cover ?? d.series?.cover ?? null,
          source: d.source ?? d.series?.source ?? '',
          handle: d.series_handle ?? '',
        })
      })
      .catch((e: Error) => {
        if (genRef.current !== gen) return
        if (e.name === 'AbortError') return
        console.error('[reader] load chapter failed', e)
        setError('Terjadi kendala saat memuat chapter. Coba lagi.')
      })
    return () => ctrl.abort()
  }, [chapterId, attempt])

  const images = data?.images ?? []

  // HeartButton punya feedback inline; reader mengumumkan hasilnya lewat
  // toast tanpa mengubah komponen bersama itu (event 'rak-change').
  useEffect(() => {
    const key = data?.title_key
    if (!key) return
    const onRak = () =>
      pushToast(isFavorite(key) ? 'Ditambahkan ke favorit' : 'Dihapus dari favorit')
    window.addEventListener('rak-change', onRak)
    return () => window.removeEventListener('rak-change', onRak)
  }, [data?.title_key])

  // Dimensi asli dari server (baca header, belum decode) → rasio w/h tiap
  // halaman. Dipakai ComicImage untuk reserve tinggi SEBELUM gambar selesai
  // di-decode — ini sumber utama perbaikan CLS.
  const knownRatios = useMemo(
    () =>
      (data?.image_sizes ?? []).map((s) =>
        s && s[0] > 0 && s[1] > 0 ? s[0] / s[1] : undefined,
      ),
    [data],
  )

  // "Unduh offline": simpan byte chapter ini ke cache (via service worker)
  // agar kebaca saat internet/server mati. Terpisah dari ekspor PDF (Series).
  const [downloading, setDownloading] = useState(false)
  const onOfflineDownload = useCallback(async () => {
    if (downloading || images.length === 0) return
    setDownloading(true)
    setToast('Mengunduh offline…')
    let last = 0
    const { ok, fail } = await downloadChapterImages(images, (done) => {
      if (done !== last) {
        last = done
        setToast(`Mengunduh offline… ${done}/${images.length}`)
      }
    })
    // Hangatkan cache API chapter: request pertama saat load bisa balapan dengan
    // aktivasi service worker (belum masuk cache). Re-request lewat SW sekarang
    // memastikan metadata chapter tersimpan → reload offline tidak kena 504.
    try {
      await loadChapter(chapterId)
    } catch {
      /* metadata sudah di memori; cache API tetap hangat kalau SW menangkap */
    }
    setDownloading(false)
    setToast(
      fail === 0
        ? `Chapter tersimpan offline (${ok} halaman).`
        : `Tersimpan ${ok}, ${fail} gagal — coba lagi nanti.`,
    )
  }, [downloading, images, chapterId])

  // B2 — Seberapa jauh di luar layar gambar boleh mulai diminta. Dasar skala
  // mengikuti preferensi reader (hemat/seimbang/siapkan) & Save-Data, lalu
  // naik lembut seiring pembaca maju (max ~2x dasar). Dihitung ulang saat
  // scroll (rAF ringan) — bukan sekali per mount.
  const [mountAhead, setMountAhead] = useState<number>(() =>
    mountAheadPx(typeof window !== 'undefined' ? window.innerHeight : 800),
  )
  useEffect(() => {
    let raf = 0
    let base = 0
    const update = () => {
      raf = 0
      const vh = window.innerHeight
      if (base === 0) base = mountAheadPx(vh)
      const total = document.documentElement.scrollHeight - vh
      const p = total > 0 ? Math.min(1, window.scrollY / total) : 0
      const next = Math.round(base * (1 + p)) // horizon: base → 2x base
      // Hairline progres: tulis langsung ke style, TANPA setState per frame.
      if (hairlineRef.current) {
        hairlineRef.current.style.transform = `scaleX(${p})`
      }
      setMountAhead((prev) => (Math.abs(prev - next) > 24 ? next : prev))
    }
    const onScroll = () => {
      if (!raf) raf = requestAnimationFrame(update)
    }
    window.addEventListener('scroll', onScroll, { passive: true })
    window.addEventListener('resize', onScroll)
    return () => {
      window.removeEventListener('scroll', onScroll)
      window.removeEventListener('resize', onScroll)
      if (raf) cancelAnimationFrame(raf)
    }
  }, [])

  // B4 — Fill-ahead kontinu: jadwalkan pemuatan halaman di BELAKANG frontier
  // `bgFillIdx` lewat imgQueue (tanpa menunggu IntersectionObserver sempit).
  // Frontier naik MONOTON seiring tick (waktu), bukan cuma posisi scroll.
  // Scroll boleh mempercepat saat pembaca melompat, tapi tidak boleh menjadi
  // satu-satunya pemicu — kalau tidak, chapter mandek setelah burst awal.
  // Rantai setTimeout (pengganti requestIdleCallback yang jarang menembak di
  // headless) + interval 250ms supaya tidak mencuri frame utama. Fetch
  // sungguhan tetap dibatasi imgQueue; ini cuma target MOUNT.
  useEffect(() => {
    if (!data || images.length === 0) return
    const mode = getReaderSettings().prefetchMode
    const slow = slowLink() || mode === 'hemat'
    const n = images.length
    let timer: ReturnType<typeof setTimeout>
    let ticks = 0
    const tick = () => {
      ticks += 1
      const vh = window.innerHeight
      const total = document.documentElement.scrollHeight - vh
      const p = total > 0 ? Math.min(1, Math.max(0, window.scrollY / total)) : 0
      setBgFillIdx((prev) =>
        nextFillFrontier({ prev, ticks, pageCount: n, slow, scrollProgress: p }),
      )
      timer = setTimeout(tick, 250)
    }
    timer = setTimeout(tick, 50)
    return () => clearTimeout(timer)
  }, [data, images.length])

  // A1 — guard navigasi basi: setiap load chapter (ganti chapterId) menaikkan
  // counter; kalau respons lama kembali setelah user sudah pindah, respons itu
  // DIBUANG — tidak setState gambar/badge/riwayat.
  const genRef = useRef(0)

  // A2 — riwayat atomik: hanya ditulis setelah gambar BENAR-BENAR dimuat,
  // bukan saat fetch resolve. `imagesReady` menyala sekali per chapter.
  const [imagesReady, setImagesReady] = useState(false)
  // ref dipakai write() yang selalu membaca nilai terbaru tanpa re-bind
  const readyRef = useRef(false)
  readyRef.current = imagesReady
  /**
   * A2 — sumber saat ini dibuka. Chapter saat ini melayani `source`
   * (bisa beda dari handle asal karena fallback lintas-sumber).
   */
  const activeSource = data?.source ?? data?.series?.source ?? null
  const activeHandle =
    parseUnifiedKey(chapterId)?.handle ??
    (typeof data?.series?.id === 'string' ? data.series.id : null)

  // Masuk maraton dari menu/sheet: wariskan posisi baca reader (halaman +
  // offset) supaya tidak balik ke awal rantai. Dulunya ada di tombol apung.
  const enterMarathon = useCallback(() => {
    const seriesKey = activeHandle ?? String(data?.series?.id ?? chapterId)
    const prog = recent.find(
      (r: ProgressEntry) =>
        String(r.chapterId) === chapterId &&
        String(r.seriesId) === seriesKey,
    )
    gotoMarathon(
      prog?.pageId
        ? {
            chapterKey: chapterId,
            seriesKey,
            activeKey: chapterId,
            pageId: prog.pageId,
            offsetRatio: prog.offsetRatio ?? 0,
            blocks: 1,
            chapterIdx: 0,
          }
        : undefined,
    )
  }, [activeHandle, data?.series?.id, chapterId, recent, gotoMarathon])

  // Ekspor PDF (unified-only): generate server-side, masuk tab Unduhan di Rak.
  const [exportingPdf, setExportingPdf] = useState(false)
  // Hasil ekspor yang gagal diserahkan ke perangkat — tampilkan blok persisten
  // di ReaderDownloadActions (tombol Ambil PDF / tautan Rak).
  const [pdfResult, setPdfResult] = useState<{ id: string; filename: string } | null>(null)
  // Reset blok PDF persisten saat ganti chapter (Reader tidak remount karena route tanpa key).
  useEffect(() => {
    setPdfResult(null)
  }, [chapterId])
  const onExportPdf = useCallback(async () => {
    const u = parseUnifiedKey(chapterId)
    if (!u || exportingPdf) return
    setExportingPdf(true)
    setToast('Membuat PDF…')
    try {
      const res = await unifiedApi.downloadPdf(u.handle, u.number)
      const delivered = await saveGeneratedPdf(res.id, res.filename)
      if (delivered) {
        setPdfResult(null)
        setToast(`PDF siap: ${res.filename} — unduhan dimulai`)
      } else {
        setPdfResult({ id: res.id, filename: res.filename })
        setToast('PDF sudah dibuat, tapi unduhan otomatis gagal — ambil lewat tombol di bawah atau di Rak → Unduhan')
      }
    } catch {
      setToast('Gagal membuat PDF — coba lagi nanti.')
    } finally {
      setExportingPdf(false)
    }
  }, [chapterId, exportingPdf])

  /** setel scroll ke anchor; return true kalau posisi sudah final */
  const apply = (idx: number, anchor: ReadingAnchor): boolean => {
    const el = flowRef.current?.querySelector<HTMLElement>(`[data-page="${idx}"]`)
    if (!el) return false
    // Label halaman ikut posisi yang dipulihkan, bukan menunggu scroll event
    // (scroll programatik sengaja tidak menulis progres saat restore).
    setActivePage(idx + 1)
    return setScrollToAnchor(el, anchor)
  }

  // ---- pulihkan posisi baca ------------------------------------------------
  // Anchor dipulihkan setelah data chapter tiba. Kalau tinggi halaman pemilik
  // anchor belum final (gambar belum decode), efek retry di bawah mengulang
  // saat `loadedCount` bertambah sampai posisi benar-benar pas.
  useEffect(() => {
    if (!data || images.length === 0 || !chapterId) return
    const seriesKey = String(data.series?.id ?? chapterId)
    const entry = recent.find(
      (r) => String(r.chapterId) === String(chapterId) && String(r.seriesId) === seriesKey,
    )
    // A2 — PINDAH SUMBER: kalau chapter ini dilayani sumber berbeda dari
    // kunjungan lalu (fallback), riwayat posisi halaman sengaja TIDAK
    // dipulihkan — anchor lama milik gambar sumber sebelumnya, nomor halaman
    // bisa beda urutan. Mulai dari halaman 1.
    if (entry?.source != null && activeSource != null && entry.source !== activeSource) return
    const anchor = usableAnchor(
      entry?.pageId
        ? {
            chapterId: entry.chapterId,
            pageId: entry.pageId,
            offsetRatio: entry.offsetRatio ?? 0,
            at: entry.at,
          }
        : null,
    )
    if (!anchor) return
    // pageId memakai hasil imgUrl() = persis nilai atribut src <img>
    const idx = images.findIndex((s) => imgUrl(s) === anchor.pageId)
    if (idx < 0) return // daftar gambar berubah sejak kunjungan lalu → abaikan
    pending.current = anchor
    const raf = requestAnimationFrame(() => {
      if (apply(idx, anchor)) {
        pending.current = null
        announceRestore(idx)
      }
    })
    return () => cancelAnimationFrame(raf)
    // `recent` sengaja tidak jadi dependensi: posisi dibaca sekali saat
    // chapter terbuka, bukan tiap kali penyimpanan menulis.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, chapterId, images.length])

  // retry restore: layout bergerak saat gambar (termasuk yang di atas anchor)
  // selesai decode — kejar sampai posisi final, lalu berhenti.
  useEffect(() => {
    if (!pending.current) return
    let raf = 0
    let tries = 0
    const attempt = () => {
      raf = 0
      const p = pending.current
      if (!p) return
      const idx = images.findIndex((s) => imgUrl(s) === p.pageId)
      if (idx >= 0 && apply(idx, p)) {
        pending.current = null
        announceRestore(idx)
        return
      }
      if (++tries > 180) {
        // ~3 detik: berhenti memaksa, jangan rebut kendali scroll dari pembaca
        pending.current = null
        return
      }
      raf = requestAnimationFrame(attempt)
    }
    raf = requestAnimationFrame(attempt)
    return () => {
      if (raf) cancelAnimationFrame(raf)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, loadedCount, images.length])

  // ---- prefetch chapter berikutnya (UX) ----
  // Saat pembaca masuk 80% halaman TERAKHIR chapter, hangatkan data +
  // halaman pertama chapter berikutnya supaya "Baca Berikutnya" instan.
  // Dilewati kalau mode hemat / saveData / koneksi lambat. Kalau chapter ini
  // yang terakhir, beri tahu sekali dari scroll yang sama (bukan tombol mati).
  useEffect(() => {
    if (!data || images.length === 0 || !chapterId) return
    const nextId = data.chapter?.next ? String(data.chapter.next.id) : null
    const lastSelector = `[data-page="${images.length - 1}"]`
    // Fraksi masuk ke halaman terakhir = sejauh mana viewport menutupi
    // halaman itu (0 = belum terlihat, 1 = halaman penuh terlewat).
    const intoLastPage = () => {
      const el = document.querySelector<HTMLElement>(lastSelector)
      if (!el) {
        const total = document.documentElement.scrollHeight - window.innerHeight
        return total > 0 ? Math.min(1, window.scrollY / total) : 0
      }
      const r = el.getBoundingClientRect()
      if (r.height <= 0) return 0
      return Math.max(0, Math.min(1, (window.innerHeight - r.top) / r.height))
    }
    const onScroll = () => {
      if (pending.current) return
      const progress = intoLastPage()
      if (!nextId) {
        if (progress >= 0.9 && !noNextToast.current) {
          noNextToast.current = true
          pushToast('Tidak ada chapter selanjutnya')
        }
        return
      }
      if (prefetchedNext.current || progress < 0.8) return
      prefetchedNext.current = true
      try {
        const mode = getReaderSettings().prefetchMode
        const conn = (
          typeof navigator !== 'undefined'
            ? (navigator as Navigator & { connection?: { saveData?: boolean } }).connection
            : undefined
        )
        if (mode === 'hemat' || conn?.saveData || slowLink()) return
      } catch {
        /* storage tertutup — lanjut default */
      }
      const ctrl = new AbortController()
      loadChapter(nextId, ctrl.signal)
        .then((d) => {
          // A2: metadata sudah diambil loadChapter; hangatkan 3 panel pertama.
          for (const u of (d.images ?? []).slice(0, 3)) {
            const im = new window.Image()
            im.src = imgSrc(u)
          }
        })
        .catch(() => {
          /* gagal prefetch — bukan error fatal; user tetap bisa buka manual */
        })
    }
    window.addEventListener('scroll', onScroll, { passive: true })
    return () => window.removeEventListener('scroll', onScroll)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, images.length, chapterId])

  // ---- simpan anchor posisi baca ------------------------------------------
  // Ditulis saat scroll (throttle), saat halaman gambar selesai muat, saat tab
  // disembunyikan/ditutup, dan saat keluar dari reader. Selama restore masih
  // berjalan penulisan dilewati supaya posisi pemulihan tidak menimpa anchor.
  useEffect(() => {
    if (!data || images.length === 0 || !chapterId) return
    const last = { pageId: '', t: 0 }
    const write = (force: boolean) => {
      // A2 — belum ada gambar yang benar-benar termuat → jangan tulis riwayat
      if (pending.current || !readyRef.current) return
      const flow = flowRef.current
      if (!flow) return
      // Identitas halaman diambil dari DATA via `data-page`, bukan atribut
      // `src`: src sudah lewat proxy `/img?u=…`, sementara `pageId`/`images`
      // memakai URL CDN asli. Memakai src membuat findIndex() selalu -1 →
      // progres 0 dan restore halaman selalu kembali ke halaman 1.
      const geometry = measurePages(flow, (el) => {
        const pi = Number((el as HTMLElement).dataset.page ?? '-1')
        const url = images[pi]
        return url ? imgUrl(url) : null
      }, 'img[data-page]')
      const pageIds = geometry.map((g) => g.pageId)
      const pageTops = geometry.map((g) => g.top)
      const pageHeights = geometry.map((g) => g.height)
      // Bawah halaman terakhir = chapter benar-benar habis (bukan sekadar
      // gambar terakhir termuat / halaman terakhir terlihat).
      const lastBottom = pageTops.length
        ? pageTops[pageTops.length - 1] + pageHeights[pageHeights.length - 1]
        : Number.POSITIVE_INFINITY
      atChapterEnd.current =
        pageIds.length > 0 &&
        window.scrollY + window.innerHeight >= lastBottom - 2
      const anchor = anchorFrom(
        chapterId,
        pageIds,
        window.scrollY,
        window.innerHeight,
        pageTops,
        pageHeights,
      )
      if (!anchor) return
      const now = Date.now()
      // tulis segera saat halaman aktif berubah; sisanya throttle 400 ms
      if (!force && anchor.pageId === last.pageId && now - last.t < 400) return
      last.pageId = anchor.pageId
      last.t = now
      const idx = images.findIndex((s) => imgUrl(s) === anchor.pageId)
      // Satu anchor → satu sumber kebenaran untuk progres DAN label halaman.
      setActivePage(idx >= 0 ? idx + 1 : 1)
      setReadingStatus(readingStatusForPage(idx + 1, images.length, atChapterEnd.current))
      save({
        seriesId: data.series?.id ?? chapterId,
        seriesTitle: data.series?.title ?? null,
        chapterId,
        chapterName: data.chapter.name,
        page: idx >= 0 ? idx : 0,
        progress: visiblePageProgress(idx + 1, images.length),
        pageId: anchor.pageId,
        offsetRatio: anchor.offsetRatio,
        // A2 — sumber & handle pelayan supaya series page bisa kirim
        // last_source, dan reader tahu kalau sumber pindah.
        source: activeSource,
        handle: activeHandle,
        // Status baca eksplisit: dibuka = "Sedang dibaca"; hanya "Selesai"
        // kalau halaman terakhir benar-benar habis digulir.
        status: readingStatusForPage(idx + 1, images.length, atChapterEnd.current),
        // Mode baca ikut disimpan supaya Beranda/Rak membuka kembali reader
        // yang sama (normal vs maraton) dengan posisi halaman yang sama.
        mode: 'normal',
      })
    }
    writeRef.current = write
    const onScroll = () => write(false)
    const onHide = () => {
      if (document.visibilityState === 'hidden') write(true)
    }
    window.addEventListener('scroll', onScroll, { passive: true })
    window.addEventListener('resize', onScroll)
    window.addEventListener('pagehide', onHide)
    document.addEventListener('visibilitychange', onHide)
    return () => {
      window.removeEventListener('scroll', onScroll)
      window.removeEventListener('resize', onScroll)
      window.removeEventListener('pagehide', onHide)
      document.removeEventListener('visibilitychange', onHide)
      write(true)
    }
    // `images` selalu identitas baru per render; panjang daftar cukup untuk
    // mengikat efek ke chapter yang benar
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, images.length, save, chapterId])

  // A2 — RIWAYAT ATOMIK: satu penulisan penuh (seriesKey, number, source,
  // handle, pageIndex) tepat setelah gambar pertama chapter selesai dimuat.
  // Catatan: write() di atas sudah ter-gate ready, jadi ini aman dipanggil
  // segera setelah imagesReady menyala.
  useEffect(() => {
    if (imagesReady && data && images.length > 0 && chapterId) {
      writeRef.current(true)
    }
  }, [imagesReady, data, images.length, chapterId])

  // gambar memuat → tinggi halaman berubah → perbarui anchor (dan simpan
  // pertama kali begitu halaman awal terukur, walau pembaca belum scroll)
  useEffect(() => {
    if (loadedCount > 0) {
      // A2 — gambar pertama benar-benar termuat: riwayat boleh ditulis.
      setImagesReady(true)
      writeRef.current(false)
    }
  }, [loadedCount])
  if (error)
    return (
      <div className="mx-auto max-w-3xl px-4 py-16 text-center">
        <Empty title="Gagal memuat chapter" body={error} />
        <button
          type="button"
          onClick={() => setAttempt((a) => a + 1)}
          className="mt-4 min-h-11 rounded-full bg-brand-amber px-5 py-2.5 text-[13px] font-bold text-white transition-colors active:scale-[0.97] active:duration-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-amber focus-visible:ring-offset-2 [@media(hover:hover)_and_(pointer:fine)]:hover:bg-brand-amber-soft"
        >
          Coba lagi
        </button>
      </div>
    )
  // chapter sukses tapi sumber tak kirim gambar: pesan jelas, jangan halaman kosong (QA gap D)
  if (data && images.length === 0) {
    const alternates = alternateSourceLinks(data)
    const sourceName = data.source ?? data.series?.source ?? 'sumber ini'
    return (
      <>
        <Empty
          title="Halaman tidak tersedia"
          body="Sumber belum mengirim gambar untuk chapter ini. Coba chapter lain atau kembali nanti."
        />
        <SourceFallback source={sourceName} links={alternates} />
      </>
    )
  }
  if (!data) {
    return (
      <div className="flex min-h-dvh flex-col items-center justify-center gap-8 bg-night px-6">
        <div role="status" aria-live="polite" className="flex flex-col items-center gap-3">
          <span
            aria-hidden="true"
            className="size-6 animate-spin rounded-full border-2 border-white/20 border-t-brand-red motion-reduce:animate-none"
          />
          <p className="text-[14px] font-medium text-white/85">Memuat…</p>
          <div className="h-0.5 w-44 overflow-hidden rounded-full bg-white/15">
            <div className="h-full w-1/3 animate-[loadbar_1.2s_ease-in-out_infinite] motion-reduce:animate-none rounded-full bg-brand-red" />
          </div>
        </div>
        {/* jalan keluar saat jaringan lambat / request menggantung */}
        <button
          type="button"
          onClick={() => navigate(-1)}
          className="min-h-11 rounded-xl border border-white/25 px-5 text-[13px] font-semibold text-white/85 active:bg-white/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/70"
        >
          Kembali
        </button>
        <style>{`@keyframes loadbar{0%{transform:translateX(-100%)}100%{transform:translateX(320%)}}`}</style>
      </div>
    )
  }

  const { chapter, series } = data
  const seriesId = series?.id
  // Status MEMUAT dipisah dari posisi baca — "Hal. X dari N" tetap akurat
  // walau sebagian gambar belum dimuat. Pembaca layar mendengar status ini
  // lewat role=status milik ReaderToolbar.
  const loadingImages = images.length > 0 && loadedCount < images.length
  const pageStatus = images.length ? `Hal. ${activePage} dari ${images.length}` : 'Hal. 0 dari 0'
  // Footer satu baris + scrubber 44px (±6.5rem termasuk safe-area).
  const footerSpacer = 'h-[calc(6.5rem+env(safe-area-inset-bottom))]'
  const nextKey = chapter.next ? String(chapter.next.id) : null
  const prevKey = chapter.previous ? String(chapter.previous.id) : null
  // id manga legacy (angka) — cuma ada di flow komiku lama. Flow unified
  // menyimpan handle 'sumber:native_id' di `series.id` (string), jadi angka
  // di sini selalu null untuk unified.
  const legacySeriesId = typeof seriesId === 'number' ? seriesId : null

  const chromeHidden = !chrome.visible || autoFS.active || autoFS.nativeActive
  const fsActive = autoFS.active || autoFS.nativeActive

  /** Scrubber footer: lepas slider → gulir ke panel itu, tanpa menulis ulang
   *  anchor progres secara paksa (efek scroll yang akan menyimpan posisi). */
  const seekPage = (page: number) => {
    const el = flowRef.current?.querySelector<HTMLElement>(`[data-reader-page="${page - 1}"]`)
    if (!el) return
    window.scrollTo({
      top: el.getBoundingClientRect().top + window.scrollY - 72,
      behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches
        ? 'instant'
        : 'smooth',
    })
  }

  return (
    // overflow-x-clip: jaring pengaman. Kalau satu gambar (mis. spread halaman
    // ganda) meluber ke samping, Chrome mobile menganggap halaman lebih lebar
    // dari viewport lalu melakukan shrink-to-fit — seluruh UI mengecil dan
    // "bergaris". Clip mencegahnya tanpa membuat scroll container (beda dari
    // overflow-hidden) dan tanpa memengaruhi elemen fixed.
    <div
      className={`relative min-h-dvh overflow-x-clip ${
        settings.paperLight || settings.canvasTheme === 'terang'
          ? 'reader-canvas-terang reader-canvas-paper'
          : settings.canvasTheme === 'oled'
            ? 'reader-canvas-oled'
            : settings.canvasTheme === 'sepia'
              ? 'reader-canvas-sepia'
              : settings.nightShift
                ? 'bg-night-dark'
                : 'reader-canvas'
      }`}
    >
      {/* Perisai malam + tint hangat: satu overlay tetap, bukan filter di
          setiap panel (z-40, tembus pointer). Kecerahan lama dipetakan ke
          overlay gelap; nightShift tetap memakai filter sepia di flow. */}
      {dimOpacity > 0 && (
        <div
          aria-hidden="true"
          className="reader-night-overlay"
          style={{ backgroundColor: `rgba(0,0,0,${dimOpacity})` }}
        />
      )}
      {warmOpacity > 0 && (
        <div
          aria-hidden="true"
          className="reader-night-overlay"
          style={{ backgroundColor: `rgba(255,160,70,${warmOpacity})` }}
        />
      )}
      {/* Progres baca 2px di pinggir atas. Transform ditulis rAF dari efek
          mountAhead — tidak ada setState per frame. */}
      <div
        ref={hairlineRef}
        aria-hidden="true"
        className="reader-progress-hairline"
      />
      {/**
       * Tap area baca: toggle chrome / eksekusi fullscreen saat ada niat.
       *
       * BUKAN <button> penuh layar: elemen ini sengaja `aria-hidden` supaya
       * pembaca layar tidak melihat "satu tombol raksasa" yang menelan seluruh
       * konten. Kontrol yang butuh fokus keyboard ada di toolbar + tombol
       * layar penuh.
       *
       * Guard tap-vs-drag: sentuhan yang bergeser >12px atau ditahan >900ms
       * (biasanya scroll/menahan halaman) TIDAK dianggap tap, jadi tidak
       * memicu fullscreen tak sengaja. Kontrol melingkar (muat ulang halaman)
       * dirender lewat portal di atas lapisan ini — lihat ComicImage.
       */}
      <div
        aria-hidden="true"
        data-testid="reader-tap-layer"
        className="reader-tap-layer fixed inset-0 z-10 touch-manipulation select-none [-webkit-touch-callout:none]"
        onPointerDown={(e) => {
          tap.down(e.pointerId, e.pointerType, e.clientX, e.clientY, performance.now())
        }}
        onPointerUp={onTapUp}
        onPointerCancel={(e) => tap.cancel(e.pointerId)}
      />
      {/* Pengumuman untuk pembaca layar: status fullscreen adalah perilaku yang
          tidak terlihat, jadi keadaannya harus bisa didengar. */}
      <p role="status" aria-live="polite" className="sr-only">
        {fsActive ? 'Layar penuh aktif.' : ''}
      </p>

      <ReaderToolbar
        title={chapter.name}
        subtitle={pageStatus}
        loadingLabel={loadingImages ? 'Memuat gambar…' : null}
        progress={visiblePageProgress(activePage, images.length)}
        status={readingStatus}
        onBack={() => navigate(seriesHref(seriesId) ?? '/')}
        titleHref={seriesHref(seriesId)}
        onHome={() => navigate('/')}
        onShare={() => setToast('Bagikan: salin URL halaman ini')}
        onMore={() => setMenuOpen(true)}
        chip={settings.marathon ? 'Maraton' : null}
        badge={source && source !== 'komiku' ? <SourceBadge source={source} /> : null}
        visible={!chromeHidden}
        heart={
          data.title_key && data.series_handle ? (
            <HeartButton manga={rakMangaOf(data, data.title_key)} />
          ) : null
        }
      />
      <ReaderFooter
        prevName={chapter.previous?.name ?? null}
        prevHref={prevKey ? readerHref(prevKey) : null}
        nextName={chapter.next?.name ?? null}
        nextHref={nextKey ? readerHref(nextKey) : null}
        onPickChapter={() => setChapterPickerOpen(true)}
        visible={!chromeHidden}
        pageCount={images.length}
        activePage={activePage}
        onSeek={seekPage}
      />

      <ChapterPickerSheet
        open={chapterPickerOpen}
        onClose={() => dismissOverlay()}
        chapterKey={chapterId}
        legacySeriesId={legacySeriesId}
        seriesTitle={series?.title ?? null}
        titleKey={data?.title_key ?? null}
      />

      <Toast />

      {/* Halaman manga — filter kecerahan/perisai malam diterapkan di sini */}
      {/* 2b — sumber pindah (fallback): SATU baris kecil berisi catatan
          persis dari server. User tetap tenang, tanpa dialog. */}
      {data.switched_from && data.note ? (
        // Warna teks memakai token PERMUKAAN BACA (bukan ink-* yang berubah
        // mengikuti tema app): latar reader selalu putih atau #131313, jadi
        // ink-500 versi tema gelap (#9aa0a8) hanya 2,5:1 di atas putih.
        <p
          role="status"
          aria-live="polite"
          className={`mx-auto max-w-3xl px-4 pr-16 pt-[calc(env(safe-area-inset-top)+3.5rem)] text-[12px] leading-relaxed max-sm:text-[12.5px] max-sm:leading-[1.7] ${
            settings.paperLight ? 'text-reader-muted' : 'text-reader-muted-night'
          }`}
        >
          {data.note}
        </p>
      ) : null}
      {/*
        FLOW RAPAT — satu kolom tanpa jarak antar halaman.

        Webtoon: lebar penuh (edge-to-edge), halaman menempel seperti strip
        manhwa. Gulir Halaman: lebar kolom baca (max-w-3xl) di tengah.

        DULU mode webtoon membungkus tiap halaman dengan
        `flex h-dvh items-center justify-center` + gambar `max-h-dvh
        object-contain`. Dua akibatnya, dua-duanya terlihat sebagai "garis":
          1. object-contain memaksa gambar masuk kotak 100dvh → sisa ruang di
             kiri/kanan (atau atas/bawah) terisi warna holder = pita abu-abu
             vertikal di tiap halaman.
          2. Holder adalah flex item dengan lebar content-based, jadi
             `max-w-full` pada <img> tidak punya acuan (persentase terhadap
             lebar tak tentu = none) → gambar selebar atribut `width` (1000px)
             untuk satu frame. Chrome mobile lalu melakukan shrink-to-fit:
             layout viewport melebar (375 → 688) dan SELURUH halaman
             diperkecil. Itu sumber tampilan "menyempit + bergaris" di HP.

        Sekarang tidak ada tinggi paksa dan tidak ada object-contain: setiap
        halaman mengalir setinggi rasio aslinya, menempel persis halaman
        berikutnya.
      */}
      <div
        ref={flowRef}
        className={`reader-zoom-flow reader-flow mx-auto flex w-full flex-col ${
          settings.readMode === 'webtoon' ? '' : 'max-w-3xl'
        }`}
        style={{
          ...filterStyle,
          transformOrigin: zoomOrigin,
          transform: zoom > 1 ? `scale(${zoom})` : undefined,
        }}
      >
        {images.map((src, i) => (
          <div key={`${chapter.id}-${i}`} data-reader-page={i} className="reader-page w-full">
            <ComicImage
              src={src}
              alt={`${chapter.name} halaman ${i + 1}`}
              pageIndex={i}
              knownRatio={knownRatios[i]}
              // B2: 3 panel pertama eager + fetchPriority high (LCP + antrean
              // mobile); sisanya lazy/async lewat IntersectionObserver.
              eager={i < 3}
              // Halaman aktif (anchor progres) adalah halaman yang sedang
              // dibaca. Tandai ±2 halaman sebagai dekat viewport supaya
              // imgQueue mendahulukannya dari halaman fill-ahead (B4).
              nearViewport={Math.abs(i + 1 - activePage) <= 2}
              // B2: horizon adaptif saat scroll (mountAhead tumbuh 3x).
              // B4: halaman di belakang frontier fill-ahead dipaksa mount dengan
              // mountAhead raksasa → antre di imgQueue (satu-satu) hingga memuat.
              mountAhead={i <= bgFillIdx ? 500000 : mountAhead}
              onLoad={() => {
                setLoadedPages((s) => (s.has(i) ? s : new Set(s).add(i)))
              }}
              onSettled={(ok) => {
                if (ok) return
                setFailedPages((s) => (s.has(i) ? s : new Set(s).add(i)))
              }}
              // block + w-full: tidak ada baseline gap inline, tidak ada
              // letterbox — lebar gambar selalu = lebar kolom baca.
              className="manga-img block w-full"
            />
          </div>
        ))}
      </div>

      {failedPages.size > 3 && (
        <SourceFallback
          source={data.source ?? data.series?.source ?? 'sumber ini'}
          links={alternateSourceLinks(data)}
        />
      )}

      {/* Kartu akhir chapter: DI LUAR flow (flow punya filter → stacking
          context) supaya tidak tertimpa tap layer z-10. */}
      {nextKey && (
        <div className="relative z-20 mx-auto w-full max-w-3xl px-4 pt-4">
          <Link
            to={readerHref(nextKey)}
            className="tactile-press flex min-h-14 w-full items-center justify-center rounded-2xl bg-brand-amber px-4 text-center text-[15px] font-bold text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-amber"
          >
            Lanjut ke Chapter Berikutnya →
          </Link>
        </div>
      )}

      {/* Antrean update: section khusus di bawah tombol chapter berikutnya,
          supaya dua jalur tidak saling menimpa. */}
      {queueEnd && queueItem && nextQueueItem && (
        <QueueNextCard
          item={nextQueueItem}
          index={(queueState?.currentIndex ?? 0) + 1}
          total={queueState?.items.length ?? 0}
          onNext={goQueueNext}
          onOpenDrawer={() => setQueueDrawerOpen(true)}
          onFinish={exitQueue}
        />
      )}
      {queueEnd && queueItem && !nextQueueItem && (
        <section className="relative z-20 mx-auto w-full max-w-3xl px-4 pt-5 text-center" aria-label="Antrean selesai">
          <p className="text-[13px] font-semibold text-ink-100">Semua update favorit sudah terbaca</p>
          <Link
            to="/rak?tab=favorit"
            className="kh-tap mt-2 inline-flex min-h-11 items-center rounded-xl border border-ink-700 px-5 text-[13px] font-bold text-ink-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-amber"
          >
            Kembali ke Rak
          </Link>
        </section>
      )}
      <QueueDrawer
        open={queueDrawerOpen}
        items={queueState?.items ?? []}
        currentIndex={queueState?.currentIndex ?? 0}
        onClose={() => setQueueDrawerOpen(false)}
        onPick={goQueueIndex}
        onExit={exitQueue}
      />

      {/* Ruang bawah untuk footer satu baris (+ safe-area). */}
      <div className={footerSpacer} />

      <ReaderMenu
        open={menuOpen}
        settings={settings}
        fullscreenActive={fsActive}
        onClose={() => dismissOverlay()}
        onChange={(patch) => {
          // toggle Maraton dari reader: pindah mode marathon chapter ini
          if (patch.marathon === true && !settings.marathon) {
            setMenuOpen(false)
            enterMarathon()
            return
          }
          onChange(patch)
        }}
        onOpenSettings={() => {
          setMenuOpen(false)
          setSheetOpen(true)
        }}
        onToggleFullscreen={() => {
          if (fsActive) {
            autoFS.reset()
            chrome.show()
          } else autoFS.requestEnter()
        }}
      />

      <ReaderSettingsSheet
        open={sheetOpen}
        settings={settings}
        onClose={() => dismissOverlay()}
        onChange={(patch) => {
          if (patch.marathon === true && !settings.marathon) {
            setSheetOpen(false)
            enterMarathon()
            return
          }
          onChange(patch)
        }}
        onReset={onReset}
        setToast={setToast}
        downloadActions={
          <ReaderDownloadActions
            exportingPdf={exportingPdf}
            downloading={downloading}
            onExportPdf={parseUnifiedKey(chapterId) ? onExportPdf : undefined}
            onOfflineDownload={onOfflineDownload}
            pdfResult={pdfResult}
            onPdfResultDismiss={() => setPdfResult(null)}
          />
        }
      />
    </div>
  )
}
