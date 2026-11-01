import { useCallback, useEffect, useRef, useState } from 'react'
import { onAccountChange, type AccountEvent } from '../account'

/** Baca blob localStorage; toleran terhadap mode privat/gagal akses. */
function readRaw(key: string): string | null {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

export interface UsePerAccountLocalStorageOptions<T> {
  /** Key penyimpanan per-akun (dihitung dari getUser() kala dipakai). */
  readKey: () => string
  /** Parse blob localStorage menuju nilai store. */
  parse: (raw: string | null) => T
  /** Serialize nilai store menuju blob localStorage. */
  serialize: (value: T) => string
  /**
   * Override perilaku saat ganti akun. Default: baca ulang dari key akun
   * baru (persis perilaku store lokal per-akun biasa). Bila disediakan,
   * pemanggil yang mengendalikan arah sinkronisasi (mis. pull/push server).
   */
  onAccountChange?: (e: AccountEvent) => void
}

/**
 * Store localStorage per-akun (primitive).
 *
 * Menghilangkan skeleton identik antara store yang berbagi pola per-akun:
 * satu `entries` state + cermin `entriesRef`, `apply(next)` untuk menulis ke
 * storage, listener lintas-tab (`storage`) untuk resync, dan listener ganti
 * akun yang baca ulang.
 */
export function usePerAccountLocalStorage<T>(opts: UsePerAccountLocalStorageOptions<T>) {
  const optsRef = useRef(opts)
  optsRef.current = opts

  const [entries, setEntries] = useState<T>(() => opts.parse(readRaw(opts.readKey())))
  const entriesRef = useRef<T>(entries)

  /** Tulis ke storage + perbarui cermin tanpa menyentuh state (utk jalur async). */
  const persist = useCallback((next: T) => {
    entriesRef.current = next
    try {
      localStorage.setItem(optsRef.current.readKey(), optsRef.current.serialize(next))
    } catch {
      /* storage penuh / mode privat — tidak ganggu membaca */
    }
  }, [])

  /** Set state + cermin + persisten — satu-satunya jalur mutasi eksternal. */
  const apply = useCallback((next: T) => {
    persist(next)
    setEntries(next)
  }, [persist])

  useEffect(() => {
    const reRead = () => {
      const o = optsRef.current
      apply(o.parse(readRaw(o.readKey())))
    }
    const onStorage = (e: StorageEvent) => {
      if (e.key === optsRef.current.readKey()) reRead()
    }
    window.addEventListener('storage', onStorage)
    const off = onAccountChange((e) => {
      const custom = optsRef.current.onAccountChange
      if (custom) custom(e)
      else reRead()
    })
    return () => {
      window.removeEventListener('storage', onStorage)
      off()
    }
  }, [apply])

  return { entries, apply, entriesRef }
}
