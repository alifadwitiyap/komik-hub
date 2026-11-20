import { describe, expect, it } from 'vitest'
import {
  canGoBack,
  filterChapterIndices,
  resolveBackTarget,
} from './ChapterJumpSearch'
import type { Chapter } from '../types'

const chapters: Chapter[] = [
  { name: 'Chapter 1189.2', id: 1, number: '1189.2' },
  { name: 'Chapter 811 Fix', id: 2, number: '811 Fix' },
  { name: 'Chapter 7', id: 3, number: '7' },
]

describe('filterChapterIndices — satu daftar, index asli dipertahankan', () => {
  it('query kosong mengembalikan semua chapter dengan index asli', () => {
    expect(filterChapterIndices(chapters, '')).toEqual([
      { chapter: chapters[0], index: 0 },
      { chapter: chapters[1], index: 1 },
      { chapter: chapters[2], index: 2 },
    ])
  })

  it('nomor desain mentah 1189.2 tidak dinormalisasi', () => {
    const rows = filterChapterIndices(chapters, '1189.2')
    expect(rows).toEqual([{ chapter: chapters[0], index: 0 }])
    expect(rows[0].chapter.number).toBe('1189.2')
  })

  it('label "811 Fix" dicocokkan apa adanya (case-insensitive)', () => {
    expect(filterChapterIndices(chapters, '811 Fix')).toEqual([
      { chapter: chapters[1], index: 1 },
    ])
    expect(filterChapterIndices(chapters, 'fix')).toEqual([
      { chapter: chapters[1], index: 1 },
    ])
  })

  it('index asli tetap benar saat chapter awal tersembunyi', () => {
    expect(filterChapterIndices(chapters, '7')).toEqual([
      { chapter: chapters[2], index: 2 },
    ])
  })

  it('tidak ada yang cocok → daftar kosong', () => {
    expect(filterChapterIndices(chapters, '999')).toEqual([])
  })
})

describe('tombol Kembali — state.from / history / fallback', () => {
  it('canGoBack hanya benar untuk history idx > 0', () => {
    expect(canGoBack({ idx: 0 })).toBe(false)
    expect(canGoBack({ idx: 1 })).toBe(true)
    expect(canGoBack(null)).toBe(false)
    expect(canGoBack({})).toBe(false)
  })

  it('state.from lokal diprioritaskan', () => {
    expect(resolveBackTarget('/katalog?hal=2', true)).toEqual({
      back: false,
      to: '/katalog?hal=2',
    })
  })

  it('from eksternal (//) ditolak dan jatuh ke history', () => {
    expect(resolveBackTarget('//evil.example', true)).toEqual({ back: true })
    expect(resolveBackTarget(undefined, true)).toEqual({ back: true })
  })

  it('tanpa history dan tanpa from → Beranda', () => {
    expect(resolveBackTarget(undefined, false)).toEqual({ back: false, to: '/' })
    expect(resolveBackTarget(123, false)).toEqual({ back: false, to: '/' })
  })
})
