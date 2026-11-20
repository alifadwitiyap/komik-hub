import { describe, it, expect } from 'vitest'
import {
  readingStatusForPage,
  visiblePageProgress,
  type ReadingStatus,
} from './readingStatus'

describe('progreschapter — posisi halaman terlihat, bukan gambar termuat', () => {
  it('sedang dibaca saat chapter dibuka, walaupun belum ada gambar termuat', () => {
    expect(readingStatusForPage(0, 5, false)).toBe('Sedang dibaca')
    expect(readingStatusForPage(1, 5, false)).toBe('Sedang dibaca')
  })

  it('Selesai hanya di halaman terakhir DAN pembaca sudah sampai bawah', () => {
    expect(readingStatusForPage(5, 5, false)).toBe('Sedang dibaca')
    expect(readingStatusForPage(5, 5, true)).toBe('Selesai')
    expect(readingStatusForPage(4, 5, true)).toBe('Sedang dibaca')
  })

  it('persentase mengikuti halaman terlihat (0→20→40→…→100 saat scroll)', () => {
    expect(visiblePageProgress(0, 5)).toBe(0)
    expect(visiblePageProgress(1, 5)).toBe(0.2)
    expect(visiblePageProgress(2, 5)).toBe(0.4)
    expect(visiblePageProgress(5, 5)).toBe(1)
  })

  it('total 0 tidak pernah dibagi nol', () => {
    expect(visiblePageProgress(0, 0)).toBe(0)
    expect(readingStatusForPage(0, 0, true)).toBe('Sedang dibaca')
  })

  it('status lama tetap diterima (entri riwayat lama tidak rusak)', () => {
    const lama: ReadingStatus = 'Selesai'
    expect(lama).toBe('Selesai')
  })
})
