import { describe, expect, it } from 'vitest'
import { nextFillFrontier } from './fillAhead'

/**
 * Regresi P1 — "chapter terus merender otomatis sampai selesai".
 *
 * Sebelum perbaikan, frontier fill-ahead dihitung dari `window.scrollY`:
 * rantai setTimeout(250ms) tetap berdenyut, tapi selama pembaca TIDAK
 * menggulir `p = 0` sehingga target frontier mandek di `lead` (10 halaman).
 * Akibatnya setelah burst awal, sisa chapter tidak pernah di-mount.
 *
 * Kontrak yang diuji: frontier harus naik MONOTON seiring jumlah tick,
 * terlepas dari posisi scroll; scroll tetap boleh mempercepat (loncat jauh),
 * tapi tidak boleh menjadi satu-satunya pemicu.
 */
describe('nextFillFrontier', () => {
  const n = 56 // One Piece ch.1 (komiku:6167) punya 56 halaman

  it('tanpa scroll pun frontier naik terus sampai halaman terakhir', () => {
    let frontier = 0
    const trace: number[] = []
    for (let ticks = 1; ticks <= 30; ticks++) {
      frontier = nextFillFrontier({
        prev: frontier,
        ticks,
        pageCount: n,
        slow: false,
        scrollProgress: 0, // sengaja: pembaca diam, tidak menggulir
      })
      trace.push(frontier)
    }
    expect(trace[0]).toBeGreaterThan(0)
    // HARUS bertumbuh walau scrollY tidak berubah.
    expect(trace[9]).toBeGreaterThan(trace[0])
    expect(trace[trace.length - 1]).toBe(n - 1)
  })

  it('tidak pernah turun dan selalu dibatasi pageCount - 1', () => {
    let frontier = 0
    for (let ticks = 1; ticks <= 80; ticks++) {
      const next = nextFillFrontier({
        prev: frontier,
        ticks,
        pageCount: n,
        slow: false,
        scrollProgress: ticks % 2 ? 0 : 0.5,
      })
      expect(next).toBeGreaterThanOrEqual(frontier)
      expect(next).toBeLessThanOrEqual(n - 1)
      frontier = next
    }
  })

  it('mode lambat/hemat tetap progres (lebih pelan), bukan mandek', () => {
    let frontier = 0
    for (let ticks = 1; ticks <= 60; ticks++) {
      frontier = nextFillFrontier({
        prev: frontier,
        ticks,
        pageCount: n,
        slow: true,
        scrollProgress: 0,
      })
    }
    expect(frontier).toBe(n - 1)
  })

  it('loncatan scroll tetap mempercepat frontier (tidak ada regresi)', () => {
    const jump = nextFillFrontier({
      prev: 0,
      ticks: 1,
      pageCount: n,
      slow: false,
      scrollProgress: 0.7,
    })
    expect(jump).toBeGreaterThanOrEqual(Math.floor(0.7 * n) + 10)
  })

  it('chapter kosong / 1 halaman aman', () => {
    expect(nextFillFrontier({ prev: 0, ticks: 5, pageCount: 0, slow: false })).toBe(0)
    expect(nextFillFrontier({ prev: 0, ticks: 5, pageCount: 1, slow: false })).toBe(0)
  })
})
