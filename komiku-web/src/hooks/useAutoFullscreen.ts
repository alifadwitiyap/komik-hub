/**
 * useAutoFullscreen — masuk layar penuh lewat pola 2 lapis:
 *
 * 1. DETEKSI INTENT (scroll): flick scroll-turun cepat menyalakan flag
 *    `pending` (niat), dengan masa berlaku `PENDING_TTL_MS`. Ini TIDAK
 *    langsung memanggil requestFullscreen.
 * 2. EKSEKUSI (ges : asli): `requestEnter()` dipanggil sinkron DI DALAM
 *    event tap/klik (pointerup/click/keydown). Karena itu terjadi dalam
 *    transient activation, browser pasti menerima permintaan — tidak lagi
 *    "kadang masuk kadang engga".
 *
 * Keluar: Esc (native fullscreenchange), scroll naik, atau tap tengah
 * (via `reset()`). Fallback ke "immersive" (sembunyikan chrome) saat
 * Fullscreen API tidak tersedia / ditolak (mis. iOS Safari).
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import {
  detectFlick,
  pruneFlickSamples,
  EXIT_SCROLL_THRESHOLD_PX,
  PENDING_TTL_MS,
} from './autoFullscreenLogic'
import { FS_TOGGLE_ATTR, isInteractiveTarget } from '../readerControls'

export interface AutoFullscreenControl {
  /** immersive (pseudo-fullscreen) aktif — chrome disembunyikan via CSS/state */
  active: boolean
  /** native Fullscreen API aktif (beneran full layar) */
  nativeActive: boolean
  /** niat terpasang (flick terdeteksi, menunggu tap untuk eksekusi) */
  pending: boolean
  /** panggil sinkron dalam event gesture asli (tap/klik) untuk masuk fullscreen */
  requestEnter: () => void
  /** paksa keluar + reset hitungan */
  reset: () => void
  /**
   * Batalkan NIAT fullscreen (`pending`) tanpa keluar dari fullscreen yang
   * sudah aktif. Dipakai saat pembaca menyentuh kontrol halaman / membuka
   * sheet: tap berikutnya tidak boleh "mewarisi" niat dari flick sebelumnya.
   */
  cancelPending: () => void
}

