import { useCallback, useEffect, useState } from 'react'
import {
  applyTheme,
  nextTheme,
  readStoredTheme,
  themeIcon,
  themeToggleLabel,
  writeStoredTheme,
  type Theme,
} from '../theme'

export interface ThemeControl {
  theme: Theme
  toggle: () => void
  /** ikon yang harus tampil: bulan saat terang (klik → gelap), sebaliknya */
  icon: 'moon' | 'sun'
  /** label aksesibilitas tombol (menyatakan aksi) */
  toggleLabel: string
}

/** Baca class `dark` yang SUDAH dipasang bootstrap. Dijaga try/catch supaya
 *  aman di lingkungan tanpa DOM (wiring-check merender App di Node). */
function currentTheme(): Theme {
  try {
    return document.documentElement.classList.contains('dark') ? 'dark' : 'light'
  } catch {
    return readStoredTheme() ?? 'light'
  }
}

/**
 * Tema aktif + toggle.
 *
 * Class `dark` di <html> SUDAH dipasang `bootstrapTheme()` di main.tsx
 * sebelum render, jadi hook ini HANYA membaca keadaan itu — tidak memanggil
 * bootstrap sendiri (itu menyentuh DOM saat inisialisasi state).
 *
 * prefers-color-scheme TIDAK didengar setelah mount: pilihan user yang
 * menentukan setelah first visit (keputusan grilling Q4).
 */
export function useTheme(): ThemeControl {
  const [theme, setTheme] = useState<Theme>(currentTheme)

  const toggle = useCallback(() => {
    setTheme((prev) => {
      const next = nextTheme(prev)
      applyTheme(next)
      writeStoredTheme(next)
      return next
    })
  }, [])

  // Sinkronkan kalau class di <html> berubah dari luar (mis. devtools).
  useEffect(() => {
    const obs = new MutationObserver(() => {
      const dark = document.documentElement.classList.contains('dark')
      setTheme(dark ? 'dark' : 'light')
    })
    obs.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['class'],
    })
    return () => obs.disconnect()
  }, [])

  return {
    theme,
    toggle,
    icon: themeIcon(theme),
    toggleLabel: themeToggleLabel(theme),
  }
}

/** hanya untuk tes/E2E: baca tema tersimpan tanpa efek samping. */
export function storedTheme(): Theme | null {
  return readStoredTheme()
}
