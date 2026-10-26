/**
 * useAutoFullscreen — masuk/keluar layar penuh HANYA lewat tombol manual
 * (ReaderFullscreenButton).
 *
 * Per feedback (2026-10-26): auto-fullscreen dihapus —
 * - flick/scroll TIDAK lagi meng-arm niat fullscreen;
 * - tap pada halaman bacaan TIDAK toggle fullscreen (cuma toggle chrome);
 * - scroll ke atas TIDAK keluar dari fullscreen.
 * Jadi requestEnter/reset hanya dipanggil dari tombol.
 *
 * Tetap dua output: native Fullscreen API, dan fallback "immersive"
 * (sembunyikan chrome) saat API tak tersedia/ditolak (mis. iOS Safari).
 */
import { useCallback, useEffect, useRef, useState } from 'react'

export interface AutoFullscreenControl {
  /** immersive (pseudo-fullscreen) aktif — chrome disembunyikan via CSS/state */
  active: boolean
  /** native Fullscreen API aktif (beneran full layar) */
  nativeActive: boolean
  /** panggil sinkron dari onClick tombol untuk masuk fullscreen */
  requestEnter: () => void
  /** paksa keluar + reset state */
  reset: () => void
}

export function useAutoFullscreen(): AutoFullscreenControl {
  const [immersive, setImmersive] = useState(false)
  const [nativeActive, setNativeActive] = useState(false)
  const busyRef = useRef(false)

  const requestEnter = useCallback(() => {
    if (busyRef.current) return
    // Sudah fullscreen (native) → jangan minta lagi; state diselaraskan.
    if (document.fullscreenElement) {
      setNativeActive(true)
      return
    }
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
  }, [])

  const reset = useCallback(() => {
    busyRef.current = false
    if (document.fullscreenElement) void document.exitFullscreen().catch(() => {})
    setNativeActive(false)
    setImmersive(false)
  }, [])

  // Sinkron dengan state fullscreen asli browser — DUA ARAH:
  // - keluar (Esc / F11): kosongkan native + immersive
  // - masuk dari jalur lain (F11, setelan `fullscreen` di sheet reader):
  //   `nativeActive` ikut menyala.
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

  return {
    active: immersive,
    nativeActive,
    requestEnter,
    reset,
  }
}
