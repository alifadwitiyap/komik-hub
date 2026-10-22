/**
 * useAutoFullscreen — masuk layar penuh setelah scroll turun cukup jauh.
 *
 * Desain (hasil grill + perbaikan UX):
 * - Trigger: akumulasi JARAK scroll-turun (`TRIGGER_PX`). Begitu total turun
 *   melewati ambang, masuk fullscreen. Satu gerakan scroll cepat langsung
 *   memicu — tidak perlu menghitung gestur diskrit.
 * - Arah naik me-reset akumulasi (dari state non-aktif).
 * - Saat aktif: scroll naik → keluar. `exit()` TIDAK me-reset akumulasi,
 *   jadi begitu user batalin lalu scroll turun lagi, dia langsung masuk lagi
 *   (tanpa harus mengulang jarak penuh).
 * - `reset()` (tap tengah / ganti chapter) keluar + reset akumulasi penuh.
 * - Mode hybrid: Fullscreen API native dulu; kalau ditolak → "immersive"
 *   (pseudo-fullscreen, hanya sembunyiin chrome via state).
 * - Exit juga via Esc (fullscreenchange).
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { gestureStep, THRESHOLD_PX } from './autoFullscreenLogic'

export interface AutoFullscreenControl {
  /** immersive (pseudo-fullscreen) aktif — chrome disembunyikan via CSS/state */
  active: boolean
  /** native Fullscreen API aktif (beneran full layar) */
  nativeActive: boolean
  /** paksa keluar + reset hitungan */
  reset: () => void
}

export function useAutoFullscreen(
  enabled: boolean,
  restoring: () => boolean = () => false,
): AutoFullscreenControl {
  const [immersive, setImmersive] = useState(false)
  const [nativeActive, setNativeActive] = useState(false)
  const pixelsRef = useRef(0)
  const lastY = useRef(0)
  const enabledRef = useRef(enabled)
  enabledRef.current = enabled
  const restoringRef = useRef(restoring)
  restoringRef.current = restoring

  const enter = useCallback(() => {
    if (!enabledRef.current) return
    const el = document.documentElement
    if (typeof el.requestFullscreen === 'function') {
      el.requestFullscreen().then(
        () => setNativeActive(true),
        () => setImmersive(true), // ditolak → fallback immersive
      )
    } else {
      setImmersive(true)
    }
  }, [])

  const exit = useCallback(() => {
    if (document.fullscreenElement) void document.exitFullscreen().catch(() => {})
    setNativeActive(false)
    setImmersive(false)
  }, [])

  const reset = useCallback(() => {
    pixelsRef.current = 0
    exit()
  }, [exit])

  // Sinkron dengan state fullscreen asli browser (mis. user menekan Esc).
  useEffect(() => {
    const onChange = () => {
      if (!document.fullscreenElement) {
        setNativeActive(false)
      }
    }
    document.addEventListener('fullscreenchange', onChange)
    return () => document.removeEventListener('fullscreenchange', onChange)
  }, [])

  useEffect(() => {
    lastY.current = window.scrollY
    const onScroll = () => {
      if (!enabledRef.current) return
      if (restoringRef.current()) return
      const y = window.scrollY
      const d = y - lastY.current
      lastY.current = y
      // saat aktif: scroll naik (melewati threshold) → lepas fullscreen.
      // Akumulasi sengaja TIDAK di-reset → begitu turun lagi langsung bisa
      // masuk kembali.
      if (immersive || nativeActive) {
        if (Math.abs(d) >= THRESHOLD_PX && d < 0) exit()
        return
      }
      if (Math.abs(d) < THRESHOLD_PX) return
      const step = gestureStep(pixelsRef.current, d)
      pixelsRef.current = step.pixels
      if (step.fire) enter()
    }
    window.addEventListener('scroll', onScroll, { passive: true })
    return () => window.removeEventListener('scroll', onScroll)
  }, [enter, exit, immersive, nativeActive])

  return { active: immersive, nativeActive, reset }
}
