import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { imgSrc, imgSrcSet, imgUrl, READER_SIZES } from '../imgUrl'
import { acquireImageSlot, recordImageSettle } from '../imgQueue'
import { aspectOf, rememberAspect } from '../pageMemory'

/**
 * Gambar dianggap "stuck" (dan layak tombol refresh manual) kalau byte sudah
 * mulai diminta (`started`) tapi belum settle setelah ini. Proses normal di
 * koneksi lambat bisa lebih lama — timer ini hanya menandai, tidak memblokir
 * apa pun; tombol refresh murni opsional.
 */
const STUCK_MS = 2000

/**
 * Ren der tombol "Coba lagi" melalui portal ke document.body dengan posisi
 * fixed mengikuti kotak placeholder gambar yang gagal. Ini MENGGAGALKAN
 * stacking-context yang dibuat `filter`/`transform` pada kontainer flow
 * reader — tanpa portal, z-index tombol hanya naik dalam konteks itu dan
 * tetap DI BAWAH overlay `ReaderFooter` (fixed z-30) / tap-tengah (z-10),
 * sehingga tombol tak bisa diklik saat memberinya di bawah footer. Dengan
 * portal, tombol ikut stacking-context akar dan z-40 > z-30.
 */
function FixedRetry({
  targetRef,
  onRetry,
}: {
  targetRef: React.RefObject<HTMLDivElement | null>
  onRetry: () => void
}) {
  const [rect, setRect] = useState<DOMRect | null>(null)

  useEffect(() => {
    const update = () => {
      const el = targetRef.current
      if (el) setRect(el.getBoundingClientRect())
    }
    update()
    window.addEventListener('scroll', update, { passive: true })
    window.addEventListener('resize', update)
    return () => {
      window.removeEventListener('scroll', update)
      window.removeEventListener('resize', update)
    }
  }, [targetRef])

  if (!rect) return null

  return (
    <div
      className="fixed left-0 top-0 z-40 flex flex-col items-center justify-center gap-2 px-4 py-10 text-center"
      style={{
        width: rect.width,
        height: rect.height,
        transform: `translate(${rect.left}px, ${rect.top}px)`,
      }}
    >
      <p className="text-[12px] text-ink-400">Halaman gagal dimuat.</p>
      <button
        type="button"
        onClick={onRetry}
        className="rounded-lg border border-brand-amber-dim bg-white/80 px-3 py-1.5 text-[12px] font-semibold text-brand-amber"
      >
        Coba lagi
      </button>
    </div>
  )
}



interface ComicImageProps {
  src: string
  alt: string
  /**
   * true = langsung minta gambar tanpa menunggu jarak scroll (halaman pertama).
   * Selain itu gambar BARU diminta ketika sudah dekat layar (`mountAhead`).
   */
  eager?: boolean
  /**
   * Jarak (px) di luar viewport untuk mulai memuat gambar ini. Ditentukan
   * pemanggil dari preferensi reader (hemat/seimbang/siapkan) + Save-Data.
   */
  mountAhead?: number
  /**
   * Rasio w/h cadangan sebelum rasio asli diketahui (kunjungan pertama).
   * 0,685 = halaman manga khas 900×1314. Dipakai untuk memesan tinggi kotak
   * supaya isi halaman tidak melompat.
   */
  fallbackRatio?: number
  /** `sizes` untuk srcset; default mengikuti lebar kontainer reader. */
  sizes?: string
  /** index chapter dalam rantai marathon — dipakai hitung progres baca. */
  blockIndex?: number
  /** index halaman dalam chapter — jadi atribut `data-page` untuk pengukuran posisi. */
  pageIndex?: number
  className?: string
  onLoad?: (el: HTMLImageElement) => void
  /**
   * Dipanggil sekali setiap kali gambar BERES diselesaikan — baik termuat
   * (ok=true) maupun gagal (ok=false, chip "Coba lagi" muncul). Beda dari
   * `onLoad` yang hanya menang sisi sukses: pemanggil yang perlu tahu
   * "halaman ini sudah ambil bagian" (mis. gerbang chaining marathon) memakai
   * ini supaya satu gambar rusak tidak menahan rantai selamanya.
   */
  onSettled?: (ok: boolean) => void
}

