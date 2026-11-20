/**
 * Motion token aliases (plan D2) + reduced-motion zero-duration guard.
 * Node env: CSS contracts read from disk, JS tokens imported directly.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import {
  EMIL_EASE,
  SNAPPY_EASE,
  tabPillSpring,
  popoverVariants,
  sheetSpring,
  popoverMotion,
} from './lib/motion'

const motionCss = readFileSync(
  fileURLToPath(new URL('./styles/motion.css', import.meta.url)),
  'utf8',
)
const indexCss = readFileSync(
  fileURLToPath(new URL('./index.css', import.meta.url)),
  'utf8',
)

describe('plan D2 JS aliases', () => {
  it('EMIL_EASE / SNAPPY_EASE mirror the existing easing curves', () => {
    expect(EMIL_EASE).toEqual([0.22, 1, 0.36, 1])
    expect(SNAPPY_EASE).toEqual([0.16, 1, 0.3, 1])
  })

  it('tabPillSpring is critically damped (500/40/1)', () => {
    expect(tabPillSpring).toEqual({ type: 'spring', stiffness: 500, damping: 40, mass: 1 })
  })

  it('popoverVariants scales 0.96→1, 160ms in / 120ms out', () => {
    expect(popoverVariants.initial).toEqual({ opacity: 0, scale: 0.96 })
    expect(popoverVariants.animate.scale).toBe(1)
    expect(popoverVariants.animate.transition.duration).toBe(0.16)
    expect(popoverVariants.exit.scale).toBe(0.96)
    expect(popoverVariants.exit.transition.duration).toBe(0.12)
  })

  it('existing locked values are unchanged', () => {
    expect(sheetSpring).toEqual({ type: 'spring', stiffness: 420, damping: 36, mass: 0.8 })
    expect(popoverMotion.animate.transition.duration).toBe(0.16)
    expect(popoverMotion.exit.transition.duration).toBe(0.16)
  })
})

describe('plan D2 CSS aliases & tap-target', () => {
  const aliases: Record<string, string> = {
    '--bg-canvas': '#0E1014',
    '--bg-reader': '#090B0E',
    '--bg-surface': '#161920',
    '--bg-surface-elevated': '#1E232D',
    '--border-subtle': 'rgba(255, 255, 255, 0.08)',
    '--ink-primary': '#F4F6FA',
    '--ink-secondary': '#A8B1C2',
    '--accent-primary': '#3B82F6',
    '--dur-popover': '160ms',
  }

  it('defines all surface/duration aliases for :root and .dark', () => {
    expect(motionCss).toMatch(/:root,\s*\.dark\s*\{/)
    for (const [name, value] of Object.entries(aliases)) {
      expect(motionCss, name).toContain(`${name}: ${value};`)
    }
  })

  it('tap-target is an opt-in 44px helper, not a global selector', () => {
    expect(motionCss).toMatch(
      /\.tap-target\s*\{[^}]*min-width:\s*44px[^}]*min-height:\s*44px[^}]*touch-action:\s*manipulation[^}]*-webkit-tap-highlight-color:\s*transparent/,
    )
    expect(motionCss).toMatch(/\.tap-target:active\s*\{\s*transform:\s*scale\(0\.97\)/)
  })
})

describe('reduced motion still zeroes durations', () => {
  it('index.css keeps 0ms !important motion kill-switch', () => {
    expect(indexCss).toContain('@media (prefers-reduced-motion: reduce)')
    expect(indexCss).toMatch(/transition-property:\s*none !important/)
    expect(indexCss).toMatch(/transition-duration:\s*0ms !important/)
    expect(indexCss).toMatch(/scroll-behavior:\s*auto !important/)
  })

  it('motion.css keeps 0.01ms !important fallback', () => {
    expect(motionCss).toMatch(/animation-duration:\s*0\.01ms !important/)
    expect(motionCss).toMatch(/transition-duration:\s*0\.01ms !important/)
  })
})
