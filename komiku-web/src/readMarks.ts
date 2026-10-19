/**
 * readMarks.ts — "sudah dibaca" per akun: chapter yang PERNAH dibuka user.
 *
 * Yang disimpan BUKAN posisi baca (itu `useProgress`), tapi SETOF chapter
 * yang sudah dibuka, supaya halaman series bisa menandai chapter mana yang
 * sudah dibaca (teks jadi abu) dan mana yang belum.
 *
 * Kunci chapter = `title_key` series + nomor chapter (string).
 * `title_key` dipakai karena itu identitas series lintas-sumber yang sudah
 * dipakai rak/favorit — chapter yang sama di sumber berbeda (mis. komiku &
 * kiryuu) jadi satu mark yang sama, jadi user tidak melihat chapter yang
 * sudah dia baca di satu sumber tapi tetap terang di sumber lain.
 *
 * Nomor chapter dinormalisasi dengan `chapterNumberOf` yang sama di reader
 * DAN di halaman series — kalau tidak, mark tidak nyambung dengan baris
 * daftarnya (sumber komiku lama hanya punya `id` + `name`).
 *
 * State TERSIMPAN DI SERVER per akun (`PUT /api/read`) dengan merge UNION.
 * Union (bukan replace-all) dipilih karena daftar "sudah dibaca" itu
 * monotonik: push dari device lain tidak boleh menghapus mark chapter yang
 * sudah ada. Kalau nanti ada fitur "tandai belum dibaca", barulah perlu
 * operasi hapus per key.
 *
 * Cache lokal (localStorage) memakai scope per username supaya logout/login
 * tidak bring state akun lama. Tanpa akun → key lokal 'anon' (state lokal
 * saja, tidak pernah di-push ke server karena tidak ada header akun).
 *
 * Store ini MODULE-LEVEL (singleton) — semua konsumen WAJIB import statis
 * (jangan `import.meta.glob`), kalau tidak tiap konsumen dapat instance
 * berbeda dan mark yang baru tidak muncul di halaman lain.
 */

import { getUser, onAccountChange, type AccountEvent } from './account'
import { readApi } from './api'
import { commit, snapshot } from './readMarksQueue'

const KEY_PREFIX = 'komik.readmarks.v1'
const PENDING_PREFIX = 'komik.readmarks.pending.v1'
const ANON_SCOPE = 'anon'
const DEBOUNCE_MS = 1200

/** Mark lokal: `{ "<title_key>:<chapter>": <at_ms> }`. */
type Marks = Record<string, number>

/** Key mark: `title_key` + nomor chapter (dipisah `:` — keduanya tidak punya `:`). */
export function readKey(titleKey: string, chapter: string): string {
  return `${titleKey}:${chapter}`
}

/**
 * Nomor chapter normal — dipakai reader DAN halaman series supaya keduanya
 * menghasilkan key yang sama. Prioritas field `number`; kalau kosong, parse
 * dari judul ("Chapter 45.1" → "45.1"). Null = tidak bisa ditandai.
 */
export function chapterNumberOf(c: {
  number?: string | number | null
  name?: string | null
}): string | null {
  const raw = c.number
  if (raw != null && String(raw).trim() !== '') return String(raw).trim()
  const m = /chapter\s*([0-9]+(?:\.[0-9]+)?)/i.exec(c.name ?? '')
  return m ? m[1] : null
}

/** Scope cache lokal: username akun, atau 'anon' kalau belum masuk. */
function scope(): string {
  return getUser() ?? ANON_SCOPE
}

function storageKey(scopeName: string): string {
  return `${KEY_PREFIX}:${scopeName}`
}

function readLocal(scopeName: string): Marks {
  try {
    const raw = localStorage.getItem(storageKey(scopeName))
    if (!raw) return {}
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    const out: Record<string, number> = {}
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof v === 'number' && Number.isFinite(v)) out[k] = v
    }
    return out
  } catch {
    return {}
  }
}

function writeLocal(scopeName: string, marks: Marks): void {
  try {
    localStorage.setItem(storageKey(scopeName), JSON.stringify(marks))
  } catch {
    /* storage penuh / mode privat — state server tetap jadi sumber kebenaran */
  }
}

