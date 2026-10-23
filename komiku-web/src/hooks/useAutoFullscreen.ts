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
    if (!enabledRef.current) return
    if (busyRef.current) return
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

  // Sinkron dengan state fullscreen asli browser (mis. user menekan Esc).
  // Saat keluar fullscreen, kosongkan SEMUA state aktif (native + immersive)
  // dan reset akumulasi → scroll berikutnya bisa memicu lagi.
  useEffect(() => {
    const onChange = () => {
      if (!document.fullscreenElement) {
        busyRef.current = false
        setNativeActive(false)
        setImmersive(false)
      }
    }
    document.addEventListener('fullscreenchange', onChange)
    return () => document.removeEventListener('fullscreenchange', onChange)
  }, [])

  // Lapis 1 — deteksi intent: wheel velocity → arm pending.
  useEffect(() => {
    const onWheel = (e: WheelEvent) => {
      if (!enabledRef.current || restoringRef.current()) return
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

  return { active: immersive, nativeActive, pending, requestEnter, reset }
}
