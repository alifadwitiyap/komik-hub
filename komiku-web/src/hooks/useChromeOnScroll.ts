/**
 * useChromeOnScroll — chrome reader (toolbar atas + footer bawah) mengikuti
 * arah scroll: turun = sembunyi, naik = tampil. Tap tengah tetap jadi toggle
 * manual (toggle()).
 *
 * Selama `restoring()` true — posisi baca chapter sedang dipulihkan — scroll
 * programatik TIDAK memicu apa pun: chapter yang dibuka lagi di tengah tidak
 * boleh langsung kehilangan judul/progresnya.
 *
 * Threshold 24px supaya scroll kecil/inertia tidak bikin chrome kedip,
 * tapi cukup responsif saat scroll turun.
 *
 * Akumulasi DISENGAJA, tapi patokan di-reset saat ARAH BERBALIK.
 *
 * Kenapa dua posisi, bukan satu:
 *   - `anchor`   : patokan akumulasi, dipakai memutuskan `visible`
 *   - `lastSeen` : posisi event sebelumnya, dipakai mendeteksi belok
 *
 * Versi lama hanya menyimpan satu patokan dan tidak memajukannya saat
 * `|d| < 40`. Akibatnya, dengan langkah 30–39 px (delta roda mouse/trackpad),
 * ambang efektif membengkak sampai 78 px, dan saat arah berbalik sisa delta
 * arah lama harus "dibayar" dulu sebelum arah baru diakui (dead zone).
 * Diukur empiris: langkah 39 px -> chrome baru sembunyi di 78 px (1,95x),
 * dan scroll naik 39 px butuh 78 px sebelum chrome muncul lagi.
 *
 * Memindahkan `anchor` ke atas early-return (fix naif) BUKAN solusinya: itu
 * membuat scroll halus tidak pernah bertindak sama sekali — dibuktikan di
 * `scripts/check-chrome-scroll-logic.ts` bagian E1/E2. Yang benar: akumulasi
 * searah diizinkan, patokan hanya di-reset ke TITIK BALIK saat arah berubah
 * (bagian E3–E9).
 */
import { useCallback, useEffect, useRef, useState } from 'react'

import { isChromeToggleKey } from '../readerChromeKeys'

const THRESHOLD_PX = 24

export interface ChromeControl {
  visible: boolean
  /** toggle manual (tap tengah / tombol 'H') */
  toggle: () => void
  /** paksa tampil — dipakai saat chapter berganti */
  show: () => void
}

export function useChromeOnScroll(
  restoring: () => boolean = () => false,
): ChromeControl {
  const [visible, setVisible] = useState(true)
  /** patokan akumulasi — dipakai memutuskan `visible` */
  const anchor = useRef(0)
  /** posisi event sebelumnya — dipakai mendeteksi pembalikan arah */
  const lastSeen = useRef(0)
  const dir = useRef(0)
  // callback disimpan di ref supaya listener tidak di-rebind tiap render
  // (pemanggil biasanya mengirim arrow function baru setiap kali)
  const restoringRef = useRef(restoring)
  restoringRef.current = restoring

  const show = useCallback(() => setVisible(true), [])
  const toggle = useCallback(() => setVisible((v) => !v), [])

  // Pemicu keyboard: 'H'/'h' toggle chrome. Abaikan kalau fokus sedang di
  // input/textarea/select/contenteditable atau elemen lain yang memakai tombol
  // itu (mis. dialog preferensi) — handler hanya jalan saat fokus di body /
  // area baca, jadi shortcut tidak mengganggu form.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!isChromeToggleKey(e)) return
      const t = e.target as HTMLElement | null
      if (t?.closest('input, textarea, select, [contenteditable="true"], [role="dialog"]')) {
        return
      }
      toggle()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [toggle])

  useEffect(() => {
    anchor.current = window.scrollY
    lastSeen.current = window.scrollY
    dir.current = 0
    const onScroll = () => {
      if (restoringRef.current()) return
      const y = window.scrollY
      const move = y - lastSeen.current
      const moveDir = Math.sign(move)
      // arah berbalik: TITIK BALIK (posisi sebelumnya) jadi patokan baru,
      // supaya delta arah lama tidak perlu "dibayar" dulu
      if (moveDir !== 0 && dir.current !== 0 && moveDir !== dir.current) {
        anchor.current = lastSeen.current
      }
      if (moveDir !== 0) dir.current = moveDir
      lastSeen.current = y

      const d = y - anchor.current
      if (Math.abs(d) < THRESHOLD_PX) return
      // di puncak halaman: selalu tampil (aman kalau user scroll ke atas
      // dari posisi tersembunyi lalu berhenti di tepi)
      if (y <= 0) {
        setVisible(true)
        anchor.current = y
        dir.current = 0
        return
      }
      setVisible(d < 0)
      anchor.current = y
    }
    window.addEventListener('scroll', onScroll, { passive: true })
    return () => window.removeEventListener('scroll', onScroll)
  }, [])

  return { visible, toggle, show }
}
