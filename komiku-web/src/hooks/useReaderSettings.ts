import { useCallback, useEffect, useState } from 'react'
import { DEFAULT_SETTINGS, type ReaderSettings } from '../components/ReaderMenu'
import { useAutoScroll } from './useAutoScroll'

const KEY = 'komiku.web.reader.settings.v1'

function load(): ReaderSettings {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return DEFAULT_SETTINGS
    return { ...DEFAULT_SETTINGS, ...(JSON.parse(raw) as Partial<ReaderSettings>) }
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
   * CSS filter untuk tumpukan gambar: kecerahan + perisai malam.
   *
   * PENTING: kalau tidak ada yang perlu difilter (brightness 100 & night shift
   * mati), JANGAN pasang `filter` sama sekali. `brightness(100%)` tetap
   * membuat stacking context + layer GPU sepanjang seluruh chapter (bisa
   * puluhan ribu px). Layer sebesar itu dirasterisasi per-tile dan bisa
   * memunculkan garis tipis di batas tile — salah satu sumber "garis-garis"
   * yang terlihat di HP. Tanpa filter, gambar digambar langsung ke layer
   * halaman: tidak ada tile seam, dan memori GPU jauh lebih kecil.
   */
  const filterStyle =
    settings.brightness === 100 && !settings.nightShift
      ? undefined
      : {
          filter: `brightness(${settings.brightness}%)${
            settings.nightShift ? ' sepia(0.4) hue-rotate(-12deg)' : ''
          }`,
        }

  return { settings, onChange, onReset, filterStyle }
}
