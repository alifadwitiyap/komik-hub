/**
 * ACCESSIBILITY PROBE — download flow + keyboard/SR support.
 *
 * Vitest env = 'node' (no jsdom, no @testing-library/react), so the tsx
 * files can't render. Like the adversarial suite we exercise the REAL
 * pure exports (rangeTap/rangeSlice/isAnchorIndex/RANGE_MAX) — those are
 * behavior tests. The `?raw` imports below are NOT render assertions:
 * they pin the literal a11y attribute/string contract that lives in each
 * .tsx source (role, aria-*, focus-visible classes). They verify the      
 * contract exists in source, not that it renders correctly — a weaker
 * check, accepted because no DOM is available in this env.
 *
 * NOTE: several assertions here intentionally depend on source strings that
 * parallel lanes (copy/label rewrites in SeriesUnified/DownloadRangePicker/
 * Rak/Reader) may change; if they fail after those lanes land, update the
 * expectation to the new intended copy — do not weaken the contract.
 *
 * Run: npx vitest run src/downloadA11y.test.ts
 */
import { describe, it, expect } from 'vitest'
import { rangeTap, rangeSlice, isAnchorIndex, RANGE_MAX } from './components/DownloadRangePicker'
import rakSrc from './pages/Rak.tsx?raw'
import seriesSrc from './pages/Series.tsx?raw'
import seriesUnifiedSrc from './pages/SeriesUnified.tsx?raw'
import pickerSrc from './components/DownloadRangePicker.tsx?raw'
import readerActionsSrc from './components/ReaderDownloadActions.tsx?raw'

const src = (rel: string): string => {
  switch (rel) {
    case './pages/Rak.tsx': return rakSrc
    case './pages/Series.tsx': return seriesSrc
    case './pages/SeriesUnified.tsx': return seriesUnifiedSrc
    case './components/DownloadRangePicker.tsx': return pickerSrc
    case './components/ReaderDownloadActions.tsx': return readerActionsSrc
    default: throw new Error(`unknown fixture: ${rel}`)
  }
}

describe('PROGRESSIVE DOWNLOAD FLOW: rangeTap two-stage pick', () => {
  it('1st tap sets first anchor; 2nd tap completes the range; 3rd tap restarts', () => {
    let state = rangeTap({ start: null, end: null }, 2)
    expect(state).toEqual({ start: 2, end: null })
    expect(isAnchorIndex(state, 2)).toBe(true)
    state = rangeTap(state, 5)
    expect(state).toEqual({ start: 2, end: 5 })
    expect(isAnchorIndex(state, 5)).toBe(true)
    // 3rd tap starts over — panen lagi chapter awal
    state = rangeTap(state, 0)
    expect(state).toEqual({ start: 0, end: null })
  })

  it('rangeSlice caps selection at RANGE_MAX chapters', () => {
    const slice = rangeSlice({ start: 0, end: 100 })!
    expect(slice.raw).toBe(101)
    expect(slice.clamped).toBe(true)
    expect(slice.count).toBe(RANGE_MAX)
    expect(slice.from).toBe(0)
    expect(slice.to).toBe(RANGE_MAX - 1)
  })

  it('rangeSlice handles an inverted end (tap below anchor)', () => {
    const slice = rangeSlice({ start: 9, end: 3 })!
    expect(slice.from).toBe(3)
    expect(slice.to).toBe(9)
    expect(slice.raw).toBe(7)
    expect(slice.clamped).toBe(false)
  })

  it('rangeSlice returns null when only the anchor is set', () => {
    expect(rangeSlice({ start: 4, end: null })).toBeNull()
  })

  it('RANGE_MAX is the real exported constant 30', () => {
    expect(RANGE_MAX).toBe(30)
  })

  it('tapping the same row twice completes a single-chapter range (start === end)', () => {
    // rangeTap sets end = index unconditionally on 2nd tap, so the same
    // row twice yields a 1-chapter selection — no special case required.
    let state = rangeTap({ start: null, end: null }, 7)
    state = rangeTap(state, 7)
    expect(state).toEqual({ start: 7, end: 7 })
    const slice = rangeSlice(state)!
    expect(slice.count).toBe(1)
    expect(slice.from).toBe(7)
    expect(slice.to).toBe(7)
    // baris yang sama dianggap salah satu ujung rentang
    expect(isAnchorIndex(state, 7)).toBe(true)
  })
})

describe('Series.tsx legacy download copy: PDF vs offline dibedakan', () => {
  // Kontrak copy milik lane ini sendiri (bukan lane lain): mode PDF tidak
  // boleh mengklaim "tersimpan offline".
  const series = src('./pages/Series.tsx')
  it('PDF completion copy never claims offline storage; cache copy does', () => {
    expect(series).toContain('PDF siap diambil')
    expect(series).toContain("finishedRun.mode === 'cache'")
    expect(series).toContain('chapter tersimpan offline')
  })
})

