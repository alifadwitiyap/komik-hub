/**
 * Manifest offline per chapter — IndexedDB mentah (tanpa dependency).
 *
 * Database 'komiku-offline', store 'manifests' (keyPath 'key', key =
 * `chapter:<id>`). Isi tiap record: daftar URL absolut (semuanya lewat
 * proxy /img?u=... supaya sama dengan cache service worker) + berapa yang
 * sudah benar-benar tersimpan. Cache gambar sendiri tetap tinggal di
 * cache 'komiku-img-v1' milik service worker; file ini hanya mencatat
 * APA yang seharusnya ada di sana supaya status "x/y tersimpan" jujur.
 */

const DB_NAME = 'komiku-offline'
const DB_VERSION = 1
const STORE = 'manifests'

export interface OfflineManifest {
  key: string // `chapter:<id>`
  chapterId: string
  chapterName: string
  seriesId: number | string | null
  urls: string[]
  saved: number
  total: number
  updatedAt: number
}

/** Key store — `chapter:<id>`. */
export function manifestKey(chapterId: string): string {
  return `chapter:${chapterId}`
}

let dbPromise: Promise<IDBDatabase> | null = null

function openDb(): Promise<IDBDatabase> {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION)
      req.onupgradeneeded = () => {
        const db = req.result
        if (!db.objectStoreNames.contains(STORE)) {
          db.createObjectStore(STORE, { keyPath: 'key' })
        }
      }
      req.onsuccess = () => resolve(req.result)
      req.onerror = () => reject(req.error)
    })
  }
  return dbPromise
}

function run<T>(
  mode: IDBTransactionMode,
  fn: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  return openDb().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const t = db.transaction(STORE, mode)
        const req = fn(t.objectStore(STORE))
        req.onsuccess = () => resolve(req.result)
        req.onerror = () => reject(req.error)
      }),
  )
}

/** Manifest chapter, atau null kalau belum pernah dicatat. */
export function getManifest(chapterId: string): Promise<OfflineManifest | null> {
  return run<OfflineManifest | undefined>('readonly', (s) =>
    s.get(manifestKey(chapterId)),
  ).then((m) => m ?? null)
}

export function putManifest(m: OfflineManifest): Promise<void> {
  return run('readwrite', (s) => s.put(m)).then(() => undefined)
}

/** Catat berapa URL yang sudah pasti ada di cache service worker. */
export async function markSaved(chapterId: string, count: number): Promise<void> {
  const m = await getManifest(chapterId)
  if (!m) return
  await putManifest({ ...m, saved: count, updatedAt: Date.now() })
}

/**
 * Daftar URL chapter (gabung kalau sudah ada manifest lama, urut & tanpa
 * duplikat). `saved` dibatasi total terbaru supaya status tidak mengaku
 * lebih banyak dari yang bisa diverifikasi.
 */
export async function addChapterUrls(
  chapterId: string,
  chapterName: string,
  seriesId: number | string | null,
  urls: string[],
): Promise<OfflineManifest> {
  const prev = await getManifest(chapterId)
  const merged = prev ? mergeUrls(prev.urls, urls) : [...urls]
  const m: OfflineManifest = {
    key: manifestKey(chapterId),
    chapterId,
    chapterName,
    seriesId,
    urls: merged,
    saved: Math.min(prev?.saved ?? 0, merged.length),
    total: merged.length,
    updatedAt: Date.now(),
  }
  await putManifest(m)
  return m
}

/** Gabung dua daftar URL, urut, tanpa duplikat. */
export function mergeUrls(a: string[], b: string[]): string[] {
  const out = [...a]
  const seen = new Set(a)
  for (const u of b) {
    if (seen.has(u)) continue
    seen.add(u)
    out.push(u)
  }
  return out
}