export function useAutoFullscreen(
  enabled: boolean,
  restoring: () => boolean = () => false,
): AutoFullscreenControl {
  const [immersive, setImmersive] = useState(false)
  const [nativeActive, setNativeActive] = useState(false)
  const [pending, setPending] = useState(false)
  const busyRef = useRef(false)
  const lastY = useRef(0)
  const samplesRef = useRef<{ t: number; dy: number }[]>([])
  const pendingTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const enabledRef = useRef(enabled)
  enabledRef.current = enabled
  const restoringRef = useRef(restoring)
  restoringRef.current = restoring
  /** true saat native ATAU immersive aktif — dibaca listener tanpa re-bind */
  const activeRef = useRef(false)
  activeRef.current = immersive || nativeActive

  const clearPending = useCallback(() => {
    if (pendingTimerRef.current) {
      clearTimeout(pendingTimerRef.current)
      pendingTimerRef.current = null
    }
    setPending(false)
  }, [])

  const armPending = useCallback(() => {
    if (pendingTimerRef.current) clearTimeout(pendingTimerRef.current)
    setPending(true)
    pendingTimerRef.current = setTimeout(() => {
      pendingTimerRef.current = null
      setPending(false)
    }, PENDING_TTL_MS)
  }, [])

  const requestEnter = useCallback(() => {
    // Tombol manual harus selalu bisa masuk fullscreen, independen dari
    // preferensi auto-fullscreen. `enabled` hanya meng-gate deteksi AUTO
    // (wheel/scroll), bukan jalur manual.
    if (busyRef.current) return
    // Sudah fullscreen (native) → jangan minta lagi; tap berikutnya berarti
    // "keluar", bukan "masuk". State diselaraskan di sini supaya tombol tidak
    // terus menampilkan "Masuk layar penuh" padahal layar sudah penuh
    // (mis. masuk lewat setelan reader / F11) — itu terasa seperti tombol mati.
    if (document.fullscreenElement) {
      setNativeActive(true)
      return
    }
    clearPending()
    const el = document.documentElement
    if (typeof el.requestFullscreen === 'function') {
      busyRef.current = true
      el.requestFullscreen().then(
        () => {
          busyRef.current = false
          setNativeActive(true)
        },
        () => {
          busyRef.current = false
          setImmersive(true) // ditolak → fallback immersive
        },
      )
    } else {
      setImmersive(true)
    }
  }, [clearPending])

  const exit = useCallback(() => {
    busyRef.current = false
    if (document.fullscreenElement) void document.exitFullscreen().catch(() => {})
    setNativeActive(false)
    setImmersive(false)
  }, [])

  const reset = useCallback(() => {
    clearPending()
    exit()
  }, [clearPending, exit])

  // Sinkron dengan state fullscreen asli browser — DUA ARAH:
  // - keluar (Esc / swipe): kosongkan native + immersive
  // - masuk dari jalur lain (F11, setelan `fullscreen` di sheet reader):
  //   `nativeActive` ikut menyala, kalau tidak tombol manual salah label dan
  //   requestEnter() jadi no-op (terasa "kadang tidak bisa dipencet").
  useEffect(() => {
    const onChange = () => {
      if (document.fullscreenElement) {
        setNativeActive(true)
        return
      }
      busyRef.current = false
      setNativeActive(false)
      setImmersive(false)
    }
    document.addEventListener('fullscreenchange', onChange)
    onChange() // halaman dibuka saat sudah fullscreen (reload / deep-link)
    return () => document.removeEventListener('fullscreenchange', onChange)
  }, [])

  // Lapis pengaman niat: sentuhan pada kontrol APA PUN membatalkan `pending`.
  //
  // `pending` berarti "tap berikutnya di area baca = masuk layar penuh". Kalau
  // niat itu bertahan saat user menekan tombol (mis. tombol melingkar "Muat
  // ulang" halaman), tap tersebut bisa terbaca sebagai perintah fullscreen —
  // laporan user "pencet tombol lingkaran malah fullscreen". Menangkap
  // pointerdown di fase capture membuat niat mati SEBELUM handler tombol
  // berjalan, jadi tombol selalu melakukan tugasnya sendiri.
  useEffect(() => {
    const onPointerDown = (e: PointerEvent) => {
      const el = e.target as Element | null
      // Tombol layar penuh sendiri: jangan batalkan niat di sini. Niat itulah
      // yang membuat tombol tampil sebagai pil berteks ("Layar penuh");
      // mematikannya saat pointerdown membuat tombol hilang (inert +
      // pointer-events:none) sebelum event click sampai, sehingga tap-nya
      // dibuang dan tombol terasa mati. requestEnter() di onClick yang
      // membersihkan niat.
      if (el && typeof el.closest === 'function' && el.closest(`[${FS_TOGGLE_ATTR}]`)) return
      if (isInteractiveTarget(e.target)) clearPending()
    }
    document.addEventListener('pointerdown', onPointerDown, true)
    return () => document.removeEventListener('pointerdown', onPointerDown, true)
  }, [clearPending])

  // Lapis 1 — deteksi intent: wheel velocity → arm pending.
  useEffect(() => {
    const onWheel = (e: WheelEvent) => {
      if (!enabledRef.current || restoringRef.current()) return
      // saat sudah fullscreen, scroll turun tidak perlu "menyiapkan" masuk
      // lagi — kalau di-arm, tap berikutnya jadi masuk (no-op) alih-alih
      // keluar. Ini yang bikin tombol terasa "kadang tidak responsif".
      if (activeRef.current || document.fullscreenElement) return
      const now = performance.now()
      samplesRef.current = pruneFlickSamples(
        [...samplesRef.current, { t: now, dy: e.deltaY }],
        now,
      )
      if (detectFlick(samplesRef.current, now)) armPending()
    }
    window.addEventListener('wheel', onWheel, { passive: true })
    return () => window.removeEventListener('wheel', onWheel)
  }, [armPending])

  // Exit via scroll naik (saat aktif) + batal pending via scroll naik.
  useEffect(() => {
    lastY.current = window.scrollY
    const onScroll = () => {
      if (!enabledRef.current) return
      if (restoringRef.current()) return
      const y = window.scrollY
      const d = y - lastY.current
      lastY.current = y
      const active = immersive || nativeActive
      if (Math.abs(d) < EXIT_SCROLL_THRESHOLD_PX) return
      if (d < 0) {
        if (active) exit()
        else clearPending()
      }
    }
    window.addEventListener('scroll', onScroll, { passive: true })
    return () => window.removeEventListener('scroll', onScroll)
  }, [exit, clearPending, immersive, nativeActive])

  return {
    active: immersive,
    nativeActive,
    pending,
    requestEnter,
    reset,
    cancelPending: clearPending,
  }
}
