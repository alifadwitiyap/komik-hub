import { useCallback, useEffect, useRef } from 'react'

type OverlayKind = 'menu' | 'settings' | 'chapter'

/**
 * Layer Back history untuk panel reader: saat panel aktif, Back pertama
 * menutup panel (popstate kita yang konsumsi), bukan keluar dari reader.
 * Escape/Tutup sudah mengembalikan fokus di masing-masing komponen panel.
 */
export function useReaderOverlayHistory(
  active: OverlayKind | null,
  close: () => void,
) {
  const closeRef = useRef(close)
  closeRef.current = close
  const activeRef = useRef(active)
  activeRef.current = active

  const dismiss = useCallback(() => {
    if (!activeRef.current) return
    activeRef.current = null
    // History entry harus dihapus SEBELUM close() memicu effect cleanup.
    // replaceState tidak memicu popstate, jadi Back berikutnya benar-benar
    // meninggalkan reader, bukan memutar panel yang baru saja ditutup.
    if (window.history.state && typeof window.history.state === 'object' && 'komikHubOverlay' in window.history.state) {
      window.history.replaceState(
        { ...window.history.state, komikHubOverlay: undefined },
        '',
      )
    }
    closeRef.current()
  }, [])

  useEffect(() => {
    if (!active) return
    const state = { komikHubOverlay: active }
    window.history.pushState(state, '')
    let consumed = false
    const onPop = () => {
      if (consumed) return
      consumed = true
      dismiss()
    }
    window.addEventListener('popstate', onPop)
    return () => {
      window.removeEventListener('popstate', onPop)
      // Kalau panel ditutup via Tutup/Escape, hapus entri history buatan.
      // replaceState hindari menambah entri baru; popstate tidak dipicu.
      if (!consumed) {
        window.history.replaceState(
          window.history.state && typeof window.history.state === 'object'
            ? { ...window.history.state, komikHubOverlay: undefined }
            : {},
          '',
        )
      }
    }
  }, [active, dismiss])

  return dismiss
}
