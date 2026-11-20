import { describe, it, expect } from 'vitest'
import { compareChapterNumber, sortByChapterNumber } from './chapterOrder'

const NUMBERS = ['811 Fix', '812', '2', '1189.2', '01', '1189', '1190', '811', 'extra']

describe('chapter order — satu aturan untuk nomor apa pun', () => {
  it('kunci asli tidak pernah diubah', () => {
    const sorted = sortByChapterNumber(NUMBERS, (s) => s)
    expect(new Set(sorted)).toEqual(new Set(NUMBERS))
    expect(sorted).toContain('01')
    expect(sorted).toContain('1189.2')
    expect(sorted).toContain('811 Fix')
  })

  it('chapter 01 menjadi yang terlama (bukan 811 Fix)', () => {
    const sorted = sortByChapterNumber(NUMBERS, (s) => s)
    expect(sorted[0]).toBe('01')
    expect(sortByChapterNumber(NUMBERS, (s) => s, 'terbaru')[0]).toBe('1190')
  })

  it('edisi revisi melekat pada induknya', () => {
    const sorted = sortByChapterNumber(NUMBERS, (s) => s)
    expect(sorted.indexOf('811 Fix')).toBe(sorted.indexOf('811') + 1)
    expect(sorted.indexOf('1189.2')).toBeGreaterThan(sorted.indexOf('1189'))
    expect(sorted.indexOf('1189.2')).toBeLessThan(sorted.indexOf('1190'))
  })

  it('nomor tanpa angka di urutan terakhir untuk "lama"', () => {
    expect(compareChapterNumber('extra', '1190')).toBeGreaterThan(0)
    expect(sortByChapterNumber(NUMBERS, (s) => s).at(-1)).toBe('extra')
  })

  it('aturan yang sama dipakai untuk baris/objek', () => {
    const rows = NUMBERS.map((number) => ({ number, id: number }))
    const sorted = sortByChapterNumber(rows, (r) => r.number)
    expect(sorted.map((r) => r.id)).toEqual(sortByChapterNumber(NUMBERS, (s) => s))
  })
})
