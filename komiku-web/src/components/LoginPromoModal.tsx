import { useEffect, useRef, useState, type FormEvent } from 'react'
import { useLocation } from 'react-router-dom'
import {
  getUser,
  setUser,
  onAccountChange,
  isValidUsername,
  USERNAME_RULE,
} from '../account'

const DISMISS_KEY = 'komik.login-promo.dismissed.v1'
const DISMISS_TTL = 24 * 60 * 60 * 1000 // 24 jam

function readDismissTime(): number | null {
  try {
    const raw = localStorage.getItem(DISMISS_KEY)
    if (!raw) return null
    const t = Number(raw)
    return Number.isFinite(t) ? t : null
  } catch {
    return null
  }
}

function saveDismissTime(): void {
  try {
    localStorage.setItem(DISMISS_KEY, String(Date.now()))
  } catch {
    /* storage privat / penuh — abaikan */
  }
}

/**
 * Promo login — tampil kalau user BELUM login dan belum men-dismiss dalam 24
 * jam terakhir, dan bukan di halaman /akun. Dismiss disimpan per-sesi di
 * localStorage (`komik.login-promo.dismissed.v1`). Form inline: username tanpa
 * password, pakai `setUser` dari account.ts.
 */
export default function LoginPromoModal() {
  const { pathname } = useLocation()
  const [username, setUsername] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [, setTick] = useState(0)
  const panelRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  const dismissedAt = readDismissTime()
  const dismissedRecently = dismissedAt !== null && Date.now() - dismissedAt < DISMISS_TTL
  // Scope 1: modal tidak menampilkan diri di rute baca (reader/maraton) supaya
  // tidak memblokir kontrol fullscreen & alur baca. Tetap tampil di halaman
  // non-baca (home/cari/rak/seri).
  const isReading = /^\/(baca|maraton)/.test(pathname)
  const visible = getUser() === null && pathname !== '/akun' && !isReading && !dismissedRecently

  // kalau user jadi login dari mana pun → popup menutup (re-evaluasi visibility)
  useEffect(() => {
    return onAccountChange(() => setTick((t) => t + 1))
  }, [])

  // A11Y: fokus pindah ke input saat terbuka; kembali ke pemicu saat ditutup
  useEffect(() => {
    if (!visible) return
    const opener = document.activeElement as HTMLElement | null
    const t = setTimeout(() => inputRef.current?.focus({ preventScroll: true }), 0)
    return () => {
      clearTimeout(t)
      opener?.focus?.({ preventScroll: true })
    }
  }, [visible])

  // Escape menutup (dismiss) + Tab diputar di dalam dialog (focus trap)
  useEffect(() => {
    if (!visible) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        dismiss()
        return
      }
      if (e.key !== 'Tab') return
      const panel = panelRef.current
      if (!panel) return
      const focusables = panel.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), input, [tabindex]:not([tabindex="-1"])',
      )
      if (focusables.length === 0) return
      const first = focusables[0]
      const last = focusables[focusables.length - 1]
      const active = document.activeElement
      if (e.shiftKey && active === first) {
        e.preventDefault()
        last.focus()
      } else if (!e.shiftKey && active === last) {
        e.preventDefault()
        first.focus()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [visible])

  // scroll lock: roda mouse di luar panel tidak boleh menggulir halaman
  useEffect(() => {
    if (!visible) return
    const onWheel = (e: WheelEvent) => {
      const t = e.target as Node | null
      if (t && panelRef.current?.contains(t)) return
      e.preventDefault()
    }
    document.addEventListener('wheel', onWheel, { passive: false })
    return () => document.removeEventListener('wheel', onWheel)
  }, [visible])

  const dismiss = () => {
    saveDismissTime()
    setError(null)
    setTick((t) => t + 1)
  }

  const submit = (e: FormEvent) => {
    e.preventDefault()
    if (!isValidUsername(username)) {
      setError(USERNAME_RULE)
      return
    }
    setUser(username.trim(), true)
  }

  if (!visible) return null

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
      onClick={dismiss}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label="Masuk tanpa password"
        data-login-promo
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-sm overflow-hidden rounded-2xl border border-ink-800 bg-ink-900 shadow-2xl shadow-black/30"
      >
        {/* strip brand hijau */}
        <div className="flex items-center gap-2 border-b border-healthy/25 bg-healthy/10 px-4 py-3">
          <span className="size-2 rounded-full bg-healthy" aria-hidden="true" />
          <p className="text-[11px] font-bold uppercase tracking-wider text-healthy">
            Komik Hub · Akun
          </p>
        </div>

        <div className="px-5 pb-5 pt-4">
          <h2 className="font-display text-lg font-bold text-ink-100">Masuk tanpa password</h2>
          <p className="mt-1 text-[13px] leading-relaxed text-ink-400">
            Cukup ketik satu username — tidak perlu password. Favorit, progres baca, dan
            notifikasi akan tersimpan per akun.
          </p>

          <form onSubmit={submit} noValidate className="mt-4 space-y-3">
            <input
              ref={inputRef}
              type="text"
              value={username}
              onChange={(e) => {
                setUsername(e.target.value)
                if (error) setError(null)
              }}
              placeholder="username"
              autoComplete="off"
              spellCheck={false}
              aria-label="Username"
              aria-invalid={error ? true : undefined}
              className={`w-full rounded-xl border bg-ink-950 px-3.5 py-2.5 text-[13px] text-ink-200 outline-none transition-colors placeholder:text-ink-500 focus:ring-2 ${
                error
                  ? 'border-danger-ink focus:border-danger-ink focus:ring-danger-ink/20'
                  : 'border-ink-800 focus:border-healthy focus:ring-healthy/15'
              }`}
            />
            {error && (
              <p role="alert" className="text-[12px] font-medium text-danger-ink">
                {error}
              </p>
            )}
            <button
              type="submit"
              className="w-full rounded-xl bg-healthy py-2.5 text-[13px] font-bold text-ink-950 transition-colors hover:bg-healthy/85 active:bg-healthy/70"
            >
              Lanjut
            </button>
          </form>
        </div>

        <div className="flex items-center justify-between border-t border-ink-800 px-4 py-2.5">
          <button
            type="button"
            onClick={dismiss}
            aria-label="Tutup"
            className="grid size-8 place-items-center rounded-full text-ink-400 transition-colors hover:bg-ink-850 hover:text-ink-200"
          >
            <svg
              viewBox="0 0 24 24"
              className="size-4"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              aria-hidden="true"
            >
              <path d="M6 6l12 12M18 6L6 18" strokeLinecap="round" />
            </svg>
          </button>
          <button
            type="button"
            onClick={dismiss}
            className="text-[12px] font-semibold text-ink-400 transition-colors hover:text-ink-200"
          >
            Nanti saja
          </button>
        </div>
      </div>
    </div>
  )
}