/**
 * Satu halaman manga.
 *
 * TIGA hal yang menentukan "user tidak sadar sedang membaca di koneksi jelek":
 *
 * 1. GAMBAR HANYA DIMINTA SAAT DEKAT LAYAR (IntersectionObserver + rootMargin
 *    `mountAhead`), bukan `loading="lazy"` bawaan. Lazy bawaan Chrome memakai
 *    margin besar (≈1250 px, dan membesar di koneksi lambat), sehingga satu
 *    kunjungan reader langsung meminta 9 gambar / 1,7 MB — halaman yang sedang
 *    dilihat pun ikut antre. Terukur di 400 kbps: halaman 1 tampil 53 detik
 *    dengan lazy bawaan vs 12 detik kalau hanya dia yang diminta.
 *
 *    Dekat layar belum cukup: beberapa halaman bisa "dekat" bersamaan. Karena
 *    itu pemasangan `src` lewat `imgQueue` — halaman pertama langsung jalan,
 *    sisanya menunggu sampai halaman pertama selesai.
 *
 * 2. BYTE DIPOTONG lewat proxy `/img` + `srcset` 480/640/900 (WebP lossy):
 *    −74% / −59% / −14% per halaman. Browser memilih lebar sendiri dari
 *    `sizes`, jadi HP 1x tidak pernah mengunduh 900 px penuh.
 *
 * 3. TINGGI KOTAK DIPESAN sebelum gambar decode (`width`/`height` dari rasio),
 *    termasuk saat rasio asli belum diketahui (kunjungan pertama) → tidak ada
 *    lompatan saat gambar di atas menyusul, posisi baca tidak bergeser.
 *
 * Skeleton tetap `bg-ink-800` + fade-in 200 ms: kotak kosong harus terbaca
 * "sedang memuat", bukan "gagal".
 */