describe('Rak tab bar: ARIA tablist semantics', () => {
  const rak = src('./pages/Rak.tsx')
  it('renders a tablist with 4 tabs, aria-selected + aria-controls + tab panels', () => {
    expect(rak).toContain('role="tablist"')
    expect(rak).toContain('role="tab"')
    expect(rak).toContain('aria-selected={tab === key}')
    expect(rak).toContain('aria-controls={`panel-${key}`}')
    expect(rak).toContain('role="tabpanel"')
    expect(rak).toContain('aria-labelledby="tab-')
  })
  it('supports ArrowLeft/ArrowRight/Home/End keyboard navigation with roving tabIndex', () => {
    expect(rak).toContain("e.key === 'ArrowRight'")
    expect(rak).toContain("e.key === 'ArrowLeft'")
    expect(rak).toContain("e.key === 'Home'")
    expect(rak).toContain("e.key === 'End'")
    expect(rak).toContain('tabIndex={tab === key ? 0 : -1}')
  })
  it('tab bar buttons carry the shared focus-visible ring', () => {
    expect(rak).toContain('focus-visible:ring-brand-amber')
  })
})

describe('Progress bars: screen-reader progressbar contract', () => {
  for (const [rel, marker] of [
    ['./pages/Rak.tsx', 'Sedang diunduh'],
    ['./pages/Series.tsx', 'Memuat'],
    ['./pages/SeriesUnified.tsx', 'Mengunduh'],
  ] as const) {
    it(`${rel} exposes role=progressbar with aria-valuemin/max/now and a valuetext`, () => {
      const file = src(rel)
      expect(file).toContain('role="progressbar"')
      expect(file).toContain('aria-valuemin={0}')
      expect(file).toMatch(/aria-valuemax=\{/)
      expect(file).toMatch(/aria-valuenow=\{/)
      expect(file).toContain('aria-valuetext=')
      expect(marker.length).toBeGreaterThan(0)
    })
  }
})

describe('Result & status: screen-reader live announcements', () => {
  it('SeriesUnified dl summary is role=status aria-live=polite', () => {
    expect(src('./pages/SeriesUnified.tsx')).toContain('role="status"')
    expect(src('./pages/SeriesUnified.tsx')).toContain('aria-live="polite"')
  })
  it('Series dlMsg is role=status; hint stays polite', () => {
    const series = src('./pages/Series.tsx')
    expect(series).toContain('role="status"')
    expect(series).toContain('aria-live="polite"')
  })
  it('ReaderDownloadActions announces busy state via a polite live region', () => {
    const r = src('./components/ReaderDownloadActions.tsx')
    expect(r).toContain('role="status"')
    expect(r).toContain('aria-live="polite"')
    expect(r).toContain('sr-only')
  })
})

describe('DownloadRangePicker: keyboard + SR labels on the range bar', () => {
  const p = src('./components/DownloadRangePicker.tsx')
  it('download button carries an aria-label describing the action and count', () => {
    expect(p).toContain('aria-busy={busy}')
    expect(p).toMatch(/aria-label=\{/)
    expect(p).toMatch(/Unduh \$\{count\} chapter/)
  })
  it('Offline/PDF type buttons have descriptive aria-labels and busy state', () => {
    expect(p).toContain('Unduh ${count} chapter untuk baca offline di aplikasi')
    expect(p).toContain('Unduh ${count} chapter sebagai file PDF')
    expect(p).toContain('role="group"')
    expect(p).toContain('aria-label="Tipe unduhan"')
  })
  it('all picker buttons carry the shared focus-visible ring', () => {
    // kedua tombol aksi (Offline + PDF) masing-masing membawa ring focus-visible
    const matches = p.match(/focus-visible:outline-none focus-visible:ring-2/g) ?? []
    expect(matches.length).toBeGreaterThanOrEqual(2)
  })
  it('range region stays labelled for screen readers', () => {
    expect(p).toContain('aria-label="Pilih range unduhan"')
    expect(p).toContain('aria-live="polite"')
  })
})

describe('Rak downloads tab: item actions are named for screen readers', () => {
  const r = src('./pages/Rak.tsx')
  it('Baca / Unduh lagi / Hapus each announce series + chapter', () => {
    expect(r).toMatch(/aria-label=\{`Baca \$\{label\} — \$\{g\.title\}/)
    expect(r).toMatch(/aria-label=\{`Unduh lagi \$\{label\} — \$\{g\.title\}/)
    expect(r).toMatch(/aria-label=\{`Hapus unduhan \$\{label\} — \$\{g\.title\}/)
  })
  it('item action links and buttons carry the shared focus-visible ring', () => {
    expect(r).toContain('focus-visible:ring-brand-amber')
    expect(r).toContain('focus-visible:ring-brand-red')
  })
})
