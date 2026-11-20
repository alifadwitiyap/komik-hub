import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { LONG_PRESS_MS, LONG_PRESS_SLOP_PX, quickReadAction } from './components/QuickActionSheet'
import { chapterNumberFromKey } from './components/ContinueReading'
import { normalizeRakTab, rakTabQuery } from './rakStore'
import type { ProgressEntry } from './hooks/useProgress'

const src = (p: string) => readFileSync(fileURLToPath(new URL(p, import.meta.url)), 'utf8')

function progress(chapterId = 'komiku:1189.2'): ProgressEntry {
  return {
    seriesId: 42,
    seriesTitle: 'Judul',
    chapterId,
    chapterName: 'Chapter 1189.2',
    page: 3,
    progress: 0.42,
    source: 'komiku',
    handle: 'komiku:42',
    at: 1_700_000_000_000,
  }
}

describe('WS-A quick actions', () => {
  it('nomor chapter dipertahankan apa adanya', () => {
    expect(chapterNumberFromKey('komiku:1189.2')).toBe('1189.2')
    expect(chapterNumberFromKey('Chapter 811 Fix')).toBe('811 Fix')
    expect(chapterNumberFromKey('Ch. 0')).toBe('0')
  })

  it('progres tersimpan menang; tanpa progres mulai dari Ch. 01', () => {
    const manga = { id: 'm1', handle: 'komiku:42' }
    expect(quickReadAction(manga, progress()).label).toBe('Lanjut Ch. 1189.2')
    const fresh = quickReadAction(manga, null)
    expect(fresh.label).toBe('Baca Ch. 01')
    expect(fresh.href).toBe('/baca/komiku:42/01')
  })

  it('long press 350ms dengan slop 10px', () => {
    expect(LONG_PRESS_MS).toBe(350)
    expect(LONG_PRESS_SLOP_PX).toBe(10)
  })

  it('alias tab Rak lama tetap diterima, tanpa query = semua', () => {
    expect(normalizeRakTab(null)).toBe('semua')
    expect(normalizeRakTab('terbaru')).toBe('semua')
    expect(normalizeRakTab('sejarah')).toBe('sedang')
    expect(normalizeRakTab('favorit')).toBe('ingin')
    expect(normalizeRakTab('selesai')).toBe('selesai')
    expect(rakTabQuery('semua')).toEqual({})
    expect(rakTabQuery('sedang')).toEqual({ tab: 'sedang' })
  })

  it('sheet punya kelima label aksi, fokus kembali, Escape, dan Tutup 44px', () => {
    const sheet = src('components/QuickActionSheet.tsx')
    for (const label of ['Lanjut Ch.', 'Baca Ch. 01', 'Simpan ke Rak', 'Hapus dari Rak', 'Buka Detail Komik', 'Salin Tautan', 'Tautan disalin', 'Tutup']) {
      expect(sheet).toContain(label)
    }
    expect(sheet).toContain('Escape')
    expect(sheet).toContain('previous?.focus?.({ preventScroll: true })')
    expect(sheet).toContain('min-h-11')
    expect(sheet).toContain('role="dialog"')
    expect(sheet).toContain('aria-modal="true"')
  })

  it('long press dibatalkan pada gerak/cancel/lepas sebelum threshold', () => {
    const home = src('pages/Home.tsx')
    for (const needle of [
      'LONG_PRESS_MS',
      'LONG_PRESS_SLOP_PX',
      'onPointerDown',
      'onPointerMove',
      'onPointerCancel',
      'onPointerUp',
      'onClickCapture',
      'Math.hypot',
      'navigator.vibrate?.(10)',
      'data-quick-action',
      '⋮',
    ]) {
      expect(home, needle).toContain(needle)
    }
  })

  it('Rak menampilkan lima tab status dan badge hanya dari data nyata', () => {
    const rak = src('pages/Rak.tsx')
    for (const label of ['Semua', 'Sedang Dibaca', 'Ingin Dibaca', 'Selesai', 'Unduhan']) {
      expect(rak).toContain(`'${label}'`)
    }
    expect(rak).toContain('unreadByTitle[entry.title_key] ?? 0')
    expect(rak).toContain('Hanya yang ada update')
    expect(rak).toContain('+{r.updates} Ch.')
    expect(rak).toContain('rows.sort((a, b) => b.at - a.at)')
    expect(rak).toContain('overflow-x-auto')
  })

  it('rail resume menjaga kunci chapter dan tautan sejarah', () => {
    const rail = src('components/ContinueReading.tsx')
    for (const needle of [
      'data-testid="continue-reading-card"',
      'to="/rak?tab=sejarah"',
      'tabular-nums',
      'scaleX(${item.progress})',
      'referrerPolicy="no-referrer"',
      'snap-x snap-proximity',
    ]) {
      expect(rail, needle).toContain(needle)
    }
  })
})
