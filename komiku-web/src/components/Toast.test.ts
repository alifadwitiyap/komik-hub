import { describe, it, expect } from 'vitest'
import {
  TOAST_AUTO_DISMISS_MS,
  TOAST_EXIT_MS,
  initialToastState,
  reduceToast,
  getToastSnapshot,
  showToast,
  showToastWithAction,
} from './Toast'
import toastSrc from './Toast.tsx?raw'

describe('toast store — satu pesan, replace, auto-dismiss', () => {
  it('show menggantikan pesan lama dan menaikkan id', () => {
    const a = reduceToast(initialToastState, { type: 'show', message: 'Pertama' })
    const b = reduceToast(a, { type: 'show', message: 'Kedua' })
    expect(b.message).toBe('Kedua')
    expect(b.id).toBe(a.id + 1)
    expect(b.phase).toBe('in')
  })

  it('dismiss masuk phase out lalu clear mengosongkan pesan', () => {
    const shown = reduceToast(initialToastState, { type: 'show', message: 'Halo' })
    const out = reduceToast(shown, { type: 'dismiss' })
    expect(out.phase).toBe('out')
    expect(out.message).toBe('Halo')
    const cleared = reduceToast(out, { type: 'clear' })
    expect(cleared.message).toBeNull()
    expect(cleared.phase).toBe('in')
  })

  it('dismiss dua kali tidak mengubah state (timer race aman)', () => {
    const shown = reduceToast(initialToastState, { type: 'show', message: 'Halo' })
    const out = reduceToast(shown, { type: 'dismiss' })
    expect(reduceToast(out, { type: 'dismiss' })).toBe(out)
  })

  it('durasi: masuk 2.5 detik, keluar 120ms (exit < enter)', () => {
    expect(TOAST_AUTO_DISMISS_MS).toBe(2500)
    expect(TOAST_EXIT_MS).toBe(120)
    expect(TOAST_EXIT_MS).toBeLessThan(150)
  })

  it('showToast lama tetap tanpa aksi; showToastWithAction membawa aksi', () => {
    showToast('Tanpa aksi')
    expect(getToastSnapshot().action).toBeUndefined()
    let clicked = 0
    showToastWithAction('Melanjutkan dari Hal. 5', 'Ke awal', () => {
      clicked += 1
    })
    const { action, message } = getToastSnapshot()
    expect(message).toBe('Melanjutkan dari Hal. 5')
    expect(action?.label).toBe('Ke awal')
    action?.onClick()
    expect(clicked).toBe(1)
  })

  it('toast di atas bottom bar dan tombol aksi memenuhi Target 44px', () => {
    expect(toastSrc).toContain('bottom-[calc(11rem+env(safe-area-inset-bottom))]')
    expect(toastSrc).toContain('aria-live="polite"')
    expect(toastSrc).toContain('data-reader-toast-action')
    expect(toastSrc).toContain('min-h-11')
    expect(toastSrc).not.toContain('bg-black/60')
  })
})
