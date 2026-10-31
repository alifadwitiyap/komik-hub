import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import ChapterPickerSheet from '../components/ChapterPickerSheet'
import ComicImage from '../components/ComicImage'
import ReaderFooter from '../components/ReaderFooter'
import ReaderFullscreenButton from '../components/ReaderFullscreenButton'
import ReaderMarathonToggle from '../components/ReaderMarathonToggle'
import ReaderMenu from '../components/ReaderMenu'
import ReaderSettingsSheet from '../components/ReaderSettingsSheet'
import ReaderToolbar from '../components/ReaderToolbar'
import SourceBadge from '../components/SourceBadge'
import { imgUrl, mountAheadPx } from '../imgUrl'
import { tapHitsReaderControl } from '../readerControls'
import { useReaderSettings } from '../hooks/useReaderSettings'
import { useChromeOnScroll } from '../hooks/useChromeOnScroll'
import { useAutoFullscreen } from '../hooks/useAutoFullscreen'
import { useMarathonMemory } from '../hooks/useMarathonMemory'
import { anchorFrom, scrollYForAnchor } from '../pageMemory'
import { handleOf } from '../marathonMemory'
import type { ChapterResponse } from '../types'
import { Empty } from '../App'
import { useProgress } from '../hooks/useProgress'
import * as rakStore from '../rakStore'
import { chapterNumberOf, markChapterRead } from '../readMarks'
import {
  chapterKeyOf,
  loadChapter,
  marathonHref,
  readerHref,
  seriesHref,
} from '../readerSource'

/** Satu blok chapter di dalam rantai maraton. */
interface Block {
  chapterId: string
  chapterName: string
  seriesId: number | string | null
  seriesTitle: string | null
  /** sumber manga (hanya unified, null untuk komiku lama) */
  source?: string
  images: string[]
  nextId: string | null
  nextName: string | null
  prevId: string | null
  prevName: string | null
  /** title_key series (untuk mark "sudah dibaca") */
  titleKey?: string | null
  /** nomor chapter (untuk mark "sudah dibaca") */
  number?: string | null
  /** snapshot rak: judul + sampul + handle/sumber (supaya sesi maraton
   *  benar-benar masuk "Lanjut membaca" & Rak, tidak hanya progress). */
  title: string
  coverUrl: string | null
  handle: string
}

const MAX_BLOCKS = 40 // batas aman: makin dari ini = sudah ~seribu halaman

/** Kunci blok berikutnya (rendah = chapter lebih awal). */
function nextChapterId(d: ChapterResponse): string | null {
  return d.chapter.next ? String(d.chapter.next.id) : null
}

/**
 * MODE MARATON — pengalaman seperti aplikasi.
 *
 * Bedanya dengan reader biasa: saat scroll mencapai halaman terakhir chapter,
 * chapter BERIKUTNYA langsung dimuat dan ditempel di bawahnya. Tidak ada tombol,
 * tidak ada jeda, tidak ada halaman akhir. Scroll terus sampai puasa.
 *
 * Batas sengaja ada (MAX_BLOCKS) dan progres dihitung berdasarkan halaman
 * terbawah yang sudah ter-render, supaya riwayat tetap masuk akal.
 *
 * Route: /maraton/:chapterId (komiku lama) DAN /maraton/:handle/:number
 * (unified). Chaining memakai kunci chapter (lihat readerSource.ts) supaya
 * urutan "next" tetap benar di kedua flow.
 */
