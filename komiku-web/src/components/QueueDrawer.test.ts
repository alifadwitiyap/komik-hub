import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, it, expect } from 'vitest'
import QueueDrawer from './QueueDrawer'
import queueDrawerSrc from './QueueDrawer.tsx?raw'
import type { QueueItem } from '../readingQueue'

const sampleItems: QueueItem[] = [
  {
    handle: 'komiku:3691',
    titleKey: 'k-3691',
    title: 'Komik Contoh',
    coverUrl: null,
    unreadCount: 2,
    targetChapter: '543',
    isToday: true,
    updatedAt: 1,
  },
]

describe('QueueDrawer — tidak meninggalkan backdrop gelap saat tertutup', () => {
  it('tidak merender overlay maupun backdrop saat open=false', () => {
    const html = renderToStaticMarkup(
      createElement(QueueDrawer, {
        open: false,
        items: [],
        currentIndex: 0,
        onClose: () => {},
        onPick: () => {},
        onExit: () => {},
      }),
    )
    expect(html).toBe('')
    expect(html).not.toContain('bg-black/60')
    expect(html).not.toContain('fixed inset-0')
  })

  it('merender dialog dan backdrop saat open=true', () => {
    const html = renderToStaticMarkup(
      createElement(QueueDrawer, {
        open: true,
        items: sampleItems,
        currentIndex: 0,
        onClose: () => {},
        onPick: () => {},
        onExit: () => {},
      }),
    )
    expect(html).toContain('role="dialog"')
    expect(html).toContain('aria-label="Daftar antrean baca"')
    expect(html).toContain('bg-black/60')
    expect(html).toContain('Komik Contoh')
  })

  it('memakai useSheetPresence dan animasi tutup backdrop', () => {
    expect(queueDrawerSrc).toContain('useSheetPresence')
    expect(queueDrawerSrc).toContain('if (!mounted) return null')
    expect(queueDrawerSrc).toContain('sheet-backdrop-closing')
  })
})