/**
 * Mark yang BELUM ter-push, PERSIST di localStorage (per scope).
 *
 * Kenapa harus persist: push di-debounce 1,2 detik, tapi user bisa pindah
 * halaman (reload penuh) sebelum timer jalan — context JS ikut mati dan
 * mark hilang tanpa pernah sampai ke server. Dengan pending yang persist,
 * mark dikirim ulang di sesi berikutnya. Ini yang bikin "dibaca di HP"
 * tetap nyambung ke laptop walau user langsung nutup tab.
 */
function pendingKey(scopeName: string): string {
  return `${PENDING_PREFIX}:${scopeName}`
}

function readPending(scopeName: string): Marks {
  try {
    const raw = localStorage.getItem(pendingKey(scopeName))
    if (!raw) return {}
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    const out: Marks = {}
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof v === 'number' && Number.isFinite(v)) out[k] = v
    }
    return out
  } catch {
    return {}
  }
}

function writePending(scopeName: string, batch: Marks): void {
  try {
    if (Object.keys(batch).length === 0) localStorage.removeItem(pendingKey(scopeName))
    else localStorage.setItem(pendingKey(scopeName), JSON.stringify(batch))
  } catch {
    /* storage penuh — mark tetap ada di `marks`, push ulang di sesi berikut */
  }
}

/** Mark aktif (scope akun sekarang), di-memory supaya render tidak nge-flash. */
let marks: Marks = readLocal(scope())
/** Mark yang belum ter-push, PER SCOPE — ganti akun tak boleh salah kirim. */
let pending: Record<string, Marks> = {}
let timer: ReturnType<typeof setTimeout> | null = null
let started = false
let offAccount: (() => void) | null = null
const listeners = new Set<() => void>()

function emit(): void {
  for (const cb of listeners) {
    try {
      cb()
    } catch (err) {
      console.warn('readMarks: listener gagal', err)
    }
  }
}

/** Daftar pemanggil saat mark berubah (halaman series re-render). */
export function subscribeReadMarks(cb: () => void): () => void {
  listeners.add(cb)
  return () => {
    listeners.delete(cb)
  }
}

/** Chapter sudah dibaca? Series tanpa title_key selalu false. */
export function isChapterRead(
  titleKey: string | null | undefined,
  chapter: string | null | undefined,
): boolean {
  if (!titleKey || !chapter) return false
  return marks[readKey(titleKey, chapter)] !== undefined
}

/** Jumlah chapter yang sudah dibaca untuk satu series. */
export function readCount(titleKey: string | null | undefined): number {
  if (!titleKey) return 0
  const prefix = `${titleKey}:`
  let n = 0
  for (const key of Object.keys(marks)) {
    if (key.startsWith(prefix)) n++
  }
  return n
}

function schedulePush(): void {
  if (getUser() === null) return
  if (timer) clearTimeout(timer)
  timer = setTimeout(() => {
    timer = null
    void flush()
  }, DEBOUNCE_MS)
}

async function flush(): Promise<void> {
  const scopeName = scope()
  const bag = pending[scopeName]
  if (!bag) return
  if (getUser() === null) return
  // Bekukan dulu key yang akan terkirim: `bag` objek yang SAMA dengan antrean
  // pending, jadi mark baru bisa masuk ke dalamnya SELAMA request ini jalan.
  const { sent, payload } = snapshot(bag)
  if (sent.length === 0) {
    delete pending[scopeName]
    writePending(scopeName, {})
    return
  }
  try {
    await readApi.put(payload)
    // Hapus HANYA key yang terkirim — mark yang masuk saat request jalan
    // tetap di antrean → flush berikutnya membawanya.
    commit(bag, sent)
    // Hapus antrean hanya kalau MASIH objek yang sama: dua flush yang
    // overlap bisa menukar antrean, dan `delete` tanpa syarat akan membuang
    // antrean baru beserta mark yang baru masuk.
    if (Object.keys(bag).length === 0 && pending[scopeName] === bag) {
      delete pending[scopeName]
    }
    // pending persisted ikut dibersihkan — kalau ada sisa (mis. mark baru
    // masuk saat request ini jalan), biarkan supaya push berikutnya membawa.
    const left = readPending(scopeName)
    for (const k of sent) delete left[k]
    writePending(scopeName, left)
  } catch (err) {
    // Gagal push: batch dikembalikan ke pending supaya dicoba lagi di mark
    // berikutnya ATAU di sesi berikutnya (pending persist) — jangan hilang.
    pending[scopeName] = { ...bag, ...(pending[scopeName] ?? {}) }
    writePending(scopeName, pending[scopeName])
    console.warn('readMarks: gagal push mark', err)
  }
}

