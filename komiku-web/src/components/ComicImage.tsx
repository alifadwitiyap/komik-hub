import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { imgDirect, imgUrl, READER_SIZES } from '../imgUrl'
import { acquireImageSlot, recordImageSettle } from '../imgQueue'
import { aspectOf, rememberAspect } from '../pageMemory'

/**
 * Gambar dianggap "stuck" (dan layak tombol refresh manual) kalau byte sudah
 * mulai diminta (`started`) tapi belum settle setelah ini. Proses normal di
 * koneksi lambat bisa lebih lama — timer ini hanya menandai, tidak memblokir
 * apa pun; tombol refresh murni opsional.
 */
const STUCK_MS = 20000

/**
 * Lapisan kontrol halaman DI ATAS overlay tap-tengah reader.
 *
 * Kontrol reader (tombol "Coba lagi", tombol muat ulang melingkar) HARUS
 * dirender lewat portal ke document.body dengan posisi fixed mengikuti kotak
 * halaman. Alasannya stacking-context: kontainer flow reader selalu punya
 * `filter` (kecerahan/perisai malam, lihat useReaderSettings.filterStyle),
 * dan `filter` membentuk stacking-context baru. z-index apa pun di dalamnya
 * (termasuk z-40) tetap DI BAWAH overlay tap-tengah `fixed inset-0 z-10` milik
 * Reader — akibatnya klik pada tombol melingkar jatuh ke overlay dan malah
 * memicu fullscreen (laporan user). Dengan portal, kontrol ikut stacking
 * context akar: z-40 > z-10, jadi kliknya benar-benar mengenai tombol.
 *
 * `pointer-events-none` di lapisan + `pointer-events-auto` di tombol: area
 * halaman selain tombol tetap bisa men-toggle chrome seperti biasa.
 */
/**
 * Cadangan tinggi area chrome reader kalau elemennya belum ada di DOM:
 * toolbar atas ±48px dan footer bawah ±108px.
 */
const CHROME_TOP_PX = 56
const CHROME_BOTTOM_PX = 120

function PageControlLayer({
  targetRef,
  minVisible = 120,
  className,
  children,
}: {
  targetRef: React.RefObject<HTMLDivElement | null>
  /** tinggi area halaman yang harus terlihat agar kontrol ditampilkan */
  minVisible?: number
  className?: string
  children: React.ReactNode
}) {
  // Kotak halaman DIPOTONG ke area baca (viewport minus chrome): kontrol harus
  // selalu berada di bagian halaman yang benar-benar terlihat. Kalau memakai
  // tinggi halaman penuh, tombol di tengah halaman panjang bisa berada di luar
  // layar (tak bisa dipencet) — atau tampak "melayang" di halaman lain.
  const [rect, setRect] = useState<{
    left: number
    top: number
    width: number
    height: number
  } | null>(null)

  useEffect(() => {
    const update = () => {
      const el = targetRef.current
      if (!el) {
        setRect(null)
        return
      }
      // tinggi chrome dibaca dari DOM supaya safe-area iPhone ikut terhitung
      const toolbar = document.querySelector<HTMLElement>('[data-reader-chrome="toolbar"]')
      const footer = document.querySelector<HTMLElement>('[data-reader-chrome="footer"]')
      const topInset = toolbar?.offsetHeight ?? CHROME_TOP_PX
      const bottomInset = footer?.offsetHeight ?? CHROME_BOTTOM_PX

      const r = el.getBoundingClientRect()
      const left = Math.max(r.left, 0)
      const top = Math.max(r.top, topInset)
      const right = Math.min(r.right, window.innerWidth)
      const bottom = Math.min(r.bottom, window.innerHeight - bottomInset)
      if (right <= left || bottom - top < minVisible) {
        setRect(null) // halaman (hampir) di luar area baca → jangan tampilkan
        return
      }
      setRect({ left, top, width: right - left, height: bottom - top })
    }
    update()
    window.addEventListener('scroll', update, { passive: true })
    window.addEventListener('resize', update)
    return () => {
      window.removeEventListener('scroll', update)
      window.removeEventListener('resize', update)
    }
  }, [targetRef, minVisible])

  if (!rect) return null

  return (
    <div
      className={`pointer-events-none fixed z-40 flex items-center justify-center ${className ?? ''}`}
      style={{
        left: rect.left,
        top: rect.top,
        width: rect.width,
        height: rect.height,
      }}
    >
      {children}
    </div>
  )
}

