/**
 * Tema terang/gelap — helper murni (tanpa DOM) supaya bisa diuji, plus
 * pemasangan ke <html> yang dipisah agar mudah dites.
 *
 * Aturan (keputusan grilling):
 * 1. Tersimpan di localStorage `komik-theme` ("light" | "dark").
 * 2. Belum pernah memilih → ikut `prefers-color-scheme` OS (dibaca SEKALI).
 * 3. Setelah user memilih, pilihan user yang menang — perubahan OS tidak
 *    lagi diikuti (app tidak boleh berganti warna sendiri di tengah baca).
 * 4. Class `dark` di <html> adalah satu-satunya sumber kebenaran; CSS
 *    memetakan ulang token `ink-*` di bawah `.dark`.
 */

export type Theme = 'light' | 'dark'

export const THEME_KEY = 'komik-theme'

/** Nilai tersedia yang sah (localStorage bisa berisi sampah). */
export function normalizeTheme(v: unknown): Theme | null {
  return v === 'light' || v === 'dark' ? v : null
}

/** Nilai awal: pilihan tersimpan → OS → terang. `prefersDark` = hasil matchMedia. */
export function initialTheme(stored: unknown, prefersDark: boolean): Theme {
  return normalizeTheme(stored) ?? (prefersDark ? 'dark' : 'light')
}

/** Tema sesudah toggle (satu-satunya operasi yang tersedia). */
export function nextTheme(t: Theme): Theme {
  return t === 'dark' ? 'light' : 'dark'
}

/** Ikon + label dipakai bersama supaya tidak ada yang berbeda pendapat. */
export function themeIcon(t: Theme): 'moon' | 'sun' {
  return t === 'dark' ? 'sun' : 'moon'
}

export function themeToggleLabel(t: Theme): string {
  return t === 'dark' ? 'Mode terang' : 'Mode gelap'
}

/** Baca localStorage dengan aman (private mode / storage diblokir). */
export function readStoredTheme(): Theme | null {
  try {
    return normalizeTheme(window.localStorage.getItem(THEME_KEY))
  } catch {
    return null
  }
}

export function writeStoredTheme(t: Theme): void {
  try {
    window.localStorage.setItem(THEME_KEY, t)
  } catch {
    /* storage diblokir: tema tetap jalan untuk sesi ini */
  }
}

/** Pasang class `dark` di <html> — sumber kebenaran tunggal untuk CSS. */
export function applyTheme(t: Theme): void {
  const root = document.documentElement
  root.classList.toggle('dark', t === 'dark')
  root.style.colorScheme = t
}

/** Siapkan tema SEBELUM render (dipanggil dari main.tsx) supaya tidak kedip. */
export function bootstrapTheme(): Theme {
  const t = initialTheme(readStoredTheme(), prefersDark())
  applyTheme(t)
  return t
}

export function prefersDark(): boolean {
  try {
    return window.matchMedia('(prefers-color-scheme: dark)').matches
  } catch {
    return false
  }
}
