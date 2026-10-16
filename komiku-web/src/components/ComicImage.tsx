import { useEffect, useRef, useState } from 'react'
import { imgUrl } from '../imgUrl'
import { aspectOf, rememberAspect } from '../pageMemory'

interface ComicImageProps {
  src: string
  alt: string
  /** true untuk gambar di atas layar (langsung eager), sisanya lazy. */
  eager?: boolean
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
 * Satu halaman manga:
 * - src di-hotlink LANGSUNG ke CDN (Q21) — imgUrl() mengembalikan URL apa
 *   adanya, tanpa proxy `/img`. Respons lintas-origin (opaque), jadi gambar
 *   TIDAK di-cache service worker; cache offline in-app dibuang (Q11).
 * - skeleton saat memuat, chip "Coba lagi" kalau gagal (jaringan jelek),
 *   tanpa harus reload seluruh chapter.
 * - ANTI LAYOUT-SHIFT: rasio aspek asli (dari kunjungan sebelumnya) dipasang
 *   sebagai width/height eksplisit, jadi browser memesan tinggi halaman
 *   SEBELUM gambar selesai decode — posisi baca yang dipulihkan tidak
 *   bergeser saat gambar di atasnya menyusul muat.
 */
export default function ComicImage({
  src,
  alt,
  eager,
  blockIndex,
  pageIndex,
  className,
  onLoad,
  onSettled,
}: ComicImageProps) {
  const url = imgUrl(src)
  const [failed, setFailed] = useState(false)
  const [shown, setShown] = useState(false)
  const [attempt, setAttempt] = useState(0)
  const [measured, setMeasured] = useState<{ url: string; ratio: number } | null>(null)
  const ref = useRef<HTMLImageElement | null>(null)
  // onLoad terbaru tanpa memicu efek ulang tiap render induk
  const onLoadRef = useRef(onLoad)
  onLoadRef.current = onLoad
  const settledRef = useRef(onSettled)
  settledRef.current = onSettled

  // rasio w/h: dari memori (kunjungan sebelumnya) atau hasil decode gambar ini.
  const ratio = (measured?.url === url ? measured.ratio : null) ?? aspectOf(url)

  // chapter berganti → reset state gambar
  useEffect(() => {
    setFailed(false)
    setShown(false)
  }, [url])

  // SW cache-first bisa selesaikan muat SEBELUM React memasang onLoad
  // (gambar langsung `complete`) → gambar tak pernah terlihat. Cek sekali
  // setelah mount: kalau sudah lengkap, perlakukan sebagai onLoad.
  // settledRef juga dipanggil: tanpa ini indeks gambar tak pernah ditandai
  // "beres" dan gerbang chaining marathon tak pernah terbuka.
  useEffect(() => {
    if (failed) return
    const el = ref.current
    if (el && el.complete && el.naturalWidth > 0) {
      rememberAspect(url, el.naturalWidth, el.naturalHeight)
      setMeasured({ url, ratio: el.naturalWidth / el.naturalHeight })
      setShown(true)
      onLoadRef.current?.(el)
      settledRef.current?.(true)
    }
  }, [url, attempt, failed])

  if (failed) {
    return (
      <div
        // tinggi tetap dipertahankan walau gambar gagal, supaya halaman di
        // bawahnya tidak "melompat" naik dan posisi baca tetap valid
        className="flex flex-col items-center justify-center gap-2 px-4 py-10"
        style={ratio ? { aspectRatio: String(ratio) } : undefined}
      >
        <p className="text-[12px] text-ink-400">Halaman gagal dimuat.</p>
        <button
          onClick={() => {
            setFailed(false)
            setAttempt((a) => a + 1)
          }}
          className="rounded-lg border border-brand-amber-dim px-3 py-1.5 text-[12px] font-semibold text-brand-amber"
        >
          Coba lagi
        </button>
      </div>
    )
  }

  return (
    <img
      key={attempt}
      ref={ref}
      src={url}
      alt={alt}
      // width/height = petunjuk rasio untuk layout pre-decode; setelah gambar
      // termuat, rasio intrinsik asli yang berlaku (height: auto)
      width={ratio ? 1000 : undefined}
      height={ratio ? Math.round(1000 / ratio) : undefined}
      loading={eager ? 'eager' : 'lazy'}
      // LCP: halaman pertama (eager) diminta dengan prioritas jaringan tinggi
      // supaya tidak kalah dari aset lain di antrean awal. Sisanya dibiarkan
      // default (browser tetap menurunkan prioritas gambar lazy di luar layar).
      fetchPriority={eager ? 'high' : undefined}
      decoding="async"
      data-b={blockIndex}
      data-page={pageIndex}
      onLoad={(e) => {
        const el = e.currentTarget
        if (el.naturalWidth > 0 && el.naturalHeight > 0) {
          rememberAspect(url, el.naturalWidth, el.naturalHeight)
          setMeasured({ url, ratio: el.naturalWidth / el.naturalHeight })
        }
        setShown(true)
        onLoad?.(el)
        settledRef.current?.(true)
      }}
      onError={() => {
        setFailed(true)
        settledRef.current?.(false)
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
  )
}
