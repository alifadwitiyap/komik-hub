/**
 * useNotifications — state & aksi panel notifikasi.
 *
 * GET /api/notif/list saat mount + poll tiap 60 detik. Kegagalan jaringan
 * (server belum meng-integrasikan endpoint → 404) TIDAK meng-crash: data
 * sebelumnya dipertahankan, dan kalau belum pernah ada data, state kosong
 * (items=[], unread=0) — UI jatuh ke empty state.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { notifApi, type NotifItem } from '../api'

const POLL_MS = 60_000

export interface NotificationsState {
  items: NotifItem[]
  unread: number
  lastCheckAt: number | null
  loading: boolean
}

/** Satu baris panel = satu series (title_key), bukan satu notifikasi. */
export interface NotifTitleGroup {
  title_key: string
  /** SEMUA id notif title ini — API markRead/dismiss bekerja per-id. */
  ids: string[]
  /** jumlah chapter baru yang diagregasi ke title ini. */
  count: number
  /** jumlah yang belum dibaca (0 → titik unread tidak tampil). */
  unread: number
  /** notif `at` terbesar → judul, sources, waktu relatif yang ditampilkan. */
  latest: NotifItem
}

/**
 * Kelompokkan items per title_key. Urutan = kemunculan pertama di `items`
 * (server sudah kirim terbaru-dulu). Sumber tunggal derivasi per-title untuk
 * hook (unreadByTitle/latestByTitle) dan panel.
 */
export function groupNotifsByTitle(items: NotifItem[]): NotifTitleGroup[] {
  const byKey = new Map<string, NotifItem[]>()
  for (const it of items) {
    const list = byKey.get(it.title_key)
    if (list) list.push(it)
    else byKey.set(it.title_key, [it])
  }
  return [...byKey].map(([title_key, list]) => ({
    title_key,
    ids: list.map((it) => it.id),
    count: list.length,
    unread: list.reduce((n, it) => n + (it.read ? 0 : 1), 0),
    latest: list.reduce((a, b) => (b.at > a.at ? b : a)),
  }))
}

export function useNotifications() {
  const [state, setState] = useState<NotificationsState>({
    items: [],
    unread: 0,
    lastCheckAt: null,
    loading: true,
  })
  // menandai sudah pernah ada data sukses; failure tidak menghapus snapshot
  const hasData = useRef(false)
  const mounted = useRef(true)

  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])

  const apply = useCallback((data: { items: NotifItem[]; unread: number; last_check_at: number | null }) => {
    if (!mounted.current) return
    hasData.current = true
    setState({
      items: data.items,
      unread: data.unread,
      lastCheckAt: data.last_check_at,
      loading: false,
    })
  }, [])

  const load = useCallback(async () => {
    try {
      apply(await notifApi.list())
    } catch {
      // endpoint belum ada / jaringan mati: pertahankan data lama, kalau
      // belum pernah ada data → state kosong (sudah nilai awal).
      if (mounted.current && !hasData.current) {
        setState((s) => ({ ...s, loading: false }))
      }
    }
  }, [apply])

  // fetch awal + polling 60s
  useEffect(() => {
    void load()
    const id = setInterval(() => void load(), POLL_MS)
    return () => clearInterval(id)
  }, [load])

  /** Dipanggil saat panel dibuka: ambil data terbaru sekarang. */
  const refresh = useCallback(() => {
    void load()
  }, [load])

  const markRead = useCallback(async (ids?: string[] | 'all') => {
    // optimistik: baris langsung tampil sebagai sudah dibaca
    setState((s) => ({
      ...s,
      items:
        ids === 'all'
          ? s.items.map((it) => ({ ...it, read: true }))
          : s.items.map((it) => (ids?.includes(it.id) ? { ...it, read: true } : it)),
      unread: ids === 'all' ? 0 : Math.max(0, s.unread - (ids?.length ?? 0)),
    }))
    try {
      await notifApi.markRead(ids === 'all' || !ids ? { all: true } : { ids })
    } catch {
      // server menolak: state lokal tetap seperti tampilan user (jangan rollback
      // yang membingungkan); poll berikutnya membawa state server sebenarnya.
    }
  }, [])

  const dismiss = useCallback(async (id: string) => {
    setState((s) => {
      const item = s.items.find((it) => it.id === id)
      return {
        ...s,
        items: s.items.filter((it) => it.id !== id),
        unread: item && !item.read ? Math.max(0, s.unread - 1) : s.unread,
      }
    })
    try {
      await notifApi.dismiss(id)
    } catch {
      /* abaikan — poll berikutnya menyelaraskan */
    }
  }, [])

  // derivasi per-series (memo di items): badge & panel pakai sumber yang sama
  const { unreadByTitle, latestByTitle } = useMemo(() => {
    const unreadByTitle: Record<string, number> = {}
    const latestByTitle: Record<string, NotifItem> = {}
    for (const g of groupNotifsByTitle(state.items)) {
      unreadByTitle[g.title_key] = g.unread
      latestByTitle[g.title_key] = g.latest
    }
    return { unreadByTitle, latestByTitle }
  }, [state.items])

  return { ...state, refresh, markRead, dismiss, unreadByTitle, latestByTitle }
}

export type UseNotifications = ReturnType<typeof useNotifications>
