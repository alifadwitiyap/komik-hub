/**
 * useAutoFullscreen — masuk layar penuh setelah beberapa gestur scroll turun.
 *
 * Desain (hasil grill):
 * - Trigger: 3 gestur scroll-bawah (tiap turun melewati threshold 40px),
 *   arah naik mereset hitungan. Scroll programatik saat pemulihan chapter
 *   (restoring) tidak memicu.
 * - Mode hybrid: cobain Fullscreen API native dulu; kalau ditolak (scroll
 *   bukan user-gesture — iOS Safari/Chrome sering menolak), fallback ke
 *   "immersive" (pseudo-fullscreen, hanya sembunyiin chrome via state).
 * - Exit: scroll balik ke puncak, atau kontrol eksplisit (tap tengah),
 *   atau user menekan Esc (dipantau via fullscreenchange).
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { gestureStep } from './autoFullscreenLogic'

const THRESHOLD_PX = 40

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
  const countRef = useRef(0)
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
    countRef.current = 0
    exit()
  }, [exit])

  // Sinkron dengan state fullscreen asli browser (mis. user menekan Esc).
  useEffect(() => {
    const onChange = () => {
      if (!document.fullscreenElement) {
        setNativeActive(false)
        countRef.current = 0
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
      // saat aktif: scroll naik (melewati threshold) → lepas fullscreen
      if (immersive || nativeActive) {
        if (Math.abs(d) >= THRESHOLD_PX && d < 0) exit()
        return
      }
      if (Math.abs(d) < THRESHOLD_PX) return
      const step = gestureStep(countRef.current, d)
      countRef.current = step.count
      if (step.fire) enter()
    }
    window.addEventListener('scroll', onScroll, { passive: true })
    return () => window.removeEventListener('scroll', onScroll)
  }, [enter, exit, immersive, nativeActive])

  return { active: immersive, nativeActive, reset }
}
