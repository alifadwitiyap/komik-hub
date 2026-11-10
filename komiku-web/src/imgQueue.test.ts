import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  acquireImageSlot,
  recordImageSettle,
  resetImageQueue,
} from './imgQueue'

beforeEach(() => {
  resetImageQueue()
  vi.stubGlobal('navigator', { connection: undefined })
})

afterEach(() => {
  vi.unstubAllGlobals()
  resetImageQueue()
})

function collect() {
  const calls: number[] = []
  return {
    calls,
    acquire: (p: 0 | 1) => acquireImageSlot(p, () => void calls.push(calls.length)),
  }
}

describe('imgQueue', () => {
  it('eager (priority 0) langsung dapat slot', () => {
    const c = collect()
    const rel = c.acquire(0)
    expect(c.calls).toHaveLength(1)
    rel()
    rel() // idempotent
  })

  it('eager memblokir permintaan lain sampai dilepas', () => {
    const c = collect()
    const relEager = c.acquire(0)
    const relA = c.acquire(1)
    const relB = c.acquire(1)
    expect(c.calls).toHaveLength(1) // hanya eager
    relEager()
    expect(c.calls).toHaveLength(3) // pump membebaskan keduanya (cap 2)
    relA()
    relB()
  })

  it('cap normal = 2; antrean ketiga menunggu', () => {
    const c = collect()
    const relA = c.acquire(1)
    const relB = c.acquire(1)
    const relC = c.acquire(1)
    expect(c.calls).toHaveLength(2)
    relA()
    expect(c.calls).toHaveLength(3)
    expect(relC).toBeTypeOf('function')
    relB()
  })

  it('release sebelum granted menghapus dari antrean', () => {
    const c = collect()
    const relA = c.acquire(1)
    const relB = c.acquire(1)
    const relC = c.acquire(1)
    relC() // belum dapat slot → dibatalkan
    relA()
    expect(c.calls).toHaveLength(2) // C tidak pernah dijalankan
    relB()
  })

  it('recordImageSettle lambat (>2500) menyempit ke cap 1', () => {
    recordImageSettle(3000)
    const c = collect()
    const relA = c.acquire(1)
    const relB = c.acquire(1)
    expect(c.calls).toHaveLength(1) // cap slow = 1
    relA()
    expect(c.calls).toHaveLength(2)
    relB()
  })

  it('recordImageSettle cepat tidak menurunkan cap', () => {
    recordImageSettle(500)
    const c = collect()
    const relA = c.acquire(1)
    const relB = c.acquire(1)
    expect(c.calls).toHaveLength(2)
    relA()
    relB()
  })
})
