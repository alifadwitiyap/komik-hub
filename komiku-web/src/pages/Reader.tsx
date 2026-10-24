import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import ChapterPickerSheet from '../components/ChapterPickerSheet'
import ComicImage from '../components/ComicImage'
import HeartButton from '../components/HeartButton'
import ReaderFooter from '../components/ReaderFooter'
import ReaderMenu from '../components/ReaderMenu'
import ReaderSettingsSheet from '../components/ReaderSettingsSheet'
import ReaderToolbar from '../components/ReaderToolbar'
import SourceBadge from '../components/SourceBadge'
import { imgSrc, imgUrl, mountAheadPx } from '../imgUrl'
import { downloadChapterImages } from '../chapterOffline'
import { unifiedApi } from '../api'
import { useReaderSettings } from '../hooks/useReaderSettings'
import { useChromeOnScroll } from '../hooks/useChromeOnScroll'
import { useAutoFullscreen } from '../hooks/useAutoFullscreen'
import type { ChapterResponse, Manga } from '../types'
import { Empty } from '../App'
import { useProgress } from '../hooks/useProgress'
import { chapterNumberOf, markChapterRead } from '../readMarks'
import { anchorFrom, scrollYForAnchor, usableAnchor } from '../pageMemory'
import type { ReadingAnchor } from '../pageMemory'
import * as rakStore from '../rakStore'
import {
  chapterKeyOf,
  loadChapter,
  marathonHref,
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
/**
 * Snapshot series untuk rak dari respons chapter unified. `title_key` dari
 * server (MangaOut/UnifiedSeries) — JANGAN normalisasi judul di JS.
 *
 * Diekspor supaya wiring-check bisa memverifikasi bentuk snapshot yang benar-
 * benar ditulis reader ke rakStore (bukan hanya tipe TS-nya).
 */
export function rakMangaOf(d: ChapterResponse, titleKey: string): rakStore.RakManga & {
  title_key: string
} {
  const series: Manga | null = d.series ?? null
  return {
    title_key: titleKey,
    title: series?.title ?? d.chapter.name,
    cover_url: d.series_cover ?? series?.cover ?? null,
    handle: d.series_handle ?? '',
    source: d.source ?? series?.source ?? '',
  }
}

export default function Reader() {
  const params = useParams<{
    chapterId?: string
    handle?: string
    number?: string
  }>()
  const chapterId = chapterKeyOf(params.chapterId, params.handle, params.number)
  const [data, setData] = useState<ChapterResponse | null>(null)
  const [error, setError] = useState<string | null>(null)
  // jumlah halaman yang BENAR-BENAR selesai dimuat (bukan prefix berurutan:
  // gambar bisa selesai decode bersilang, jadi yang dihitung himpunan
  // halaman complete — lihat onLoad ComicImage di flow bawah)
  const [loadedPages, setLoadedPages] = useState<Set<number>>(() => new Set())
  const loadedCount = loadedPages.size
  // chrome (toolbar + footer) ikut arah scroll; selama restore anchor
  // (`pending.current`) berjalan scroll programatik TIDAK memicunya
  const chrome = useChromeOnScroll(() => pending.current !== null)
  const { settings, onChange, onReset, filterStyle } = useReaderSettings()
  const autoFS = useAutoFullscreen(
    settings.autoFullscreen && !settings.fullscreen,
    () => pending.current !== null,
  )
  const [menuOpen, setMenuOpen] = useState(false)
  const [sheetOpen, setSheetOpen] = useState(false)
  const [chapterPickerOpen, setChapterPickerOpen] = useState(false)
  const [toast, setToast] = useState<string | null>(null)
  const { save, recent } = useProgress()
  const navigate = useNavigate()

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

  // reset saat chapter berganti
  useEffect(() => {
    if (!chapterId) return
    setData(null)
    setError(null)
    setLoadedPages(new Set())
    setImagesReady(false)
    pending.current = null
    prefetchedNext.current = false
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
        // CHAPTER DIBUKA → tandai "sudah dibaca" (per akun). Kunci =
        // title_key series + nomor chapter, sama dengan yang dipakai halaman
        // series, jadi mark langsung nyambung dengan baris daftarnya.
        // Nubuat: reader unified bisa fallback ke sumber lain, tapi title_key
        // tetap milik series yang diminta — itu yang kita tandai.
        markChapterRead(d.title_key, chapterNumberOf(d.chapter))
        // RAK BUKU — chapter sukses dimuat → tulis sejarah (snapshot lokal,
        // lintas-sumber via title_key). Flow Komiku lama (id angka) tak punya
        // title_key dari server → riwayatnya tetap dijalankan useProgress.
        if (d.title_key && d.series_handle) {
          const num = d.chapter.number == null ? '' : String(d.chapter.number)
          if (num) rakStore.recordRead(rakMangaOf(d, d.title_key), num)
        }
      })
      .catch((e: Error) => {
        if (genRef.current !== gen) return
        e.name !== 'AbortError' && setError(e.message)
      })
    return () => ctrl.abort()
  }, [chapterId])

  const images = data?.images ?? []

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

  // Seberapa jauh di luar layar gambar boleh mulai diminta. Skalanya mengikuti
  // preferensi reader (hemat 0,4 · seimbang 1,5 · siapkan 3 viewport) dan
  // dipaksa hemat saat Save-Data/2G. Dihitung sekali per mount: nilai ini yang
  // menentukan berapa byte yang berebut di detik pertama.
  const mountAhead = useMemo(
    () => mountAheadPx(typeof window !== 'undefined' ? window.innerHeight : 800),
    [],
  )

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

  // Ekspor PDF (unified-only): generate server-side, masuk tab Unduhan di Rak.
  const [exportingPdf, setExportingPdf] = useState(false)
  const onExportPdf = useCallback(async () => {
    const u = parseUnifiedKey(chapterId)
    if (!u || exportingPdf) return
    setExportingPdf(true)
    setToast('Membuat PDF…')
    try {
      const res = await unifiedApi.downloadPdf(u.handle, u.number)
      setToast(`PDF siap: ${res.filename}`)
    } catch {
      setToast('Gagal membuat PDF — coba lagi nanti.')
    } finally {
      setExportingPdf(false)
    }
  }, [chapterId, exportingPdf])

  /** setel scroll ke anchor; return true kalau posisi sudah final */
  const apply = (idx: number, anchor: ReadingAnchor): boolean => {
    const el = flowRef.current?.querySelector<HTMLElement>(`[data-page="${idx}"]`)
    if (!el || el.offsetHeight === 0) return false
    const top = el.getBoundingClientRect().top + window.scrollY
    const target = scrollYForAnchor(anchor.offsetRatio, top, el.offsetHeight, window.innerHeight)
    if (Math.abs(window.scrollY - target) > 1) window.scrollTo({ top: target })
    // tinggi baru pasti setelah halaman pemilik anchor selesai decode
    const img = el instanceof HTMLImageElement ? el : el.querySelector('img')
    return !!img?.complete && img.naturalWidth > 0
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
      if (apply(idx, anchor)) pending.current = null
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
  // Saat pembaca hampir mencapai akhir chapter, hangatkan data + halaman
  // pertama chapter berikutnya sehingga "Baca Berikutnya" terasa instan.
  // Dilewati kalau mode hemat / saveData aktif (jangan boros bandwidth).
  // Pemicu pakai scroll threshold (>= ~600px dari dasar), lebih deterministik
  // daripada IntersectionObserver di lingkungan ini.
  useEffect(() => {
    if (!data || images.length === 0 || !chapterId) return
    const nextId = data.chapter?.next ? String(data.chapter.next.id) : null
    if (!nextId || prefetchedNext.current) return
    try {
      const raw = localStorage.getItem('komiku.web.reader.settings.v1')
      const mode = raw ? (JSON.parse(raw) as { prefetchMode?: string }).prefetchMode : undefined
      const conn = (
        typeof navigator !== 'undefined'
          ? (navigator as Navigator & { connection?: { saveData?: boolean } }).connection
          : undefined
      )
      if (mode === 'hemat' || conn?.saveData) return
    } catch {
      /* storage tertutup — lanjut default */
    }
    const scrollable = () =>
      document.documentElement.scrollHeight - window.innerHeight
    const onScroll = () => {
      if (prefetchedNext.current) return
      if (window.scrollY >= scrollable() - 600) {
        prefetchedNext.current = true
        const ctrl = new AbortController()
        loadChapter(nextId, ctrl.signal)
          .then((d) => {
            const firstImg = d.images?.[0]
            if (firstImg) {
              // Panaskan lewat proxy pada lebar yang BENAR-BENAR dipilih browser.
              // Kontainer reader 768 px + DPR 2 → srcset 480/640/900 memilih 900w,
              // jadi prefetch 480/640 dulu tidak pernah terpakai: transisi chapter
              // tetap dingin (terukur 4,3 s). Byte asli di-cache server, jadi satu
              // fetch upstream cukup untuk semua lebar.
              const im = new window.Image()
              im.src = imgSrc(firstImg, 900)
            }
          })
          .catch(() => {
            /* gagal prefetch — bukan error fatal; user tetap bisa buka manual */
          })
      }
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
      const els = flow.querySelectorAll<HTMLImageElement>('img[data-page]')
      const pageIds: string[] = []
      const pageTops: number[] = []
      const pageHeights: number[] = []
      for (const el of els) {
        const src = el.getAttribute('src')
        if (!src || el.offsetHeight === 0) continue // belum terukur → lewati
        pageIds.push(src)
        pageTops.push(el.getBoundingClientRect().top + window.scrollY)
        pageHeights.push(el.offsetHeight)
      }
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
      save({
        seriesId: data.series?.id ?? chapterId,
        seriesTitle: data.series?.title ?? null,
        chapterId,
        chapterName: data.chapter.name,
        page: idx >= 0 ? idx : 0,
        progress: idx >= 0 ? (idx + 1) / images.length : 0,
        pageId: anchor.pageId,
        offsetRatio: anchor.offsetRatio,
        // A2 — sumber & handle pelayan supaya series page bisa kirim
        // last_source, dan reader tahu kalau sumber pindah.
        source: activeSource,
        handle: activeHandle,
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
  // toast (komentar/bagikan) — hilang otomatis
  useEffect(() => {
    if (!toast) return
    const t = setTimeout(() => setToast(null), 2200)
    return () => clearTimeout(t)
  }, [toast])

  if (error) return <Empty title="Gagal memuat chapter" body={error} />
  // chapter sukses tapi sumber tak kirim gambar: pesan jelas, jangan halaman kosong (QA gap D)
  if (data && images.length === 0) {
    return (
      <Empty
        title="Halaman tidak tersedia"
        body="Sumber belum mengirim gambar untuk chapter ini. Coba chapter lain atau kembali nanti."
      />
    )
  }
  if (!data) {
    return (
      <div className="grid min-h-screen place-items-center bg-night">
        <div className="flex flex-col items-center gap-3">
          <span className="size-6 animate-spin rounded-full border-2 border-white/20 border-t-brand-red" />
          <p className="text-[14px] text-white/80">Memuat…</p>
          <div className="h-0.5 w-44 overflow-hidden rounded-full bg-white/15">
            <div className="h-full w-1/3 animate-[loadbar_1.2s_ease-in-out_infinite] rounded-full bg-brand-red" />
          </div>
        </div>
        <style>{`@keyframes loadbar{0%{transform:translateX(-100%)}100%{transform:translateX(320%)}}`}</style>
      </div>
    )
  }

  const { chapter, series } = data
  const seriesId = series?.id
  const pct = images.length
    ? Math.min(100, Math.round((loadedCount / images.length) * 100))
    : 0
  const nextKey = chapter.next ? String(chapter.next.id) : null
  const prevKey = chapter.previous ? String(chapter.previous.id) : null
  // id manga legacy (angka) — cuma ada di flow komiku lama. Flow unified
  // menyimpan handle 'sumber:native_id' di `series.id` (string), jadi angka
  // di sini selalu null untuk unified.
  const legacySeriesId = typeof seriesId === 'number' ? seriesId : null

  const chromeHidden = !chrome.visible || autoFS.active || autoFS.nativeActive

  return (
    <div className={`relative min-h-screen ${settings.nightShift ? 'bg-night-dark' : 'bg-white'}`}>
      {/* tap tengah: toggle chrome. Saat ada niat (pending) → eksekusi
          fullscreen (tap = gesture asli). Saat aktif → keluar. */}
      <button
        aria-label={
          autoFS.pending
            ? 'Masuk fullscreen'
            : chromeHidden && !autoFS.active && !autoFS.nativeActive
              ? 'Tampilkan kontrol'
              : chromeHidden
                ? 'Keluar fullscreen / sembunyikan'
                : 'Sembunyikan kontrol'
        }
        onClick={() => {
          if (autoFS.pending) autoFS.requestEnter()
          else if (autoFS.active || autoFS.nativeActive) autoFS.reset()
          else chrome.toggle()
        }}
        className="fixed inset-0 z-10"
      />
      {/* tombol fullscreen manual — jalur eksplisit (fallback iOS / saat
          pending hangus). Muncul bareng chrome biar gak ganggu baca. */}
      <button
        aria-label="Masuk fullscreen"
        title="Masuk fullscreen"
        onClick={() => autoFS.requestEnter()}
        className={`fixed left-1/2 top-16 z-40 flex min-h-[44px] min-w-[112px] items-center justify-center rounded-full border border-white/25 bg-black/70 px-5 text-[13px] font-semibold text-white shadow-lg transition-opacity select-none touch-manipulation ${
          chrome.visible ? 'opacity-100' : 'pointer-events-none opacity-0'
        }`}
      >
        ⛶ Layar penuh
      </button>

      <ReaderToolbar
        title={chapter.name}
        subtitle={`${series?.title ?? 'Memuat…'} · ${pct}%`}
        onBack={() => navigate(seriesHref(seriesId) ?? '/')}
        onHome={() => navigate('/')}
        onShare={() => setToast('Bagikan: salin URL halaman ini')}
        onDownload={onOfflineDownload}
        onExportPdf={parseUnifiedKey(chapterId) ? onExportPdf : undefined}
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
        nextName={chapter.next?.name ?? null}
        nextHref={nextKey ? readerHref(nextKey) : null}
        prevName={chapter.previous?.name ?? null}
        prevHref={prevKey ? readerHref(prevKey) : null}
        onPickChapter={() => setChapterPickerOpen(true)}
        visible={!chromeHidden}
      />

      <ChapterPickerSheet
        open={chapterPickerOpen}
        onClose={() => setChapterPickerOpen(false)}
        chapterKey={chapterId}
        legacySeriesId={legacySeriesId}
        seriesTitle={series?.title ?? null}
        titleKey={data?.title_key ?? null}
      />

      {toast && (
        <p className="fixed bottom-28 left-1/2 z-40 -translate-x-1/2 rounded-full bg-black/80 px-4 py-2 text-[12px] text-white">
          {toast}
        </p>
      )}

      {/* Halaman manga — filter kecerahan/perisai malam diterapkan di sini */}
      {/* 2b — sumber pindah (fallback): SATU baris kecil berisi catatan
          persis dari server. User tetap tenang, tanpa dialog. */}
      {data.switched_from && data.note ? (
        <p className="mx-auto max-w-3xl px-4 pt-2 text-[11px] text-ink-500">{data.note}</p>
      ) : null}
      <div ref={flowRef} className="mx-auto flex max-w-3xl flex-col" style={filterStyle}>
        {images.map((src, i) => (
          <div
            key={`${chapter.id}-${i}`}
            className={
              settings.readMode === 'webtoon'
                ? 'flex h-screen w-full items-center justify-center'
                : ''
            }
          >
            <ComicImage
              src={src}
              alt={`${chapter.name} halaman ${i + 1}`}
              pageIndex={i}
              // HANYA halaman pertama yang langsung diminta (LCP + prioritas
              // tinggi). Sisanya menunggu sampai dekat layar — dulu 3 halaman
              // eager + margin lazy bawaan Chrome membuat 9 gambar / 1,7 MB
              // berebut, dan halaman yang sedang dibaca kalah (53 detik di 3G).
              eager={i === 0}
              mountAhead={mountAhead}
              onLoad={() => {
                setLoadedPages((s) => (s.has(i) ? s : new Set(s).add(i)))
              }}
              className={
                settings.readMode === 'webtoon'
                  ? 'manga-img max-h-full max-w-full object-contain'
                  : 'manga-img w-full'
              }
            />
          </div>
        ))}
        <div className="h-10" />
      </div>

      <ReaderMenu
        open={menuOpen}
        settings={settings}
        onClose={() => setMenuOpen(false)}
        onChange={(patch) => {
          // toggle Maraton dari reader: pindah mode marathon chapter ini
          if (patch.marathon === true && !settings.marathon) {
            setMenuOpen(false)
            navigate(marathonHref(chapterId))
            return
          }
          onChange(patch)
        }}
        onOpenSettings={() => {
          setMenuOpen(false)
          setSheetOpen(true)
        }}
      />

      <ReaderSettingsSheet
        open={sheetOpen}
        settings={settings}
        onClose={() => setSheetOpen(false)}
        onChange={onChange}
        onReset={onReset}
      />
    </div>
  )
}
