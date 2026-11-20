/** Logika dismiss murni — tanpa DOM, jalan di vitest env node. */
import { describe, it, expect } from 'vitest'
import { decideDismiss } from './hooks/useSheetDrag'
import { SHEET_DISMISS_DISTANCE_PX, SHEET_DISMISS_VELOCITY_PX_S } from './lib/motion'

const FLICK = SHEET_DISMISS_VELOCITY_PX_S / 1000 // 0.5 px/ms = 500 px/s

describe('useSheetDrag.decideDismiss', () => {
  it('flick ke bawah > 500 px/s menutup walau jaraknya pendek', () => {
    expect(decideDismiss(12, FLICK + 0.01)).toBe(true)
  })

  it('tarik pelan menutup hanya setelah > 100px', () => {
    expect(decideDismiss(SHEET_DISMISS_DISTANCE_PX - 1, 0)).toBe(false)
    expect(decideDismiss(SHEET_DISMISS_DISTANCE_PX + 1, 0)).toBe(true)
  })

  it('diam atau geser naik tidak menutup', () => {
    expect(decideDismiss(20, 0)).toBe(false)
    expect(decideDismiss(40, -FLICK * 2)).toBe(false)
  })

  it('ambang bersifat strict (sama persis dengan ambang = tidak dismiss)', () => {
    expect(decideDismiss(SHEET_DISMISS_DISTANCE_PX, FLICK)).toBe(false)
  })
})
