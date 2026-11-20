import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type * as CJ from './ChapterJumpSearch'

let cj: typeof CJ

function memStorage(): Storage {
  const m = new Map<string, string>()
  return {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, v),
    removeItem: (k: string) => void m.delete(k),
    clear: () => m.clear(),
    key: (i: number) => [...m.keys()][i] ?? null,
    get length() {
      return m.size
    },
  } as Storage
}

beforeEach(async () => {
  vi.resetModules()
  vi.stubGlobal('localStorage', memStorage())
  vi.stubGlobal('sessionStorage', memStorage())
  cj = await import('./ChapterJumpSearch')
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('ChapterJumpSearch — nomor desimal mentah', () => {
  it('00.1 tidak dinormalisasi jadi 0 / 0.1 / 1', () => {
    expect(cj.chapterNumberRaw({ number: '00.1' } as never)).toBe('00.1')
    expect(cj.matchChapterNumber('00.1', '00.1')).toBe(true)
    expect(cj.matchChapterNumber('0', '00.1')).toBe(false)
    expect(cj.matchChapterNumber('0.1', '00.1')).toBe(false)
    expect(cj.matchChapterNumber('1', '00.1')).toBe(false)
    // Sebaliknya: query pendek '0' memang cocok substring '00.1' — itu
    // pencarian sebagian yang disengaja, BUKAN normalisasi numerik.
    expect(cj.matchChapterNumber('00.1', '0')).toBe(true)
  })

  it('query sebagian dari nomor tetap cocok tanpa parse angka', () => {
    expect(cj.matchChapterNumber('190', '19')).toBe(true)
    expect(cj.matchChapterNumber('00.1', '00.')).toBe(true)
    expect(cj.matchChapterNumber('Chapter 12', '12')).toBe(true)
  })

  it('href reader memakai nomor string apa adanya', () => {
    const rows = cj.toChapterRows([
      { handle: 'komiku:12345', number: '00.1', title: 'Chapter 00.1', native_id: 'x', source: 'komiku', updated_at: null },
    ] as never[])
    expect(rows[0]?.href).toBe('/baca/komiku:12345/00.1')
    expect(rows[0]?.number).toBe('00.1')
  })

  it('urutan lama/terbaru memakai angka tapi tie-break string', () => {
    const rows = [
      { number: '180' },
      { number: '00.1' },
      { number: '190' },
    ]
    expect(cj.sortChapterRows(rows, 'lama').map((r) => r.number)).toEqual(['00.1', '180', '190'])
    expect(cj.sortChapterRows(rows, 'terbaru').map((r) => r.number)).toEqual(['190', '180', '00.1'])
  })

  it('nomor kosong / non-angka tidak menghilangkan baris', () => {
    const rows = cj.toChapterRows([
      { id: 7, name: 'Chapter 12', number: null },
      { handle: 'mangaku:9', number: 'extra-1', title: 'Extra', native_id: 'e', source: 'mangaku', updated_at: null },
    ] as never[])
    expect(rows).toHaveLength(2)
    expect(cj.matchChapterNumber(rows[0]!.number, '')).toBe(true)
  })
})
