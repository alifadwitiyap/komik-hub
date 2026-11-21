/**
 * NotifCounts — satu instance useNotifications() untuk seluruh app.
 *
 * App membungkus shell dengan <NotifCountsProvider>; TopBar (lonceng),
 * HeartButton (gelembung "UP n"), dan Rak (baris favorit) membaca lewat
 * useNotifCounts(). Tanpa provider (render terisolasi, wiring-check,
 * fixture SSR) hook jatuh ke nilai default aman: 0/[] dan aksi no-op —
 * tidak ada fetch, tidak ada crash.
 *
 * File .ts (bukan .tsx): provider memakai createElement supaya nama file
 * persis seperti kontrak lane.
 */

import { createContext, createElement, useContext, useEffect, type ReactNode } from 'react'
import { useNotifications, type UseNotifications } from './hooks/useNotifications'
import { QUEUE_READ_EVENT, setNotifSnapshot } from './readingQueue'
import type { NotifItem } from './api'

type Hook = UseNotifications

/** Nilai context = hasil PENUH useNotifications() (kontrak pinning). */
export interface NotifCountsValue {
  items: Hook['items']
  unread: number
  lastCheckAt: number | null
  loading: boolean
  /** jumlah notif BELUM dibaca per title_key — dipakai semua badge hati. */
  unreadByTitle: Record<string, number>
  latestByTitle: Record<string, NotifItem>
  refresh: Hook['refresh']
  markRead: Hook['markRead']
  dismiss: Hook['dismiss']
}

const SAFE_DEFAULT: NotifCountsValue = {
  items: [],
  unread: 0,
  lastCheckAt: null,
  loading: false,
  unreadByTitle: {},
  latestByTitle: {},
  refresh: () => {},
  markRead: async () => {},
  dismiss: async () => {},
}

const NotifCountsContext = createContext<NotifCountsValue | null>(null)

export function NotifCountsProvider({ children }: { children: ReactNode }) {
  // ponytail: cast = jembatan compile lintas-lane. Lane B menambahkan
  // unreadByTitle/latestByTitle ke useNotifications(); begitu mendarat,
  // cast jadi identitas dan baris ini bisa dibuang.
  const value = useNotifications() as NotifCountsValue

  // Antrean (modul non-React) membaca snapshot ini; useEffect aktif setelah
  // commit supaya tidak ada side effect di render.
  useEffect(() => {
    setNotifSnapshot(value.items, value.unreadByTitle, value.latestByTitle)
  }, [value.items, value.unreadByTitle, value.latestByTitle])

  // Kartu antrean menandai satu seri selesai → tandai notif belum baca seri itu
  // lewat jalur context yang sama dengan panel Notifikasi (optimistik + API).
  useEffect(() => {
    const onQueueRead = (event: Event) => {
      const titleKey = (event as CustomEvent<{ titleKey?: string }>).detail?.titleKey
      if (!titleKey) return
      const ids = value.items.filter((it) => it.title_key === titleKey && !it.read).map((it) => it.id)
      if (ids.length > 0) void value.markRead(ids)
    }
    window.addEventListener(QUEUE_READ_EVENT, onQueueRead)
    return () => window.removeEventListener(QUEUE_READ_EVENT, onQueueRead)
  }, [value.items, value.markRead])

  return createElement(NotifCountsContext.Provider, { value }, children)
}

/** Ambil state notif; aman dipakai di luar provider (default Nol). */
export function useNotifCounts(): NotifCountsValue {
  return useContext(NotifCountsContext) ?? SAFE_DEFAULT
}