export default function ReaderMarathon() {
  const params = useParams<{
    chapterId?: string
    handle?: string
    number?: string
  }>()
  const chapterId = chapterKeyOf(params.chapterId, params.handle, params.number)
  const [blocks, setBlocks] = useState<Block[]>([])
  const [error, setError] = useState<string | null>(null)
  const [tailIdx, setTailIdx] = useState(-1) // index gambar terakhir yang ter-render
  /**
   * PEMULIHAN POSISI — dulu maraton SELALU mulai dari puncak channel (tidak ada
   * restore), jadi meninggalkan halaman = kehilangan seluruh sesi. Sekarang:
   *
   *   `pendingRef` = posisi tersimpan yang sedang dipulihkan (null = selesai).
   *   `wantBlocks` = berapa blok yang harus dibangun ulang sebelum restore
   *                  dijalankan (0 = tidak ada restore, rantai jalan normal).
   *   `restoreKey` = kunci chapter blok aktif yang dituju.
   *
   * Selama `pendingRef` belum null, penulisan posisi DILEWATI supaya scroll
   * programatik tidak menimpa posisi yang sedang dipulihkan (pola sama dengan
   * Reader.tsx).
   */
  const pendingRef = useRef<{ pageId: string; offsetRatio: number } | null>(null)
  const flowRef = useRef<HTMLDivElement | null>(null)
  const [wantBlocks, setWantBlocks] = useState(0)
  const [restoreKey, setRestoreKey] = useState<string | null>(null)
  // chrome tidak boleh bereaksi pada scroll programatik saat restore
  const chrome = useChromeOnScroll(() => pendingRef.current !== null)
  const [menuOpen, setMenuOpen] = useState(false)
  const [sheetOpen, setSheetOpen] = useState(false)
  const [chapterPickerOpen, setChapterPickerOpen] = useState(false)
  const [toast, setToast] = useState<string | null>(null)
  const [nextLoadFailed, setNextLoadFailed] = useState(false)
  /** sedang mengambil chapter berikutnya — untuk status "memuat" di dasar */
  const [loadingNext, setLoadingNext] = useState(false)
  /** awal gesture tap — membedakan tap dari scroll (sama seperti Reader) */
  const tapStart = useRef<{ x: number; y: number; t: number } | null>(null)
  const bottomRef = useRef<HTMLDivElement | null>(null)
  /** chapterId yang sudah/sedang di-fetch — cegah fetch ganda & loop abort */
  const fetchedRef = useRef<Set<string>>(new Set())
  const { save } = useProgress()
  const marathon = useMarathonMemory()
  // posisi maraton dibaca SEKALI saat mount (bukan tiap kali store menulis),
  // lalu disimpan di ref supaya efek lain tidak perlu bergantung padanya
  const savedPosRef = useRef<ReturnType<typeof marathon.forChapter>>(null)
  const navigate = useNavigate()
  const { settings, onChange, onReset, filterStyle } = useReaderSettings()
  /**
   * Layar penuh di maraton: HANYA jalur manual (tombol). Auto-fullscreen
   * dihapus — scroll adalah cara membaca, tap cuma toggle chrome.
   */
  const autoFS = useAutoFullscreen()
  const fsActive = autoFS.active || autoFS.nativeActive
  // seberapa jauh di luar layar halaman boleh mulai diminta (lihat ComicImage)
  const mountAhead = useMemo(
    () => mountAheadPx(typeof window !== 'undefined' ? window.innerHeight : 800),
    [],
  )

  // sumber dari blok yang sedang dibaca (hanya unified) — dipakai badge toolbar
  const [readBlock, setReadBlock] = useState(0)
  const [readInBlock, setReadInBlock] = useState(1)
  const curSource = blocks[readBlock]?.source ?? null

  const pushBlock = useCallback((b: Block) => {
    setBlocks((prev) => (prev.some((x) => x.chapterId === b.chapterId) ? prev : [...prev, b]))
  }, [])

  // chapter pertama — sekaligus MERENCANAKAN pemulihan posisi.
  //
  // Rencana dibuat di sini (bukan di efek terpisah) karena hanya di titik ini
  // `chapterId` sudah pasti dan rantai masih kosong. `wantBlocks` = jumlah blok
  // yang harus dibangun ulang; `restoreKey` = blok yang dituju. Rantai dibangun
  // ulang penuh (0..target) supaya pembaca bisa menggulir ke ATAS seperti sesi
  // aslinya — bukan hanya satu blok yang menggantung.
  useEffect(() => {
    if (!chapterId) return
    setBlocks([])
    setTailIdx(-1)
    setError(null)
    setNextLoadFailed(false)
    setLoadingNext(false)
    // indeks gambar global kembali dari 0 → penanda settled harus dikosongkan
    setSettled(new Set())
    // channel baru: chrome tampil lagi (jangan warisi keadaan tersembunyi)
    chrome.show()

    // ---- rencana restore ------------------------------------------------
    // Sesi dikenali dari blok PERTAMA rantai. Kalau route ini memang blok
    // pertama sebuah sesi tersimpan, bangun ulang sampai blok aktifnya.
    const saved = marathon.forChapter(chapterId)
    savedPosRef.current = saved
    if (saved) {
      setWantBlocks(Math.max(1, Math.min(saved.chapterIdx + 1, saved.blocks || 1)))
      setRestoreKey(saved.activeKey)
      pendingRef.current = { pageId: saved.pageId, offsetRatio: saved.offsetRatio }
    } else {
      setWantBlocks(0)
      setRestoreKey(null)
      pendingRef.current = null
    }

    const ctrl = new AbortController()
    loadChapter(chapterId, ctrl.signal)
      .then((d) => pushBlock(toBlock(d, params.handle)))
      .catch((e: Error) => e.name !== 'AbortError' && setError(e.message))
    return () => ctrl.abort()
    // `marathon` sengaja tidak jadi dependensi: posisi dibaca sekali saat
    // rute dibuka, bukan tiap kali store menulis (lihat savedPosRef).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chapterId, pushBlock])

  // ---- BANGUN ULANG RANTAI untuk pemulihan -------------------------------
  // Dijalankan berurutan (satu per render) sampai jumlah blok mencapai
  // `wantBlocks`. Berurutan, bukan paralel: urutan blok menentukan posisi
  // piksel, dan chaining normal juga menambah satu per satu.
  useEffect(() => {
    if (wantBlocks <= 0) return
    if (blocks.length === 0) return
    if (blocks.length >= wantBlocks) return
    const nextId = blocks[blocks.length - 1]?.nextId
    if (!nextId || fetchedRef.current.has(nextId)) return
    fetchedRef.current.add(nextId)
    const ctrl = new AbortController()
    loadChapter(nextId, ctrl.signal)
      .then((d) => pushBlock(toBlock(d)))
      .catch(() => {
        // gagal: hentikan pembangunan rantai, jangan loop. Restore tetap
        // dicoba pada blok yang berhasil dimuat.
        fetchedRef.current.delete(nextId)
        setWantBlocks(blocks.length)
      })
    return () => ctrl.abort()
  }, [blocks, wantBlocks, pushBlock])

  /**
   * ---- PULIHKAN POSISI ---------------------------------------------------
   * Berjalan setelah blok tujuan benar-benar ada di DOM. Tinggi halaman
   * dipesan lewat rasio aspek (ComicImage + pageMemory), jadi posisi bisa
   * dihitung sebelum gambar decode — tapi retry di bawah tetap mengejar
   * sampai posisinya final, karena gambar di ATAS anchor bisa menyusul dan
   * menggeser layout.
   *
   * PENTING: halaman dicari lewat INDEKS (blok + halaman), BUKAN atribut
   * `src`. `ComicImage` sengaja TIDAK memasang `src` sampai gambar dekat
   * layar (hemat byte), jadi halaman tujuan belum punya `src` saat restore
   * berjalan — mencari lewat `src` tak pernah ketemu dan posisi selalu
   * kembali ke atas.
   */
  const applyRestore = useCallback((pageId: string, offsetRatio: number): boolean => {
    const root = flowRef.current
    if (!root) return false
    // cari (blok, halaman) pemilik `pageId` dari DATA, bukan dari DOM
    let bi = -1
    let pi = -1
    for (let i = 0; i < blocks.length && bi < 0; i++) {
      const idx = blocks[i].images.findIndex((s) => imgUrl(s) === pageId)
      if (idx >= 0) {
        bi = i
        pi = idx
      }
    }
    if (bi < 0) return false
    const el = root.querySelector<HTMLImageElement>(`img[data-b="${bi}"][data-page="${pi}"]`)
    if (!el || el.offsetHeight === 0) return false
    const top = el.getBoundingClientRect().top + window.scrollY
    const target = scrollYForAnchor(offsetRatio, top, el.offsetHeight, window.innerHeight)
    if (Math.abs(window.scrollY - target) > 1) window.scrollTo({ top: target })
    // tinggi final hanya setelah halaman pemilik posisi selesai decode
    return !!el.complete && el.naturalWidth > 0
  }, [blocks])

  useEffect(() => {
    const p = pendingRef.current
    if (!p) return
    if (blocks.length === 0) return
    // blok tujuan harus sudah ada; kalau belum, tunggu (efek jalan lagi
    // setiap `blocks` bertambah)
    if (restoreKey && !blocks.some((b) => b.chapterId === restoreKey)) return
    let raf = 0
    let tries = 0
    const attempt = () => {
      raf = 0
      const cur = pendingRef.current
      if (!cur) return
      if (applyRestore(cur.pageId, cur.offsetRatio)) {
        pendingRef.current = null
        return
      }
      // ~3 detik: berhenti memaksa, jangan rebut kendali scroll dari pembaca
      if (++tries > 180) {
        pendingRef.current = null
        return
      }
      raf = requestAnimationFrame(attempt)
    }
    raf = requestAnimationFrame(attempt)
    return () => {
      if (raf) cancelAnimationFrame(raf)
    }
  }, [blocks, restoreKey, applyRestore])

  const totalPages = blocks.reduce((n, b) => n + b.images.length, 0)
  const head = blocks[0]
  const tail = blocks[blocks.length - 1]

  // chapter TERAKHIR — dipakai gerbang chaining DAN (di bawah) jaring
  // pengaman scroll, jadi dideklarasikan sebelum keduanya.
  const lastBlock = blocks[blocks.length - 1]

  /**
   * GERBANG CHAINING — indeks global gambar yang SUDAH beres (termuat ATAU
   * gagal). Gagal ikut dihitung supaya satu gambar rusak tidak menahan rantai
   * selamanya; pembaca tetap melihat chip "Coba lagi" di tempatnya.
   */
  const [settled, setSettled] = useState<Set<number>>(() => new Set())
  const markSettled = useCallback((g: number) => {
    setSettled((s) => (s.has(g) ? s : new Set(s).add(g)))
  }, [])

  // chapter TERAKHIR baru boleh memicu chaining kalau SEMUA gambarnya beres:
  // kalau komik belum ke-load semua, chapter berikutnya tidak dinyalakan —
  // pembaca tidak menemui lubang kosong di tengah chapter.
  const lastBlockStart = totalPages - (lastBlock?.images.length ?? 0)
  const lastBlockSettled =
    !!lastBlock &&
    lastBlock.images.length > 0 &&
    lastBlock.images.every((_, i) => settled.has(lastBlockStart + i))

  // progres: halaman ke-`tailIdx` (global) sudah tampil
  useEffect(() => {
    if (blocks.length === 0 || tailIdx < 0) return
    // cari chapter pemilik index global itu
    let acc = 0
    let owner: Block | null = null
    let local = 0
    for (const b of blocks) {
      if (tailIdx < acc + b.images.length) {
        owner = b
        local = tailIdx - acc
        break
      }
      acc += b.images.length
    }
    if (!owner) return
    // Riwayat rak: Reader memanggil recordRead di :153; maraton sebelumnya
    // tidak pernah — jadi sesi maraton tidak muncul di "Lanjut membaca"
    // maupun Rak. Ini yang membuat mode unggulan produk itu "tidak ada"
    // di riwayat.
    if (owner.handle && owner.titleKey) {
      rakStore.recordRead(
        {
          title: owner.title,
          cover_url: owner.coverUrl,
          handle: owner.handle,
          source: owner.source ?? '',
          title_key: owner.titleKey,
        },
        owner.number ?? String(owner.chapterId),
      )
    }
    // pageId = gambar yang sedang aktif (indeks global `tailIdx`). Riwayat
    // (progress) tetap mencatat halaman itu; offsetRatio 0 sudah cukup untuk
    // riwayat. POSISI PRESISI maraton disimpan terpisah di bawah (marathon
    // store), karena di sana yang penting adalah halaman + kedalaman posisi
    // mata + blok aktif, bukan "halaman ke-N di chapter ini".
    save({
      seriesId: owner.seriesId ?? owner.chapterId,
      seriesTitle: owner.seriesTitle,
      chapterId: owner.chapterId,
      chapterName: owner.chapterName,
      page: local,
      progress: (tailIdx + 1) / Math.max(1, totalPages),
      pageId: owner.images[local] ?? undefined,
      offsetRatio: 0,
      source: owner.source ?? null,
      handle: owner.handle || null,
    })
  }, [tailIdx, blocks, totalPages, save])

  /**
   * ---- SIMPAN POSISI MARATON (presisi) -----------------------------------
   * Ditulis saat scroll (throttle rAF), saat halaman berganti, dan saat
   * halaman ditinggalkan. Dilewati selama restore berjalan (`pending`) supaya
   * scroll programatik tidak menimpa posisi yang sedang dipulihkan.
   *
   * Yang disimpan: halaman yang sedang ditatap (`pageId`) + kedalaman posisi
   * mata di halaman itu (`offsetRatio`), blok aktif, dan jumlah blok yang
   * sudah termuat. Itu yang membuat "Buka Maraton" bisa kembali TEPAT ke
   * tempat pembaca berhenti, bukan ke awal rantai.
   */
  useEffect(() => {
    if (blocks.length === 0) return
    if (!head) return
    let raf = 0
    let lastPage = ''
    let lastAt = 0

    const write = (force: boolean) => {
      // restore sedang berjalan → jangan tulis posisi hasil scroll programatik
      if (pendingRef.current) return
      const root = flowRef.current
      if (!root) return
      const imgs = Array.from(root.querySelectorAll<HTMLImageElement>('img[data-b]'))
      // Identitas halaman diambil dari DATA (blok+halaman → URL), bukan atribut
      // `src`: `ComicImage` belum memasang `src` untuk gambar yang jauh dari
      // layar, jadi membaca `src` akan kehilangan sebagian besar halaman dan
      // anchor jadi salah.
      const pageIds: string[] = []
      const pageTops: number[] = []
      const pageHeights: number[] = []
      for (const im of imgs) {
        const bi = Number(im.dataset.b ?? '-1')
        const pi = Number(im.dataset.page ?? '-1')
        const url = blocks[bi]?.images[pi]
        if (!url || im.offsetHeight === 0) continue // belum terukur → lewati
        pageIds.push(imgUrl(url))
        pageTops.push(im.getBoundingClientRect().top + window.scrollY)
        pageHeights.push(im.offsetHeight)
      }
      if (pageIds.length === 0) return
      // anchor memakai kunci chapter blok PERTAMA sebagai identitas sesi;
      // anchorFrom hanya butuh nilai apa pun untuk chapterId.
      const anchor = anchorFrom(head.chapterId, pageIds, window.scrollY, window.innerHeight, pageTops, pageHeights)
      if (!anchor) return
      const now = Date.now()
      // tulis segera saat halaman aktif berubah; sisanya throttle 400 ms
      if (!force && anchor.pageId === lastPage && now - lastAt < 400) return
      lastPage = anchor.pageId
      lastAt = now
      // blok pemilik halaman ini → `activeKey` + indeksnya
      let owner = head
      let ownerIdx = 0
      for (let i = 0; i < blocks.length; i++) {
        if (blocks[i].images.some((s) => imgUrl(s) === anchor.pageId)) {
          owner = blocks[i]
          ownerIdx = i
          break
        }
      }
      marathon.save({
        chapterKey: head.chapterId,
        // identitas series: handle unified, atau id manga numerik flow lama
        seriesKey:
          head.handle && head.handle !== ''
            ? head.handle
            : String(head.seriesId ?? head.chapterId),
        activeKey: owner.chapterId,
        pageId: anchor.pageId,
        offsetRatio: anchor.offsetRatio,
        blocks: blocks.length,
        chapterIdx: ownerIdx,
      })
    }

    const onScroll = () => {
      if (!raf) raf = requestAnimationFrame(() => {
        raf = 0
        write(false)
      })
    }
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
      if (raf) cancelAnimationFrame(raf)
      // keluar dari maraton → simpan posisi terakhir
      write(true)
    }
    // `blocks` di dependensi: blok baru mengubah pemilik halaman/indeks blok.
    // `marathon` sengaja tidak (save stabil per render store).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [blocks, head?.chapterId, marathon.save])

  // maraton = chaining selalu aktif (tanpa hambatan).
  const chainExhausted = blocks.length >= MAX_BLOCKS || (tail && !tail.nextId)
  /**
   * Selama rantai pemulihan masih dibangun (`wantBlocks` belum tercapai),
   * chaining otomatis DIJEDA: kalau tidak, preload akan berlomba dengan
   * pembangunan rantai dan urutan blok bisa kacau — padahal urutan itulah yang
   * menentukan posisi piksel yang sedang dipulihkan.
   */
  const restoringChain = wantBlocks > 0 && blocks.length < wantBlocks
  const NEXT_CHAPTER_AT = 0.7 // muat chapter berikutnya saat 70% chapter terbaca

  // Progres baca SEBENARNYA (= posisi scroll), bukan posisi muat: chaining
  // sudah memuat chapter berikutnya lebih dulu, jadi progres harus mengikuti
  // chapter yang sedang dilihat pembaca. Dihitung dari DOM (midpoint setiap
  // gambar vs tengah viewport), di-throttle rAF agar halus.
  useEffect(() => {
    let raf = 0
    const compute = () => {
      raf = 0
      const root = flowRef.current
      if (!root) return
      const mid = window.scrollY + window.innerHeight * 0.5
      const imgs = Array.from(root.querySelectorAll<HTMLImageElement>('img[data-b]'))
      let bi = 0
      const counts = new Map<number, number>()
      for (const im of imgs) {
        const b = Number(im.dataset.b ?? '0')
        const r = im.getBoundingClientRect()
        if (r.top + window.scrollY + r.height / 2 < mid) {
          bi = b
          counts.set(b, (counts.get(b) ?? 0) + 1)
        } else break
      }
      setReadBlock(bi)
      setReadInBlock(Math.max(1, counts.get(bi) ?? 1))
    }
    const onScroll = () => {
      if (!raf) raf = requestAnimationFrame(compute)
    }
    window.addEventListener('scroll', onScroll, { passive: true })
    window.addEventListener('resize', onScroll)
    compute()
    return () => {
      window.removeEventListener('scroll', onScroll)
      window.removeEventListener('resize', onScroll)
      if (raf) cancelAnimationFrame(raf)
    }
  }, [blocks])

  const curBlock = blocks[readBlock] ?? blocks[0]
  const curLen = curBlock?.images.length ?? 0

  // Chapter yang SEDANG dibaca → tandai "sudah dibaca" (per akun).
  // Yang ditandai cuma blok yang jadi blok baca aktif — chapter berikutnya
  // yang sudah di-preload (chaining 80%) belum tentu dibaca user, jadi
  // jangan ditandai saat block masuk antrean.
  useEffect(() => {
    const b = blocks[readBlock]
    if (!b) return
    markChapterRead(b.titleKey, b.number)
  }, [blocks, readBlock])

  // Chaining dipicu PROGRES chapter (>=80%), tapi HANYA setelah semua gambar
  // chapter terakhir BERES — kalau komik belum ke-load semua, chapter
  // berikutnya tidak dinyalakan: pembaca tidak menemui lubang kosong.
  // Jaring pengaman: IntersectionObserver di dasar tetap memicu kalau gambar
  // gagal load (80% tak pernah tercapai).
  const loadNext = useCallback(() => {
    const nextId = lastBlock?.nextId
    if (!nextId || fetchedRef.current.has(nextId)) return
    fetchedRef.current.add(nextId)
    setLoadingNext(true)
    loadChapter(nextId)
      .then((d) => {
        setNextLoadFailed(false)
        pushBlock(toBlock(d))
      })
      .catch(() => {
        // gagal: kembalikan antrean supaya bisa retry
        fetchedRef.current.delete(nextId)
        setNextLoadFailed(true)
      })
      .finally(() => setLoadingNext(false))
  }, [lastBlock, pushBlock])

  useEffect(() => {
    if (chainExhausted) return
    if (restoringChain) return
    // hanya chapter TERAKHIR yang bisa memicu muat berikutnya
    if (readBlock !== blocks.length - 1) return
    if (curLen === 0) return
    // GERBANG: komik belum ke-load semua → jangan nyalakan chapter berikutnya
    if (!lastBlockSettled) return
    if (readInBlock / curLen >= NEXT_CHAPTER_AT) loadNext()
  }, [
    chainExhausted,
    restoringChain,
    readBlock,
    blocks.length,
    readInBlock,
    curLen,
    loadNext,
    lastBlockSettled,
  ])

  useEffect(() => {
    if (chainExhausted) return
    if (restoringChain) return
    // GERBANG juga di sini: jaring pengaman baru dipasang setelah chapter
    // terakhir selesai dimuat (termasuk gambar yang GAGAL — gagal ikut
    // dihitung "beres" via onSettled), jadi scroll cepat tak memicu preload
    // sebelum chapter terakhir penuh.
    if (!lastBlockSettled) return
    const el = bottomRef.current
    if (!el) return
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          io.disconnect()
          loadNext()
        }
      },
      { rootMargin: '800px 0px' },
    )
    io.observe(el)
    return () => io.disconnect()
  }, [chainExhausted, lastBlockSettled, loadNext])

  if (error) return <Empty title="Gagal memuat mode maraton" body={error} />
  if (blocks.length === 0) {
    return (
      <div className="flex min-h-dvh flex-col items-center justify-center gap-8 bg-night px-6">
        <div role="status" aria-live="polite" className="flex flex-col items-center gap-3">
          <span
            aria-hidden="true"
            className="size-6 animate-spin rounded-full border-2 border-white/20 border-t-brand-red motion-reduce:animate-none"
          />
          <p className="text-[14px] font-medium text-white/85">Menyiapkan maraton…</p>
          <div className="h-0.5 w-44 overflow-hidden rounded-full bg-white/15">
            <div className="h-full w-1/3 animate-[loadbar_1.2s_ease-in-out_infinite] rounded-full bg-brand-red" />
          </div>
        </div>
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

  return (
    <div className={`relative min-h-dvh ${settings.nightShift ? 'bg-night-dark' : 'bg-white'}`}>
      {/* Tap area baca — div (bukan button) supaya tidak jadi satu tombol
          raksasa di pohon aksesibilitas. Guard tap-vs-drag mencegah toggle
          saat jari hanya menggulir. Tap pada kontrol halaman (lingkaran
          "Muat ulang"/"Coba lagi") tidak boleh ikut men-toggle chrome. */}
      <div
        aria-hidden="true"
        data-testid="marathon-tap-layer"
        onPointerDown={(e) => {
          tapStart.current = { x: e.clientX, y: e.clientY, t: performance.now() }
        }}
        onPointerCancel={() => {
          tapStart.current = null
        }}
        onClick={(e) => {
          const start = tapStart.current
          tapStart.current = null
          if (start) {
            const moved = Math.hypot(e.clientX - start.x, e.clientY - start.y)
            if (moved > 12 || performance.now() - start.t > 900) return
          }
          if (tapHitsReaderControl(e.clientX, e.clientY)) return
          // Tap area baca hanya toggle chrome. Fullscreen HANYA lewat tombol.
          chrome.toggle()
        }}
        className="fixed inset-0 z-10 touch-manipulation"
      />

      <ReaderFullscreenButton
        active={fsActive}
        visible={chrome.visible}
        onToggle={() => {
          if (fsActive) {
            autoFS.reset()
            chrome.show()
          } else autoFS.requestEnter()
        }}
      />
      {/* Keluar dari mode maraton → balik ke reader biasa di chapter yang
          SEDANG dibaca (blok aktif, bukan blok pertama rantai). Posisi baca
          maraton ditulis ke progress reader supaya reader restore di tempat
          yang sama. Kiri-atas, berlawanan dengan tombol layar penuh. */}
      <ReaderMarathonToggle
        active={true}
        visible={chrome.visible}
        onToggle={() => {
          const target = curBlock ?? head
          if (target) {
            // tulis posisi maraton aktif → progress reader (biar reader restore
            // di tempat yang sama). offsetRatio dihitung dari DOM jadi restore
            // presisi, bukan ke atas halaman.
            let offsetRatio = 0
            let pageId = target.images[readInBlock - 1] ?? target.images[0]
            const root = flowRef.current
            if (root) {
              const imgs = Array.from(root.querySelectorAll<HTMLImageElement>('img[data-b]'))
              const pageIds: string[] = []
              const pageTops: number[] = []
              const pageHeights: number[] = []
              for (const im of imgs) {
                const bi = Number(im.dataset.b ?? '-1')
                const pi = Number(im.dataset.page ?? '-1')
                const url = blocks[bi]?.images[pi]
                if (!url || im.offsetHeight === 0) continue
                pageIds.push(imgUrl(url))
                pageTops.push(im.getBoundingClientRect().top + window.scrollY)
                pageHeights.push(im.offsetHeight)
              }
              const anchor = anchorFrom(
                target.chapterId,
                pageIds,
                window.scrollY,
                window.innerHeight,
                pageTops,
                pageHeights,
              )
              if (anchor) {
                offsetRatio = anchor.offsetRatio
                pageId = anchor.pageId
              }
            }
            if (pageId) {
              save({
                seriesId: target.seriesId ?? target.chapterId,
                seriesTitle: target.seriesTitle,
                chapterId: target.chapterId,
                chapterName: target.chapterName,
                page: Math.max(0, readInBlock - 1),
                progress: readInBlock / Math.max(1, target.images.length),
                pageId,
                offsetRatio,
                source: target.source ?? null,
                handle: target.handle || null,
              })
            }
          }
          navigate(readerHref(target?.chapterId ?? chapterId ?? ''))
        }}
      />

      <ReaderToolbar
        title="Mode Baca Marathon"
        subtitle={`${curBlock?.chapterName ?? ''} · ${readInBlock}/${curLen} halaman`}
        onBack={() => navigate(seriesHref(head?.seriesId) ?? '/')}
        onHome={() => navigate('/')}
        onShare={() => setToast('Bagikan: salin URL halaman ini')}
        onMore={() => setMenuOpen(true)}
        badge={curSource && curSource !== 'komiku' ? <SourceBadge source={curSource} /> : null}
        visible={chrome.visible}
      />

      <ReaderFooter
        nextName={tail?.nextName ?? null}
        nextHref={tail?.nextId ? marathonHref(tail.nextId) : null}
        prevName={head?.prevName ?? null}
        prevHref={head?.prevId ? marathonHref(head.prevId) : null}
        onPickChapter={() => setChapterPickerOpen(true)}
        visible={chrome.visible}
      />

      <ChapterPickerSheet
        open={chapterPickerOpen}
        onClose={() => setChapterPickerOpen(false)}
        chapterKey={head?.chapterId ?? null}
        currentKey={curBlock?.chapterId ?? null}
        legacySeriesId={typeof head?.seriesId === 'number' ? head.seriesId : null}
        seriesTitle={head?.seriesTitle ?? null}
        titleKey={head?.titleKey ?? null}
        mode="marathon"
      />

      {toast && (
        <p
          role="status"
          aria-live="polite"
          className="pointer-events-none fixed bottom-[calc(9.5rem+env(safe-area-inset-bottom))] left-1/2 z-40 -translate-x-1/2 rounded-full bg-black/85 px-4 py-2 text-[12px] font-medium text-white shadow-lg"
        >
          {toast}
        </p>
      )}

      {/* progres chapter berjalan — update per gambar, transisi halus */}
      <div
        className={`fixed inset-x-0 top-[calc(env(safe-area-inset-top)+3rem)] z-30 h-0.5 bg-black/20 transition-opacity duration-200 ${
          chrome.visible ? 'opacity-100' : 'pointer-events-none opacity-0'
        }`}
        aria-hidden={!chrome.visible}
      >
        <div
          className="h-full rounded-full bg-brand-red transition-[width] duration-200 ease-out"
          style={{ width: `${curLen ? Math.min((readInBlock / curLen) * 100, 100) : 0}%` }}
        />
      </div>

      {/* banner maraton inline — muncul di dalam alur baca, bukan di chrome.
          Teks 12px + warna reader-muted: kontras aman di tema terang & gelap.
          pt = tinggi toolbar + safe-area supaya tidak tertutup toolbar fixed.
          Chip "Maraton" di toolbar DIHAPUS: judul sudah menyebut mode ini, dan
          di 390 px chip itu memakan ~60 px lebar judul sampai terpotong. */}
      <div className="mx-auto max-w-3xl pl-4 pr-16 pt-[calc(env(safe-area-inset-top)+3.5rem)] lg:pr-4">
        <p
          className={`rounded-lg border border-brand-amber-dim/60 bg-brand-amber-dim/10 px-3 py-2 text-center text-[12px] font-medium leading-snug ${
            settings.nightShift ? 'text-reader-muted-night' : 'text-reader-muted'
          }`}
        >
          Chapter berikutnya terbuka otomatis.
        </p>
      </div>

      {/* Rantai halaman: semua chapter disambung jadi satu alur */}
      <div ref={flowRef} className="mx-auto flex max-w-3xl flex-col" style={filterStyle}>
        {blocks.map((b, bi) => {
          const start = blocks.slice(0, bi).reduce((n, x) => n + x.images.length, 0)
          return (
            <div key={b.chapterId}>
              {bi > 0 && (
                <p
                  className={`my-4 text-center text-[12px] font-medium ${
                    settings.nightShift ? 'text-reader-muted-night' : 'text-reader-muted'
                  }`}
                >
                  {b.chapterName}
                </p>
              )}
              {b.images.map((src, i) => (
                <ComicImage
                  key={`${b.chapterId}-${i}`}
                  src={src}
                  alt={`${b.chapterName} halaman ${i + 1}`}
                  blockIndex={bi}
                  // index halaman dalam blok → atribut `data-page`, dipakai
                  // pengukuran posisi baca (sama seperti Reader). Tanpa ini
                  // restore maraton tak bisa menemukan halamannya.
                  pageIndex={i}
                  // hanya halaman pertama blok PERTAMA yang langsung diminta;
                  // sisanya menunggu dekat layar (lihat ComicImage.mountAhead)
                  eager={bi === 0 && i === 0}
                  mountAhead={mountAhead}
                  onLoad={() =>
                    setTailIdx((n) => (start + i === n ? n + 1 : Math.max(n, start + i)))
                  }
                  // gerbang chaining: termuat ATAU gagal dua-duanya "beres"
                  onSettled={() => markSettled(start + i)}
                  className="manga-img w-full"
                />
              ))}
            </div>
          )
        })}

        {/* penanda bawah untuk IntersectionObserver chaining */}
        <div ref={bottomRef} className="h-36" />
      </div>

      {/**
       * Status + jalan keluar chaining DI LUAR kontainer ber-`filter`.
       *
       * Kontainer flow memakai `filter` (kecerahan/night shift) → itu membuat
       * stacking-context baru, sehingga apa pun di dalamnya berada DI BAWAH
       * overlay tap-tengah `fixed inset-0 z-10`. Link "Baca Chapter Berikutnya"
       * yang dulu dirender di dalam flow jadi tidak pernah bisa diklik — tap-nya
       * hanya men-toggle chrome. Dengan dipindah ke sini + `relative z-20`,
       * link benar-benar menerima klik.
       */}
      <div className="relative z-20 mx-auto max-w-3xl">
        {loadingNext && !nextLoadFailed && (
          <div
            role="status"
            aria-live="polite"
            className={`pointer-events-none mx-4 mb-24 flex items-center justify-center gap-2 text-[12px] font-medium ${
              settings.nightShift ? 'text-reader-muted-night' : 'text-reader-muted'
            }`}
          >
            <span
              aria-hidden="true"
              className="size-4 animate-spin rounded-full border-2 border-ink-600 border-t-brand-amber motion-reduce:animate-none"
            />
            Memuat chapter berikutnya…
          </div>
        )}
        {nextLoadFailed && tail?.nextId && (
          <div className="mx-4 mb-24">
            <Link
              to={marathonHref(tail.nextId)}
              replace
              className="flex min-h-11 items-center justify-center rounded-xl bg-brand-amber px-4 py-3 text-center text-[13px] font-bold text-white active:bg-brand-amber-soft focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-amber focus-visible:ring-offset-2"
            >
              Baca Chapter Berikutnya — {tail.nextName ?? 'chapter berikutnya'}
            </Link>
          </div>
        )}
        {chainExhausted && (
          <p
            className={`px-4 pb-28 text-center text-[12px] ${
              settings.nightShift ? 'text-reader-muted-night' : 'text-reader-muted'
            }`}
          >
            {blocks.length >= MAX_BLOCKS
              ? `Berhenti di ${MAX_BLOCKS} chapter — mulai maraton lagi dari sini.`
              : 'Semua chapter sudah terbaca.'}
          </p>
        )}
      </div>

      {/* Menu + preferensi reader (sama seperti reader biasa) */}
      <ReaderMenu
        open={menuOpen}
        settings={{ ...settings, marathon: true }}
        onClose={() => setMenuOpen(false)}
        onChange={(patch) => {
          // matikan marathon dari sini -> balik ke reader biasa chapter ini
          if (patch.marathon === false) {
            setMenuOpen(false)
            navigate(readerHref(head?.chapterId ?? chapterId ?? ''))
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
        onRestartMarathon={() => {
          // "Mulai dari awal": buang posisi sesi ini + seluruh sesi series ini,
          // lalu muat ulang rantai dari blok pertama (posisi tidak dipulihkan
          // karena kuncinya sudah tidak ada).
          setSheetOpen(false)
          marathon.clearSeries(handleOf(chapterId) ?? null)
          marathon.clear(chapterId)
          pendingRef.current = null
          setWantBlocks(0)
          setRestoreKey(null)
          window.scrollTo({ top: 0 })
          setBlocks([])
          setTailIdx(-1)
          setSettled(new Set())
          fetchedRef.current = new Set()
          const ctrl = new AbortController()
          loadChapter(chapterId, ctrl.signal)
            .then((d) => pushBlock(toBlock(d, params.handle)))
            .catch((e: Error) => e.name !== 'AbortError' && setError(e.message))
        }}
      />
    </div>
  )
}

function toBlock(d: ChapterResponse, handleFromRoute?: string): Block {
  return {
    chapterId: String(d.chapter.id),
    chapterName: d.chapter.name,
    seriesId: d.series?.id ?? null,
    seriesTitle: d.series?.title ?? null,
    source: d.source ?? d.series?.source ?? undefined,
    images: d.images ?? [],
    nextId: nextChapterId(d),
    nextName: d.chapter.next?.name ?? null,
    prevId: d.chapter.previous ? String(d.chapter.previous.id) : null,
    prevName: d.chapter.previous?.name ?? null,
    titleKey: d.title_key ?? null,
    number: chapterNumberOf(d.chapter),
    title: d.series?.title ?? d.chapter.name,
    coverUrl: d.series_cover ?? d.series?.cover ?? null,
    // server tidak selalu mengirim series_handle (verifikasi: null di respons
    // unified chapter) — pakai handle dari route (blok pertama) lebih dulu,
    // baru data. Tanpa ini recordRead tidak pernah jalan karena `== ''.
    handle: handleFromRoute ?? d.series_handle ?? d.chapter.handle ?? '',
  }
}


