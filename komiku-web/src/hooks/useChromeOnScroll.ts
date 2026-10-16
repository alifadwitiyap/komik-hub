/**
 * useChromeOnScroll — chrome reader (toolbar atas + footer bawah) mengikuti
 * arah scroll: turun = sembunyi, naik = tampil. Tap tengah tetap jadi toggle
 * manual (toggle()).
 *
 * Selama `restoring()` true — posisi baca chapter sedang dipulihkan — scroll
 * programatik TIDAK memicu apa pun: chapter yang dibuka lagi di tengah tidak
 * boleh langsung kehilangan judul/progresnya.
 *
 * Threshold 40px supaya scroll kecil/inertia tidak bikin chrome kedip.
 */
import { useCallback, useEffect, useRef, useState } from 'react'

const THRESHOLD_PX = 40

export interface ChromeControl {
  visible: boolean
  /** toggle manual (tap tengah) */
  toggle: () => void
  /** paksa tampil — dipakai saat chapter berganti */
  show: () => void
}

export function useChromeOnScroll(
  restoring: () => boolean = () => false,
): ChromeControl {
  const [visible, setVisible] = useState(true)
  const lastY = useRef(0)
  // callback disimpan di ref supaya listener tidak di-rebind tiap render
  // (pemanggil biasanya mengirim arrow function baru setiap kali)
  const restoringRef = useRef(restoring)
  restoringRef.current = restoring

  const show = useCallback(() => setVisible(true), [])
  const toggle = useCallback(() => setVisible((v) => !v), [])

  useEffect(() => {
    lastY.current = window.scrollY
    const onScroll = () => {
      if (restoringRef.current()) return
      const y = window.scrollY
      const d = y - lastY.current
      if (Math.abs(d) < THRESHOLD_PX) return
      // di puncak halaman: selalu tampil (aman kalau user scroll ke atas
      // dari posisi tersembunyi lalu berhenti di tepi)
      if (y <= 0) {
        setVisible(true)
        lastY.current = y
        return
      }
      setVisible(d < 0)
      lastY.current = y
    }
    window.addEventListener('scroll', onScroll, { passive: true })
    return () => window.removeEventListener('scroll', onScroll)
  }, [])

  return { visible, toggle, show }
}