function FixedRetry({
  targetRef,
  onRetry,
}: {
  targetRef: React.RefObject<HTMLDivElement | null>
  onRetry: () => void
}) {
  return (
    <PageControlLayer
      targetRef={targetRef}
      minVisible={190}
      className="flex-col gap-3 px-4 text-center"
    >
      <p
        role="status"
        className="rounded-lg bg-black/70 px-3 py-1.5 text-[13px] font-medium text-white"
      >
        Halaman gagal dimuat.
      </p>
      <button
        type="button"
        data-reader-control="page-retry"
        onClick={onRetry}
        className="pointer-events-auto inline-flex min-h-11 items-center justify-center rounded-xl border border-brand-amber-dim bg-white/90 px-4 text-[13px] font-bold text-brand-amber shadow-md transition-colors active:bg-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-amber"
      >
        Coba lagi
      </button>
    </PageControlLayer>
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
  // Reader ambil gambar LANGSUNG dari CDN: server tidak decode/encode, jadi
  // RAM & CPU VPS tidak dipakai untuk menampilkan halaman. Tradeoff yang
  // dipilih: kuota data user ~3-4x lebih besar. Unduh-offline tetap via proxy
  // (`imgSrc` di chapterOffline.ts) karena byte-nya harus same-origin.
  const srcSet = undefined
  // LQIP: thumbnail kecil tetap dari CDN apa adanya — tidak ada proxy, jadi
  // placeholder = URL asli (browser yang menskalakan). Server nol biaya.
  const lqip = ''

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
    // Holder SENGAJA transparan (bukan bg-ink-800). Latar abu-abu membuat
    // setiap halaman yang belum decode tampil sebagai pita/persegi abu di
    // antara halaman putih — persis "garis-garis" yang dikeluhkan user.
    // Kotak tetap memesan tinggi lewat atribut width/height <img>, jadi tidak
    // ada layout shift; isyarat "sedang memuat" datang dari LQIP blur.
    <div ref={slotRef} className="relative">
      {/** LQIP: thumbnail blur sebagai placeholder selama gambar penuh belum `shown`.
          Crossfade halus via opacity; tidak menangkap pointer. */}
      {started && lqip && (
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 bg-cover bg-center blur-md transition-opacity duration-200"
          style={{ backgroundImage: `url(${lqip})`, opacity: shown ? 0 : 1 }}
        />
      )}
      {/**
       * Tombol "muat ulang" melingkar — sengaja LEWAT PORTAL (bukan absolute
       * di dalam halaman) supaya tidak tertimpa overlay tap-tengah reader.
       * Lihat PageControlLayer di atas. Tombol ini HANYA me-refresh gambar;
       * tidak pernah menyentuh fullscreen.
       */}
      {stuck &&
        createPortal(
          <PageControlLayer targetRef={slotRef}>
            <button
              type="button"
              data-reader-control="page-reload"
              aria-label="Muat ulang halaman ini"
              title="Muat ulang halaman ini"
              onClick={() => {
                setStuck(false)
                setBuster(Date.now())
                setAttempt((a) => a + 1)
              }}
              className="pointer-events-auto flex size-20 touch-manipulation flex-col items-center justify-center gap-0.5 rounded-full border border-white/30 bg-black/70 text-white shadow-xl backdrop-blur-sm transition-colors active:bg-black/85 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/80"
            >
              <svg
                width="28"
                height="28"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.2"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <path d="M21 12a9 9 0 1 1-2.64-6.36" />
                <polyline points="21 3 21 9 15 9" />
              </svg>
              <span className="text-[11px] font-semibold leading-none">Muat ulang</span>
            </button>
          </PageControlLayer>,
          document.body,
        )}
      <img
      key={attempt}
      ref={ref}
      // Tanpa `started`: TIDAK ada src sama sekali = 0 byte terunduh.
      src={started ? imgDirect(src, buster || undefined) : undefined}
      srcSet={started ? srcSet : undefined}
      sizes={started && srcSet ? sizes : undefined}
      alt={alt}
      // width/height = petunjuk rasio untuk layout pre-decode; setelah gambar
      // termuat, rasio intrinsik asli yang berlaku (height: auto)
      width={1000}
      height={Math.round(1000 / ratio)}
      loading={started ? 'eager' : 'lazy'}
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
      // Tanpa latar: selama gambar belum decode, yang terlihat adalah
      // permukaan baca (putih / #131313 saat night shift) — bukan pita abu.
      className={`select-none transition-opacity duration-200 ${
        shown ? 'opacity-100' : 'opacity-0'
      } ${className ?? ''}`}
      draggable={false}
    />
    </div>
  )
}
