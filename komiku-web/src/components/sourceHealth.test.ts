import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import type { SourceHealthRow } from '../types'
import {
  deadRowText,
  healthDescription,
  latencyLabel,
  latencyScale,
  latencyTier,
  panelSummary,
  relativeChecked,
  summarizeHealthError,
} from './sourceHealth'

const src = (p: string) => readFileSync(fileURLToPath(new URL(p, import.meta.url)), 'utf8')
const row = (ok: boolean, latency_ms?: number | null): SourceHealthRow => ({
  source: 'komiku',
  ok,
  latency_ms,
})

const NOW = 1_800_000_000_000

describe('sourceHealth — display helpers murni', () => {
  it('latencyTier: mati menang, lalu 500/1500ms boundary', () => {
    expect(latencyTier(row(false, 10))).toBe('dead')
    expect(latencyTier(row(true, 184))).toBe('ok')
    expect(latencyTier(row(true, 499.9))).toBe('ok')
    expect(latencyTier(row(true, 500))).toBe('warn')
    expect(latencyTier(row(true, 1500))).toBe('warn')
    expect(latencyTier(row(true, 1500.1))).toBe('danger')
    expect(latencyTier(row(true, null))).toBe('ok')
  })

  it('latencyLabel: "Mati" atau ms terbulatkan', () => {
    expect(latencyLabel(row(false, 42))).toBe('Mati')
    expect(latencyLabel(row(true, 184.6))).toBe('185 ms')
    expect(latencyLabel(row(true, null))).toBe('0 ms')
  })

  it('latencyScale: clamp 0..2000ms ke 0..1', () => {
    expect(latencyScale(null)).toBe(0)
    expect(latencyScale(undefined)).toBe(0)
    expect(latencyScale(-50)).toBe(0)
    expect(latencyScale(Number.NaN)).toBe(0)
    expect(latencyScale(500)).toBe(0.25)
    expect(latencyScale(1000)).toBe(0.5)
    expect(latencyScale(2000)).toBe(1)
    expect(latencyScale(9000)).toBe(1)
  })

  it('relativeChecked: baru saja / detik / menit / jam', () => {
    expect(relativeChecked(null, NOW)).toBe('Baru saja')
    expect(relativeChecked(NOW - 999, NOW)).toBe('Baru saja')
    expect(relativeChecked(NOW + 5000, NOW)).toBe('Baru saja')
    expect(relativeChecked(NOW - 18_000, NOW)).toBe('18 detik lalu')
    expect(relativeChecked(NOW - 59_000, NOW)).toBe('59 detik lalu')
    expect(relativeChecked(NOW - 150_000, NOW)).toBe('2 menit lalu')
    expect(relativeChecked(NOW - 3_600_000, NOW)).toBe('1 jam lalu')
  })

  it('panelSummary: ringkas dengan gangguan, netral tanpa data', () => {
    expect(panelSummary(4, 4)).toBe('4/4 sehat')
    expect(panelSummary(3, 4)).toBe('3/4 sehat · 1 gangguan')
    expect(panelSummary(2, 4)).toBe('2/4 sehat · 2 gangguan')
    expect(panelSummary(0, 0)).toBe('Kesehatan sumber belum diketahui')
  })

  it('summarizeHealthError: satu baris, tanpa URL/jargon berulang', () => {
    const raw = 'DoH-pin gagal: network error https://komikindo.ch/daftar-manga/: error sending request for url (https://komikindo.ch/daftar-manga/); fallback gagal: network error https://komikindo.ch/daftar-manga/: error sending request for url (https://komikindo.ch/daftar-manga/)'
    expect(summarizeHealthError(raw)).toBe('DoH-pin gagal: network error')
    expect(summarizeHealthError('timeout 8s')).toBe('timeout 8s')
    expect(summarizeHealthError(null)).toBe('')
    expect(deadRowText({ source: 'komikindo', ok: false, error: raw }))
      .toBe('Komikindo — DoH-pin gagal: network error')
    expect(healthDescription(4, 5, [{ source: 'komikindo', ok: false, error: raw }]))
      .toBe('4/5 sumber sehat — sumber mati: Komikindo — DoH-pin gagal: network error')
  })
})

describe('useSourceHealth — kontrak probing tanpa React test utils', () => {
  it('probing hanya nyala untuk force dan dipadamkan controller aktif di finally', () => {
    const hook = src('../hooks/useSourceHealth.ts')
    expect(hook).toContain('probing: boolean')
    expect(hook).toContain('probing: false')
    expect(hook).toContain('if (force && mounted.current && inFlight.current === ctrl')
    expect(hook).toContain('unifiedApi.health(ctrl.signal, force)')
    expect(hook).toContain('} finally {')
    expect(hook).toContain('if (mounted.current && inFlight.current === ctrl)')
  })
})
