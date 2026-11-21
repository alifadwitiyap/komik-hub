/**
 * Antrean baca update favorit — state murni sisi klien (sessionStorage).
 * Tidak ada endpoint backend baru; sumber kebenaran tetap favorit + notif.
 */
import type { NotifItem } from './api'
import * as rakStore from './rakStore'
import { markChapterRead } from './readMarks'

export interface QueueItem {
  handle: string
  titleKey: string
  title: string
  coverUrl?: string | null
  unreadCount: number
  targetChapter: string
  isToday: boolean
  updatedAt: number
}

export interface ReadingQueueState {
  active: boolean
  items: QueueItem[]
  currentIndex: number
}

const STORAGE_KEY = 'komik-update-queue-v1'
const DAY_MS = 86_400_000
export const QUEUE_READ_EVENT = 'komik-queue-read'

interface NotifSnapshot {
  items: NotifItem[]
  unreadByTitle: Record<string, number>
  latestByTitle: Record<string, NotifItem>
}

const EMPTY_SNAPSHOT: NotifSnapshot = {
  items: [],
  unreadByTitle: {},
  latestByTitle: {},
}

// Jembatan context → modul: buildReadingQueue() zero-arg dipanggil dari handler
// non-React, sementara data notif hidup di provider.
let snapshot: NotifSnapshot = EMPTY_SNAPSHOT

export function setNotifSnapshot(
  items: NotifItem[],
  unreadByTitle: Record<string, number>,
  latestByTitle: Record<string, NotifItem>,
): void {
  snapshot = { items, unreadByTitle, latestByTitle }
}

export function getNotifSnapshot(): NotifSnapshot {
  return snapshot
}

/** Susun item dari data yang sudah ada di hook/favorit (dipakai strip + build). */
export function collectQueueItems(
  favorites: rakStore.FavoriteEntry[],
  unreadByTitle: Record<string, number>,
  latestByTitle: Record<string, NotifItem>,
): QueueItem[] {
  const now = Date.now()
  const items: QueueItem[] = []
  for (const fav of favorites) {
    const count = unreadByTitle[fav.title_key] ?? 0
    if (!Number.isFinite(count) || count <= 0) continue
    const latest = latestByTitle[fav.title_key]
    if (!fav.handle || !latest?.chapter) continue
    items.push({
      handle: fav.handle,
      titleKey: fav.title_key,
      title: fav.title,
      coverUrl: fav.cover_url,
      unreadCount: count,
      targetChapter: latest.chapter,
      isToday: now - latest.at < DAY_MS,
      updatedAt: latest.at,
    })
  }
  // Hari ini dulu (terbaru dulu), lalu sisanya (terbaru dulu).
  items.sort((a, b) => Number(b.isToday) - Number(a.isToday) || b.updatedAt - a.updatedAt)
  return items
}

export function buildReadingQueue(): ReadingQueueState {
  const { unreadByTitle, latestByTitle } = getNotifSnapshot()
  const items = collectQueueItems(rakStore.listFavorites(), unreadByTitle, latestByTitle)
  return { active: items.length > 0, items, currentIndex: 0 }
}

export function saveReadingQueue(state: ReadingQueueState): void {
  try {
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(state))
  } catch {
    // mode privat / storage penuh — antrean tetap jalan di memori sesi ini
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function isQueueItem(v: unknown): v is QueueItem {
  if (!isRecord(v)) return false
  return (
    typeof v.handle === 'string' && v.handle.length > 0 &&
    typeof v.titleKey === 'string' && v.titleKey.length > 0 &&
    typeof v.title === 'string' && v.title.length > 0 &&
    (v.coverUrl == null || typeof v.coverUrl === 'string') &&
    typeof v.unreadCount === 'number' && Number.isFinite(v.unreadCount) &&
    typeof v.targetChapter === 'string' && v.targetChapter.length > 0 &&
    typeof v.isToday === 'boolean' &&
    typeof v.updatedAt === 'number' && Number.isFinite(v.updatedAt)
  )
}

export function loadReadingQueue(): ReadingQueueState | null {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY)
    if (!raw) return null
    const parsed: unknown = JSON.parse(raw)
    if (!isRecord(parsed) || typeof parsed.active !== 'boolean' || !Array.isArray(parsed.items)) return null
    if (!parsed.items.every(isQueueItem)) return null
    const index = typeof parsed.currentIndex === 'number' ? parsed.currentIndex : 0
    return {
      active: parsed.active,
      items: parsed.items,
      currentIndex: Math.max(0, Math.min(Math.trunc(index), Math.max(0, parsed.items.length - 1))),
    }
  } catch {
    return null
  }
}

export function advanceReadingQueue(state: ReadingQueueState): ReadingQueueState {
  if (state.items.length === 0) return state
  return {
    ...state,
    currentIndex: Math.min(state.currentIndex + 1, state.items.length - 1),
  }
}

export function queueReaderHref(item: QueueItem): string {
  return `/baca/${encodeURIComponent(item.handle)}/${encodeURIComponent(item.targetChapter)}?queue=1`
}

/** Tandai seri aktif selesai: readMarks + notif context (via event provider). */
export function markQueueItemRead(state: ReadingQueueState): void {
  const item = state.items[state.currentIndex]
  if (!item) return
  markChapterRead(item.titleKey, item.targetChapter)
  if (typeof window !== 'undefined' && typeof CustomEvent !== 'undefined') {
    window.dispatchEvent(new CustomEvent(QUEUE_READ_EVENT, { detail: { titleKey: item.titleKey } }))
  }
}
