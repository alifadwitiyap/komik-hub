import { useEffect, useRef, useState } from 'react'
import { useLocation } from 'react-router-dom'

function isReaderRoute(pathname: string): boolean {
  return pathname.startsWith('/baca/') || pathname.startsWith('/maraton/')
}

/**
 * Toast pembaruan shell: non-blocking, di atas bottom nav, dan DITAHAN saat
 * pembaca sedang di /baca/* atau /maraton/*. Tombol aksinya meminta SW baru
 * mengambil alih; reload hanya setelah controller benar-benar berganti.
 */
export default function SwUpdateToast() {
  const { pathname } = useLocation()
  const [ready, setReady] = useState(false)
  const waitingWorker = useRef<ServiceWorker | null>(null)
  const applied = useRef(false)

  useEffect(() => {
    if (!('serviceWorker' in navigator)) return
    let active = true
    let registration: ServiceWorkerRegistration | undefined

    const noteWaiting = () => {
      const worker = registration?.waiting
      if (active && worker && navigator.serviceWorker.controller) {
        waitingWorker.current = worker
        setReady(true)
      }
    }
    const onUpdateFound = () => {
      const worker = registration?.installing
      if (!worker) return
      worker.addEventListener('statechange', () => {
        if (worker.state === 'installed') noteWaiting()
      })
    }
    const onControllerChange = () => {
      if (applied.current) window.location.reload()
    }

    navigator.serviceWorker.ready
      .then((reg) => {
        if (!active) return
        registration = reg
        reg.addEventListener('updatefound', onUpdateFound)
        noteWaiting()
      })
      .catch(() => {})
    navigator.serviceWorker.addEventListener('controllerchange', onControllerChange)

    return () => {
      active = false
      registration?.removeEventListener('updatefound', onUpdateFound)
      navigator.serviceWorker.removeEventListener('controllerchange', onControllerChange)
    }
  }, [])

  if (!ready || isReaderRoute(pathname)) return null

  const applyUpdate = () => {
    const worker = waitingWorker.current
    if (!worker) return
    applied.current = true
    setReady(false)
    worker.postMessage({ type: 'SKIP_WAITING' })
  }

  return (
    <div className="pointer-events-none fixed inset-x-3 bottom-[calc(4.75rem+env(safe-area-inset-bottom))] z-30 mx-auto max-w-3xl">
      <div
        role="status"
        className="kh-toast-enter pointer-events-auto flex items-center gap-3 rounded-2xl border border-ink-700 bg-ink-900/95 px-3 py-2 shadow-lg backdrop-blur-[16px]"
      >
        <p className="min-w-0 flex-1 text-[13px] font-medium text-ink-100">Versi baru siap</p>
        <button
          type="button"
          onClick={applyUpdate}
          className="kh-toast-enter kh-tap shrink-0 rounded-xl bg-brand-amber px-4 text-[13px] font-semibold text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-amber"
        >
          Muat ulang
        </button>
      </div>
    </div>
  )
}
