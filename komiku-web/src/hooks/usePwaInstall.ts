import { useCallback, useEffect, useRef, useState } from 'react'

const DISMISS_KEY = 'komik-pwa-dismissed'
const DISMISS_MS = 14 * 24 * 60 * 60 * 1000

interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>
}

export interface PwaInstallControl {
  isStandalone: boolean
  isIosSafari: boolean
  canPromptAndroid: boolean
  dismissed: boolean
  promptInstall: () => Promise<void>
  dismissBanner: () => void
}

function detectStandalone(): boolean {
  if (typeof window === 'undefined') return false
  const nav = navigator as Navigator & { standalone?: boolean }
  return window.matchMedia('(display-mode: standalone)').matches || nav.standalone === true
}

function detectIosSafari(): boolean {
  if (typeof navigator === 'undefined') return false
  const ua = navigator.userAgent
  const ios = /iPad|iPhone|iPod/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)
  return ios && /Safari\//.test(ua) && !/CriOS|FxiOS|EdgiOS|OPiOS/.test(ua)
}

function isDismissedNow(): boolean {
  try {
    const raw = localStorage.getItem(DISMISS_KEY)
    if (!raw) return false
    const at = Number(raw)
    return Number.isFinite(at) && Date.now() - at < DISMISS_MS
  } catch {
    return false
  }
}

/**
 * Satu sumber keadaan install untuk banner beranda dan kartu Akun.
 * `dismissBanner` memakai timestamp (bukan boolean) supaya tenggang 14 hari
 * bisa dihitung ulang saat halaman dibuka berikutnya.
 */
export function usePwaInstall(): PwaInstallControl {
  const [isStandalone, setStandalone] = useState(detectStandalone)
  const [dismissed, setDismissed] = useState(isDismissedNow)
  const [canPromptAndroid, setCanPrompt] = useState(false)
  const deferred = useRef<BeforeInstallPromptEvent | null>(null)
  const isIosSafari = detectIosSafari()

  useEffect(() => {
    const mq = window.matchMedia('(display-mode: standalone)')
    const onModeChange = () => setStandalone(mq.matches || detectStandalone())
    mq.addEventListener('change', onModeChange)

    const onPrompt = (event: Event) => {
      event.preventDefault() // jangan biarkan Chrome memunculkan prompt sendiri
      deferred.current = event as BeforeInstallPromptEvent
      setCanPrompt(true)
    }
    const onInstalled = () => {
      deferred.current = null
      setCanPrompt(false)
      setStandalone(true)
    }
    window.addEventListener('beforeinstallprompt', onPrompt)
    window.addEventListener('appinstalled', onInstalled)
    return () => {
      mq.removeEventListener('change', onModeChange)
      window.removeEventListener('beforeinstallprompt', onPrompt)
      window.removeEventListener('appinstalled', onInstalled)
    }
  }, [])

  const promptInstall = useCallback(async () => {
    const event = deferred.current
    if (!event) return
    deferred.current = null
    setCanPrompt(false)
    try {
      await event.prompt()
      await event.userChoice
    } catch {
      /* user membatalkan / browser menolak: tidak perlu pesan error */
    }
  }, [])

  const dismissBanner = useCallback(() => {
    try {
      localStorage.setItem(DISMISS_KEY, String(Date.now()))
    } catch {
      /* storage privat: tutup tetap berlaku untuk sesi ini */
    }
    setDismissed(true)
  }, [])

  return { isStandalone, isIosSafari, canPromptAndroid, dismissed, promptInstall, dismissBanner }
}