export default function ComicImage({
  src,
  alt,
  eager,
  mountAhead = 1200,
  fallbackRatio = 0.685,
  sizes = READER_SIZES,
  blockIndex,
  pageIndex,
  className,
  onLoad,
  onSettled,
}: ComicImageProps) {
  // `url` = IDENTITAS halaman (URL CDN asli) — dipakai pageMemory/anchor.
  const url = imgUrl(src)
  const [failed, setFailed] = useState(false)
  const [shown, setShown] = useState(false)
  const [attempt, setAttempt] = useState(0)
  // `stuck` = gambar belum settle dalam `STUCK_MS` sejak byte mulai diminta,
  // padahal bukan gagal. Memunculkan tombol refresh manual per-halaman.
  const [stuck, setStuck] = useState(false)
  // `buster` = penanda unik untuk refresh manual; dilekatkan ke src/srcset
  // supaya browser tidak melayani cache rusak (URL berubah).
  const [buster, setBuster] = useState(0)
  // `mounted` = boleh minta byte sekarang. false = skeleton (0 byte).
  const [mounted, setMounted] = useState(!!eager)
  // `started` = slot antrean sudah didapat → `src` dipasang. Beda dari
  // `mounted` (dekat layar): dekat ≠ boleh langsung minta byte.
  const [started, setStarted] = useState(false)
  const releaseRef = useRef<(() => void) | null>(null)
  const startedAtRef = useRef(0)
  const [measured, setMeasured] = useState<{ url: string; ratio: number } | null>(null)
  const ref = useRef<HTMLImageElement | null>(null)
  const slotRef = useRef<HTMLDivElement | null>(null)
  // onLoad terbaru tanpa memicu efek ulang tiap render induk
  const onLoadRef = useRef(onLoad)
  onLoadRef.current = onLoad
  const settledRef = useRef(onSettled)
  settledRef.current = onSettled

  // rasio w/h: hasil decode terbaru → memori kunjungan lalu → cadangan.
  const ratio =
    (measured?.url === url ? measured.ratio : null) ?? aspectOf(url) ?? fallbackRatio
  const srcSet = imgSrcSet(src, undefined, buster || undefined)

  // chapter berganti → reset state gambar
  useEffect(() => {
    setFailed(false)
    setShown(false)
    setStuck(false)
    setBuster(0)
    setMounted(!!eager)
    setStarted(false)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url])

  // --- kapan boleh mulai meminta byte? -----------------------------------
  // Eager: langsung. Selain itu: begitu masuk jendela `mountAhead` px.
  // Tanpa IntersectionObserver (browser tua) → langsung, jangan sampai kosong.
  useEffect(() => {
    if (mounted) return
    if (typeof IntersectionObserver === 'undefined') {
      setMounted(true)
      return
    }
    const el = ref.current
    if (!el) return
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setMounted(true)
          io.disconnect()
        }
      },
      { rootMargin: `${mountAhead}px 0px` },
    )
    io.observe(el)
    return () => io.disconnect()
  }, [mounted, mountAhead, attempt])

  // --- timer "stuck": byte sudah diminta tapi belum settle → refresh manual --
  // Hanya menandai; tidak memblokir apa pun. Setiap kali `attempt` naik
  // (bukan cuma retry error) timer restart, jadi refresh manual memberi
  // jendela penuh lagi.
  useEffect(() => {
    if (!started || shown || failed) {
      setStuck(false)
      return
    }
    const t = setTimeout(() => setStuck(true), STUCK_MS)
    return () => clearTimeout(t)
  }, [started, shown, failed, attempt])

  // --- antrean byte: dekat layar ≠ boleh langsung minta -------------------
  // Halaman pertama (eager) langsung dapat slot; sisanya mengantre sampai
  // halaman yang sedang dibaca selesai. Lihat `imgQueue.ts` untuk angkanya.
  useEffect(() => {
    if (!mounted) return
    const release = acquireImageSlot(eager ? 0 : 1, () => {
      startedAtRef.current = performance.now()
      setStarted(true)
    })
    releaseRef.current = release
    return () => {
      releaseRef.current = null
      release()
    }
    // `started` sengaja BUKAN dependensi: kalau ikut, cleanup-nya akan
    // melepas slot tepat setelah slot itu diberikan.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mounted, eager, attempt])

  /** Selesai (sukses ATAU gagal) → lepas slot, halaman berikutnya jalan. */
  function settle() {
    if (startedAtRef.current) {
      recordImageSettle(performance.now() - startedAtRef.current)
      startedAtRef.current = 0
    }
    releaseRef.current?.()
  }

  // Gambar bisa selesai SEBELUM React memasang onLoad (cache SW / HTTP cache
  // → elemen langsung `complete`). Tanpa cek ini, gambar tak pernah muncul dan
  // gerbang chaining marathon tak pernah terbuka.
  useEffect(() => {
    if (failed || !started) return
    const el = ref.current
    if (el && el.complete && el.naturalWidth > 0) {
      rememberAspect(url, el.naturalWidth, el.naturalHeight)
      setMeasured({ url, ratio: el.naturalWidth / el.naturalHeight })
      setShown(true)
      onLoadRef.current?.(el)
      settledRef.current?.(true)
      settle()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url, attempt, failed, started])

  if (failed) {
    return (
      <div ref={slotRef} className="relative" style={ratio ? { aspectRatio: String(ratio) } : undefined}>
        {createPortal(
          <FixedRetry
            targetRef={slotRef}
            onRetry={() => {
              setFailed(false)
              setAttempt((a) => a + 1)
            }}
          />,
          document.body,
        )}
      </div>
    )
  }

  return (
    <div className="relative">
      {stuck && (
        <button
          type="button"
          aria-label="Muatin ulang halaman ini"
          title="Muatin ulang halaman ini"
          onClick={() => {
            setStuck(false)
            setBuster(Date.now())
            setAttempt((a) => a + 1)
          }}
          className="absolute right-3 top-14 z-40 flex h-11 w-11 items-center justify-center rounded-full border border-ink-300 bg-ink-900/80 text-ink-200 shadow-lg transition hover:bg-ink-900 hover:text-ink-100 focus:outline-none focus:ring-2 focus:ring-brand-amber"
        >
          <svg
            width="22"
            height="22"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <path d="M21 12a9 9 0 1 1-2.64-6.36" />
            <polyline points="21 3 21 9 15 9" />
          </svg>
        </button>
      )}
      <img
      key={attempt}
      ref={ref}
      // Tanpa `started`: TIDAK ada src sama sekali = 0 byte terunduh.
      src={started ? imgSrc(src, 640, buster || undefined) : undefined}
      srcSet={started ? srcSet : undefined}
      sizes={started && srcSet ? sizes : undefined}
      alt={alt}
      // width/height = petunjuk rasio untuk layout pre-decode; setelah gambar
      // termuat, rasio intrinsik asli yang berlaku (height: auto)
      width={1000}
      height={Math.round(1000 / ratio)}
      loading={eager ? 'eager' : 'lazy'}
      // LCP: halaman pertama diminta prioritas tinggi. Gambar lanjutan
      // sengaja `low` — mereka boleh menunggu, yang penting halaman yang
      // sedang dibaca tidak kalah rebutan.
      fetchPriority={eager ? 'high' : 'low'}
      decoding="async"
      data-b={blockIndex}
      data-page={pageIndex}
      data-mounted={started ? '1' : '0'}
      onLoad={(e) => {
        const el = e.currentTarget
        if (el.naturalWidth > 0 && el.naturalHeight > 0) {
          rememberAspect(url, el.naturalWidth, el.naturalHeight)
          setMeasured({ url, ratio: el.naturalWidth / el.naturalHeight })
        }
        setShown(true)
        onLoad?.(el)
        settledRef.current?.(true)
        settle()
      }}
      onError={() => {
        setStuck(false)
        setFailed(true)
        settledRef.current?.(false)
        settle()
      }}
      // Latar kotak gambar SENGAJA non-putih: token ink-* di tema terang ini
      // bernilai putih/nyaris putih (ink-900 = #ffffff), jadi selagi gambar
      // belum decode kotaknya "bolong" tak terlihat — identik dengan strip
      // putih milik halaman sumber. ink-800 = abu terang -> kotak kosong jelas
      // terbaca sebagai "sedang memuat", bukan gagal load.
      className={`select-none bg-ink-800 transition-opacity duration-200 ${
        shown ? 'opacity-100' : 'opacity-0'
      } ${className ?? ''}`}
      draggable={false}
    />
    </div>
  )
}
