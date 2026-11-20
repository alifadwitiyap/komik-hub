import { useEffect, useState } from 'react'

/**
 * Sheet tetap terpasang ~160ms setelah `open` berubah false supaya animasi
 * keluar bisa jalan. Bisa dibatalkan: buka lagi sebelum timer habis langsung
 * membatalkan exit, sehingga ketuk buka→tutup→buka cepat tetap responsif.
 */
export function useSheetPresence(open: boolean, exitMs = 160) {
  const [mounted, setMounted] = useState(open)
  useEffect(() => {
    if (open) {
      setMounted(true)
      return
    }
    const t = window.setTimeout(() => setMounted(false), exitMs)
    return () => window.clearTimeout(t)
  }, [open, exitMs])
  return mounted
}
