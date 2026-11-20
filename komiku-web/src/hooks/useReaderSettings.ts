import { useCallback, useEffect, useState } from 'react'
import { DEFAULT_SETTINGS, type ReaderSettings } from '../components/ReaderMenu'
import { READER_SETTINGS_KEY, parseReaderSettings } from '../readerSettings'
import { useAutoScroll } from './useAutoScroll'

const KEY = READER_SETTINGS_KEY

function load(): ReaderSettings {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return DEFAULT_SETTINGS
    return { ...DEFAULT_SETTINGS, ...(parseReaderSettings(raw) as Partial<ReaderSettings>) }
  } catch {
    return DEFAULT_SETTINGS
  }
}

/**
 * Preferensi reader Komiku+ — persis opsi sheet_reader_settings:
 * night shift & brightness benar-benar diterapkan sebagai CSS filter ke
 * tumpukan gambar; keep-screen-on pakai Wake Lock; fullscreen pakai API native.
 */
export function useReaderSettings() {
  const [settings, setSettings] = useState<ReaderSettings>(load)

  const onChange = useCallback((patch: Partial<ReaderSettings>) => {
    setSettings((s) => {
      const next = { ...s, ...patch }
      try {
        localStorage.setItem(KEY, JSON.stringify(next))
      } catch {
        /* storage penuh: preferensi tak persisten, tetap jalan */
      }
      return next
    })
  }, [])

  const onReset = useCallback(() => {
    setSettings(DEFAULT_SETTINGS)
    try {
      localStorage.removeItem(KEY)
    } catch {
      /* ignore */
    }
  }, [])

  // Putar Otomatis
  useAutoScroll(settings.autoScroll, settings.speed)

  // Layar tetap menyala (Wake Lock) — gagal senyap kalau tak didukung
  useEffect(() => {
    if (!settings.keepScreenOn) return
    let sentinel: WakeLockSentinel | null = null
    let cancelled = false
    navigator.wakeLock
      ?.request('screen')
      .then((s) => {
        if (cancelled) void s.release()
        else sentinel = s
      })
      .catch(() => {
        /* Wake Lock tak tersedia (mis. non-HTTPS lama) */
      })
    return () => {
      cancelled = true
      void sentinel?.release()
    }
  }, [settings.keepScreenOn])

  // Layar penuh
  useEffect(() => {
    if (settings.fullscreen) {
      document.documentElement.requestFullscreen?.().catch(() => {
        /* user gesture diperlukan / tak didukung */
      })
    } else if (document.fullscreenElement) {
      void document.exitFullscreen().catch(() => {})
    }
  }, [settings.fullscreen])

  /**
   * CSS filter untuk perisai malam saja. Kecerahan & tint hangat dipindah ke
   * overlay tetap (lihat `.reader-night-overlay`) supaya tidak menumpuk filter
   * di atas puluhan ribu px gambar — itu memicu tile seam & layer GPU besar.
   * Tanpa night shift JANGAN pasang `filter` sama sekali.
   */
  const filterStyle = settings.nightShift
    ? { filter: 'sepia(0.4) hue-rotate(-12deg)' }
    : undefined

  /** Opacity overlay hitam untuk kecerahan <100% (perilaku lama dipertahankan). */
  const dimOpacity = Math.max(0, (100 - settings.brightness) / 100) * 0.85
  /** Overlay amber untuk tint hangat; tidak menyentuh `filter` gambar. */
  const warmOpacity = Math.max(0, Math.min(100, settings.warmth)) / 100 * 0.22

  return { settings, onChange, onReset, filterStyle, dimOpacity, warmOpacity }
}