/**
 * Tandai chapter sebagai sudah dibaca.
 *
 * Panggil saat chapter benar-benar DIBUKA (bukan saat daftar chapter
 * dirender) — itu yang membedakan "sudah pernah dibuka" dari "baru terlihat
 * di daftar".
 */
export function markChapterRead(
  titleKey: string | null | undefined,
  chapter: string | null | undefined,
): void {
  if (!titleKey || !chapter) return
  const key = readKey(titleKey, chapter)
  if (marks[key] !== undefined) return
  const at = Date.now()
  marks[key] = at
  const scopeName = scope()
  const bag = (pending[scopeName] ??= {})
  bag[key] = at
  writeLocal(scopeName, marks)
  writePending(scopeName, bag)
  emit()
  schedulePush()
}

/**
 * Tarik mark SATU series dari server (dipakai halaman series saat dibuka).
 * Lazy per-series: total mark per akun bisa ribuan, menariknya semua tiap
 * boot itu mahal dan tidak perlu — yang dipakai cuma series yang dibuka.
 */
export async function pullSeries(titleKey: string): Promise<void> {
  if (!titleKey || getUser() === null) return
  try {
    const remote = await readApi.get(titleKey)
    const scopeName = scope()
    let changed = false
    for (const [seriesKey, chapters] of Object.entries(remote.marks)) {
      for (const [chapter, at] of Object.entries(chapters)) {
        const key = readKey(seriesKey, chapter)
        if (marks[key] === undefined) {
          marks[key] = at
          changed = true
        }
      }
    }
    if (changed) {
      writeLocal(scopeName, marks)
      emit()
    }
  } catch (err) {
    // Endpoint belum ada / jaringan mati: pertahankan state lokal.
    console.warn('readMarks: gagal pull mark series', err)
  }
}

/**
 * Ganti scope (akun berubah / boot) — state lokal ditukar.
 *
 * `created` = akun BARU → mark lokal perangkat (scope 'anon', dibaca
 * sebelum user masuk) diADOPSI ke akun itu lalu di-push, sama seperti
 * favorit & progress. Tanpa ini, chapter yang sudah dibaca sebelum daftar
 * akan kehilangan tandanya.
 */
function switchScope(scopeName: string, adoptAnon = false): void {
  marks = readLocal(scopeName)
  // Mark yang belum sempat ter-push (tab ditutup sebelum debounce jalan)
  // dimuat lagi dari storage dan dikirim ulang.
  const carried = readPending(scopeName)
  const bag = (pending[scopeName] ??= {})
  for (const [k, v] of Object.entries(carried)) {
    if (bag[k] === undefined) bag[k] = v
  }
  if (adoptAnon) {
    const anon = readLocal(ANON_SCOPE)
    for (const [k, v] of Object.entries(anon)) {
      if (marks[k] === undefined) {
        marks[k] = v
        bag[k] = v
      }
    }
    if (Object.keys(anon).length > 0) writeLocal(scopeName, marks)
  }
  emit()
  if (Object.keys(bag).length > 0) schedulePush()
}

/**
 * Mulai sinkronisasi. Aman dipanggil berulang (StrictMode/HMR) — hanya
 * pasang sekali. Kembalikan fungsi stop.
 */
export function startReadMarksSync(): () => void {
  if (typeof window === 'undefined') return () => {}
  if (started) return () => {}
  started = true

  offAccount = onAccountChange((e: AccountEvent) => {
    // Ganti akun: state lokal ikut tertukar (marks per-scope). Mark yang
    // belum ter-push tetap dikelompokkan per scope, jadi tidak terkirim ke
    // akun yang salah.
    //
    // `created === true` → akun BARU: mark lokal perangkat (scope 'anon')
    // diadopsi ke akun itu lalu di-push (aturan yang sama untuk favorit &
    // progress). Selain itu (boot / akun lama) → CUMA tukar scope; server
    // yang jadi kebenaran, mark ditarik per-serial saat series dibuka.
    switchScope(e.username ?? ANON_SCOPE, e.created === true)
  })

  switchScope(scope())

  return () => {
    if (offAccount) {
      offAccount()
      offAccount = null
    }
    if (timer) clearTimeout(timer)
    timer = null
    started = false
  }
}
