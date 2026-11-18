import { describe, it, expect } from 'vitest'
import {
  resolveResumeTarget,
  canRestorePage,
  isLegacyProgress,
} from './progressResume'
import { mergeProgress, type ProgressEntry } from './hooks/useProgress'
import { toChapterId, readerHref, marathonHref } from './readerSource'

const SERIES = 'komiku:1284'
const CH = `${SERIES}:00.1` // Chapter 00.1 — BUKAN 0
const IMG = (n: number) => `https://cdn.example/solo/${n}.webp`

function marathonEntry(overrides: Partial<ProgressEntry> = {}): ProgressEntry {
  return {
    seriesId: SERIES,
    seriesTitle: 'Solo Leveling',
    chapterId: CH,
    chapterName: 'Chapter 00.1',
    page: 2, // 0-based → halaman 3/52
    progress: 3 / 52,
    pageId: IMG(3),
    offsetRatio: 0.4,
    source: 'komiku',
    handle: CH,
    mode: 'marathon',
    at: 1_800_000_000_000,
    ...overrides,
  }
}

function marathonPos() {
  return {
    chapterKey: CH,
    seriesKey: SERIES,
    activeKey: CH,
    pageId: IMG(3),
    offsetRatio: 0.4,
    blocks: 3,
    chapterIdx: 2,
    at: 1_800_000_000_000,
  }
}

describe('progressResume — Solo Leveling', () => {
  it('toChapterId menjaga "0" dan "00.1" tetap berbeda', () => {
    expect(toChapterId('0')).toBe('0')
    expect(toChapterId('00.1')).toBe('00.1')
    expect(toChapterId(0)).toBe('0')
    expect(toChapterId(0.1)).toBe('0.1')
    expect(toChapterId('  00.1  ')).toBe('00.1')
    expect(toChapterId(null)).toBe('')
    expect(marathonHref('komiku:1284:00.1')).toBe('/maraton/komiku:1284/00.1')
    expect(readerHref('komiku:1284:0')).toBe('/baca/komiku:1284/0')
  })

  it('tiga entry point (maraton, rak reader, detail Ch 0) → target SAMA', () => {
    const entry = marathonEntry()
    const maraton = resolveResumeTarget(entry, marathonPos(), (k) => k.startsWith(`${SERIES}:`))
    const rak = resolveResumeTarget(entry, null, (k) => k.startsWith(`${SERIES}:`))
    const detail = resolveResumeTarget(entry, marathonPos(), (k) => k === `${SERIES}:0` ? true : k.startsWith(`${SERIES}:`))

    expect(maraton).not.toBeNull()
    expect(rak).not.toBeNull()
    expect(detail).not.toBeNull()
    for (const t of [rak, detail]) {
      expect(t!.chapterId).toBe(maraton!.chapterId)
      expect(t!.mode).toBe(maraton!.mode)
      expect(t!.page).toBe(maraton!.page)
      expect(t!.pageId).toBe(maraton!.pageId)
      expect(t!.offsetRatio).toBe(maraton!.offsetRatio)
      expect(t!.href).toBe(maraton!.href)
    }
    expect(maraton!.chapterId).toBe(CH)
    expect(maraton!.mode).toBe('marathon')
    expect(maraton!.page).toBe(2) // halaman 3
    expect(maraton!.pageId).toBe(IMG(3))
    expect(maraton!.offsetRatio).toBeCloseTo(0.4)
    expect(maraton!.href).toBe('/maraton/komiku:1284/00.1')
    expect(canRestorePage(maraton, { chapterId: CH, source: 'komiku' }, [IMG(3)])).toBe(true)
  })

  it('rak reader biasa halaman 8–9 ikut tersimpan saat mode normal', () => {
    const entry = marathonEntry({ mode: 'normal', page: 8, pageId: IMG(9), progress: 9 / 52 })
    const t = resolveResumeTarget(entry, null, (k) => k.startsWith(`${SERIES}:`))
    expect(t!.mode).toBe('normal')
    expect(t!.page).toBe(8)
    expect(t!.href).toBe('/baca/komiku:1284/00.1')
  })

  it('detail menawarkan Chapter 0 TIDAK mengubah identitas 00.1', () => {
    const entry = marathonEntry()
    const t = resolveResumeTarget(entry, marathonPos(), (k) => k === `${SERIES}:0`)
    expect(t).toBeNull() // penawaran detail Ch 0 harus ditolak validator
  })

  it('data lama (nomor chapter saja) → awal chapter', () => {
    const legacy = marathonEntry({
      page: 27,
      progress: 0,
      pageId: undefined,
      offsetRatio: undefined,
      mode: undefined,
    })
    expect(isLegacyProgress(legacy)).toBe(true)
    const t = resolveResumeTarget(legacy, null)
    expect(t!.page).toBe(0)
    expect(t!.pageId).toBeNull()
    expect(t!.hasExactPage).toBe(false)
  })

  it('pindah sumber → page 0 + sourceChanged (tanpa pemetaan halaman)', () => {
    const entry = marathonEntry()
    const t = resolveResumeTarget(entry, marathonPos(), undefined, { chapterId: CH, source: 'lain' })
    expect(t!.sourceChanged).toBe(true)
    expect(t!.page).toBe(0)
    // Pemetaan tersedia: pageId sama persis di sumber baru → boleh restore.
    expect(canRestorePage(t, { chapterId: CH, source: 'lain' }, [IMG(3)])).toBe(true)
    // Tanpa pemetaan → false, pemanggil buka page 0 + jelaskan sourceChanged.
    expect(canRestorePage(t, { chapterId: CH, source: 'lain' }, [IMG(99)])).toBe(false)
  })

  it('sumber sama & halaman ada → canRestorePage true', () => {
    const t = resolveResumeTarget(marathonEntry(), marathonPos(), undefined, { chapterId: CH, source: 'komiku' })
    expect(t!.sourceChanged).toBe(false)
    expect(canRestorePage(t, { chapterId: CH, source: 'komiku' }, [IMG(1), IMG(3)])).toBe(true)
  })
})

describe('mergeProgress — spec §5 at terbaru menang', () => {
  const older = marathonEntry({ page: 2, at: 1_000 })
  const newer = marathonEntry({ page: 8, at: 2_000 })

  it('pull server lebih lama tidak menimpa lokal lebih baru', () => {
    const merged = mergeProgress([newer], [older])
    expect(merged).toHaveLength(1)
    expect(merged[0].page).toBe(8)
    expect(merged[0].at).toBe(2_000)
  })

  it('lokal lebih lama kalah dengan server lebih baru', () => {
    const merged = mergeProgress([older], [newer])
    expect(merged[0].page).toBe(8)
  })

  it('satu entri per series, chapter lama dinormalisasi ke string', () => {
    const legacy = { ...newer, chapterId: 0 as unknown as string, at: 3_000 }
    const merged = mergeProgress([legacy], [newer])
    expect(merged).toHaveLength(1)
    expect(merged[0].chapterId).toBe('0')
  })
})
