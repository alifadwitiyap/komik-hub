import { useCallback, useEffect, useRef, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import ChapterPickerSheet from '../components/ChapterPickerSheet'
import ComicImage from '../components/ComicImage'
import ReaderFooter from '../components/ReaderFooter'
import ReaderMenu from '../components/ReaderMenu'
import ReaderSettingsSheet from '../components/ReaderSettingsSheet'
import ReaderToolbar from '../components/ReaderToolbar'
import SourceBadge from '../components/SourceBadge'
import { useReaderSettings } from '../hooks/useReaderSettings'
import { useChromeOnScroll } from '../hooks/useChromeOnScroll'
import type { ChapterResponse } from '../types'
import { Empty } from '../App'
import { useProgress } from '../hooks/useProgress'
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
  // maraton selalu mulai dari puncak channel → tak ada restore posisi,
  // jadi chrome cukup mengikuti arah scroll langsung
  const chrome = useChromeOnScroll()
  const [menuOpen, setMenuOpen] = useState(false)
  const [sheetOpen, setSheetOpen] = useState(false)
  const [chapterPickerOpen, setChapterPickerOpen] = useState(false)
  const [toast, setToast] = useState<string | null>(null)
  const [nextLoadFailed, setNextLoadFailed] = useState(false)
  const bottomRef = useRef<HTMLDivElement | null>(null)
  /** chapterId yang sudah/sedang di-fetch — cegah fetch ganda & loop abort */
  const fetchedRef = useRef<Set<string>>(new Set())
  const { save } = useProgress()
  const navigate = useNavigate()
  const { settings, onChange, onReset, filterStyle } = useReaderSettings()

  // sumber dari blok yang sedang dibaca (hanya unified) — dipakai badge toolbar
  const [readBlock, setReadBlock] = useState(0)
  const [readInBlock, setReadInBlock] = useState(1)
  const curSource = blocks[readBlock]?.source ?? null

  const pushBlock = useCallback((b: Block) => {
    setBlocks((prev) => (prev.some((x) => x.chapterId === b.chapterId) ? prev : [...prev, b]))
  }, [])

  // chapter pertama
  useEffect(() => {
    if (!chapterId) return
    setBlocks([])
    setTailIdx(-1)
    setError(null)
    setNextLoadFailed(false)
    // indeks gambar global kembali dari 0 → penanda settled harus dikosongkan
    setSettled(new Set())
    // channel baru: chrome tampil lagi (jangan warisi keadaan tersembunyi)
    chrome.show()
    const ctrl = new AbortController()
    loadChapter(chapterId, ctrl.signal)
      .then((d) => pushBlock(toBlock(d)))
      .catch((e: Error) => e.name !== 'AbortError' && setError(e.message))
    return () => ctrl.abort()
  }, [chapterId, pushBlock])

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
    save({
      seriesId: owner.seriesId ?? owner.chapterId,
      seriesTitle: owner.seriesTitle,
      chapterId: owner.chapterId,
      chapterName: owner.chapterName,
      page: local,
      progress: (tailIdx + 1) / Math.max(1, totalPages),
    })
  }, [tailIdx, blocks, totalPages, save])

  // maraton = chaining selalu aktif (tanpa hambatan).
  const chainExhausted = blocks.length >= MAX_BLOCKS || (tail && !tail.nextId)
  const NEXT_CHAPTER_AT = 0.8 // muat chapter berikutnya saat 80% chapter terbaca

  // Progres baca SEBENARNYA (= posisi scroll), bukan posisi muat: chaining
  // sudah memuat chapter berikutnya lebih dulu, jadi progres harus mengikuti
  // chapter yang sedang dilihat pembaca. Dihitung dari DOM (midpoint setiap
  // gambar vs tengah viewport), di-throttle rAF agar halus.
  const flowRef = useRef<HTMLDivElement | null>(null)

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
  }, [lastBlock, pushBlock])

  useEffect(() => {
    if (chainExhausted) return
    // hanya chapter TERAKHIR yang bisa memicu muat berikutnya
    if (readBlock !== blocks.length - 1) return
    if (curLen === 0) return
    // GERBANG: komik belum ke-load semua → jangan nyalakan chapter berikutnya
    if (!lastBlockSettled) return
    if (readInBlock / curLen >= NEXT_CHAPTER_AT) loadNext()
  }, [
    chainExhausted,
    readBlock,
    blocks.length,
    readInBlock,
    curLen,
    loadNext,
    lastBlockSettled,
  ])

  useEffect(() => {
    if (chainExhausted) return
    //GERBANG juga di sini: jaring pengaman baru dipasang setelah chapter
    // terakhir selesai dimuat, jadi scroll cepat tak lagi memicu preload.
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
      <div className="grid min-h-screen place-items-center bg-night">
        <div className="flex flex-col items-center gap-3">
          <span className="size-6 animate-spin rounded-full border-2 border-white/20 border-t-brand-red" />
          <p className="text-[14px] text-white/80">Menyiapkan maraton…</p>
          <div className="h-0.5 w-44 overflow-hidden rounded-full bg-white/15">
            <div className="h-full w-1/3 animate-[loadbar_1.2s_ease-in-out_infinite] rounded-full bg-brand-red" />
          </div>
        </div>
        <style>{`@keyframes loadbar{0%{transform:translateX(-100%)}100%{transform:translateX(320%)}}`}</style>
      </div>
    )
  }

  return (
    <div className={`relative min-h-screen ${settings.nightShift ? 'bg-night-dark' : 'bg-white'}`}>
      <button
        aria-label={chrome.visible ? 'Sembunyikan kontrol' : 'Tampilkan kontrol'}
        onClick={chrome.toggle}
        className="fixed inset-0 z-10"
      />

      <ReaderToolbar
        title="Mode Baca Marathon"
        subtitle={`${curBlock?.chapterName ?? ''} · ${readInBlock}/${curLen} halaman`}
        onBack={() => navigate(seriesHref(head?.seriesId) ?? '/')}
        onShare={() => setToast('Bagikan: salin URL halaman ini')}
        onMore={() => setMenuOpen(true)}
        chip="Maraton"
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
        <p className="fixed bottom-28 left-1/2 z-40 -translate-x-1/2 rounded-full bg-black/80 px-4 py-2 text-[12px] text-white">
          {toast}
        </p>
      )}

      {/* progres chapter berjalan — update per gambar, transisi halus */}
      <div
        className={`fixed inset-x-0 top-12 z-30 h-0.5 bg-black/20 transition-opacity duration-200 ${
          chrome.visible ? 'opacity-100' : 'pointer-events-none opacity-0'
        }`}
        aria-hidden={!chrome.visible}
      >
        <div
          className="h-full rounded-full bg-brand-red transition-[width] duration-200 ease-out"
          style={{ width: `${curLen ? Math.min((readInBlock / curLen) * 100, 100) : 0}%` }}
        />
      </div>

      {/* banner maraton inline — muncul di dalam alur baca, bukan di chrome */}
      <div className="mx-auto max-w-3xl px-4 pt-3">
        <p className="rounded-lg border border-brand-amber-dim/60 bg-brand-amber-dim/10 px-3 py-2 text-center text-[11px] font-medium text-brand-amber">
          Maraton · Mode Baca Marathon — chapter berikutnya otomatis terbuka tanpa hambatan
        </p>
      </div>

      {/* Rantai halaman: semua chapter disambung jadi satu alur */}
      <div ref={flowRef} className="mx-auto flex max-w-3xl flex-col" style={filterStyle}>
        {blocks.map((b, bi) => {
          const start = blocks.slice(0, bi).reduce((n, x) => n + x.images.length, 0)
          return (
            <div key={b.chapterId}>
              {bi > 0 && (
                <p className="my-4 text-center text-[11px] font-medium text-ink-500">
                  {b.chapterName}
                </p>
              )}
              {b.images.map((src, i) => (
                <ComicImage
                  key={`${b.chapterId}-${i}`}
                  src={src}
                  alt={`${b.chapterName} halaman ${i + 1}`}
                  blockIndex={bi}
                  eager={bi === 0 && i < 2}
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

        {/* penanda bawah + muat manual kalau auto-advance gagal */}
        <div ref={bottomRef} className="h-32" />
        {nextLoadFailed && tail?.nextId && (
          <div className="mx-4 mb-24">
            <Link
              to={marathonHref(tail.nextId)}
              replace
              className="block rounded-xl bg-brand-amber py-3 text-center text-[13px] font-bold text-ink-950"
            >
              Baca Chapter Berikutnya — {tail.nextName ?? 'chapter berikutnya'}
            </Link>
          </div>
        )}
        {chainExhausted && (
          <p className="px-4 pb-28 text-center text-[12px] text-ink-500">
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
      />
    </div>
  )
}

function toBlock(d: ChapterResponse): Block {
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
  }
}


