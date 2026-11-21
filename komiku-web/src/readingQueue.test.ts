import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type * as ReadingQueue from './readingQueue'
import type { NotifItem } from './api'
import type { FavoriteEntry } from './rakStore'

let q: typeof ReadingQueue

function memStorage(): Storage {
  const m = new Map<string, string>()
  return {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, String(v)),
    removeItem: (k: string) => void m.delete(k),
    clear: () => m.clear(),
    key: (i: number) => [...m.keys()][i] ?? null,
    get length() {
      return m.size
    },
  } as Storage
}

const fav = (handle: string, titleKey: string): FavoriteEntry => ({
  handle,
  title_key: titleKey,
  title: `Judul ${handle}`,
  cover_url: null,
  source: 'komiku',
  loved_at: 0,
})

const notif = (titleKey: string, handle: string, chapter: string, at: number): NotifItem => ({
  id: `${titleKey}:${chapter}`,
  title_key: titleKey,
  title: `Judul ${handle}`,
  handle,
  chapter,
  sources: ['komiku'],
  at,
  read: false,
})

beforeEach(async () => {
  vi.resetModules()
  vi.stubGlobal('localStorage', memStorage())
  vi.stubGlobal('sessionStorage', memStorage())
  q = await import('./readingQueue')
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('readingQueue — antrean update favorit (tanpa backend)', () => {
  it('hanya favorit dengan unread > 0, diurutkan hari-ini dulu lalu terbaru', () => {
    const now = Date.now()
    const favorites = [
      fav('lama', 'k-lama'),
      fav('baru2', 'k-baru2'),
      fav('tanpa-chapter', 'k-tanpa'),
      fav('baru1', 'k-baru1'),
      fav('nol', 'k-nol'),
    ]
    const unreadByTitle: Record<string, number> = {
      'k-lama': 3,
      'k-baru2': 1,
      'k-tanpa': 2,
      'k-baru1': 4,
      'k-nol': 0,
    }
    const latestByTitle: Record<string, NotifItem> = {
      'k-lama': notif('k-lama', 'lama', '12', now - 3 * 86_400_000),
      'k-baru2': notif('k-baru2', 'baru2', '8', now - 3 * 3_600_000),
      'k-tanpa': { ...notif('k-tanpa', 'tanpa-chapter', '9', now), chapter: '' },
      'k-baru1': notif('k-baru1', 'baru1', '7', now - 60_000),
      'k-nol': notif('k-nol', 'nol', '5', now),
    }

    const items = q.collectQueueItems(favorites, unreadByTitle, latestByTitle)
    expect(items.map((it) => it.handle)).toEqual(['baru1', 'baru2', 'lama'])
    expect(items.map((it) => it.unreadCount)).toEqual([4, 1, 3])
    expect(items.map((it) => it.isToday)).toEqual([true, true, false])
    expect(items[0].targetChapter).toBe('7')
    expect(items[0].updatedAt).toBe(latestByTitle['k-baru1'].at)
  })

  it('simpan/muat state dari sessionStorage dan rapikan index', () => {
    const item: ReadingQueue.QueueItem = {
      handle: 'series',
      titleKey: 'k-series',
      title: 'Series',
      coverUrl: null,
      unreadCount: 2,
      targetChapter: '10',
      isToday: true,
      updatedAt: Date.now(),
    }
    q.saveReadingQueue({ active: true, items: [item], currentIndex: 99 })
    expect(q.loadReadingQueue()).toEqual({ active: true, items: [item], currentIndex: 0 })

    sessionStorage.setItem('komik-update-queue-v1', '{rusak')
    expect(q.loadReadingQueue()).toBeNull()
    sessionStorage.removeItem('komik-update-queue-v1')
    expect(q.loadReadingQueue()).toBeNull()
  })

  it('advance berhenti di item terakhir dan href tidak meng-encode dua kali', () => {
    const state: ReadingQueue.ReadingQueueState = {
      active: true,
      currentIndex: 0,
      items: [
        {
          handle: 'some-series',
          titleKey: 'k1',
          title: 'A',
          coverUrl: null,
          unreadCount: 1,
          targetChapter: '2',
          isToday: true,
          updatedAt: 1,
        },
      ],
    }
    expect(q.advanceReadingQueue(state).currentIndex).toBe(0)
    expect(q.queueReaderHref(state.items[0])).toBe('/baca/some-series/2?queue=1')
  })
})
