/**
 * Self-check Lane W (akun) — dua jaminan yang paling mudah salah dan paling
 * mahal kalau salah. Fungsi murni/logika store; tanpa browser, tanpa server.
 *
 * Jalankan:  node scripts/akun-check.mjs
 * (runner membundel .ts ini lewat Vite lalu menjalankannya di node —
 *  pola sama scripts/rak-groups-check.mjs; tanpa framework baru)
 *
 * Yang dibuktikan:
 *  1. `mergeProgress` — entri `at` lebih besar menang (spec §6), per seriesId,
 *     diurut terbaru-dulu dan dipotong MAX.
 *  2. `replaceFavorites({ silent: true })` TIDAK memancarkan `rak-change`
 *     (spec §6) — kalau memancar, hydrate akan memicu push balik dan membuang
 *     favorit server. Dan tanpa `silent`, ia HARUS memancar.
 *  3. `isValidUsername` mencerminkan aturan server (tolak path traversal).
 */
import assert from 'node:assert/strict'

// --- stub localStorage + window (node tidak punya DOM) ---------------------
// Semua akses DOM di modul di bawah bersifat lazy (saat dipanggil), jadi
// memasang stub di sini — sebelum pemanggilan pertama — sudah cukup.
const store = new Map<string, string>()
// @ts-expect-error sediakan localStorage minimal
globalThis.localStorage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k),
}

let rakEvents = 0
// @ts-expect-error sediakan window minimal untuk rakStore.emit()
globalThis.window = {
  dispatchEvent: () => {
    rakEvents++
    return true
  },
}

import { replaceFavorites, listFavorites } from '../src/rakStore.ts'
import { mergeProgress } from '../src/hooks/useProgress.ts'
import { isValidUsername, normalizeUsername } from '../src/account.ts'

let checks = 0
const ok = (label: string) => {
  checks++
  console.log(`  ok ${checks} — ${label}`)
}

// --- 1. mergeProgress: `at` terbesar menang --------------------------------
type P = {
  seriesId: number | string
  seriesTitle: string | null
  chapterId: number | string
  chapterName: string
  page: number
  progress: number
  at: number
}
const local: P[] = [
  { seriesId: 1, seriesTitle: 'A', chapterId: 10, chapterName: 'c10', page: 5, progress: 0.5, at: 100 },
  { seriesId: 2, seriesTitle: 'B', chapterId: 3, chapterName: 'c3', page: 1, progress: 0.1, at: 200 },
]
const remote: P[] = [
  // series 1: server lebih baru → menang
  { seriesId: 1, seriesTitle: 'A', chapterId: 12, chapterName: 'c12', page: 9, progress: 0.9, at: 300 },
  // series 2: lokal lebih baru → lokal menang
  { seriesId: 2, seriesTitle: 'B', chapterId: 4, chapterName: 'c4', page: 2, progress: 0.2, at: 150 },
  // series 3: hanya ada di server → ikut
  { seriesId: 3, seriesTitle: 'C', chapterId: 1, chapterName: 'c1', page: 0, progress: 0, at: 50 },
]
const merged = mergeProgress(local, remote)
assert.equal(merged.length, 3, 'gabungan punya satu entri per series')
const byId = Object.fromEntries(merged.map((e) => [String(e.seriesId), e]))
assert.equal(byId['1'].at, 300, 'server lebih baru → server menang')
assert.equal(byId['1'].page, 9)
assert.equal(byId['2'].at, 200, 'lokal lebih baru → lokal menang')
assert.equal(byId['2'].page, 1)
assert.equal(byId['3'].at, 50, 'entri hanya-di-server tetap ikut')
assert.equal(merged[0].at, 300, 'urut terbaru-dulu')
ok('mergeProgress: per seriesId, `at` terbesar menang, urut terbaru-dulu')

// MAX = 24 dipertahankan
const many: P[] = Array.from({ length: 30 }, (_, i) => ({
  seriesId: i,
  seriesTitle: null,
  chapterId: i,
  chapterName: 'c',
  page: 0,
  progress: 0,
  at: i,
}))
assert.equal(mergeProgress(many, []).length, 24, 'dipotong MAX=24')
ok('mergeProgress: hasil dibatasi MAX=24')

// --- 2. replaceFavorites: silent tidak memancarkan rak-change ---------------
rakEvents = 0
replaceFavorites(
  [{ title_key: 'k1', title: 'T', cover_url: null, handle: 'komiku:1', source: 'komiku' }],
  { silent: true },
)
assert.equal(rakEvents, 0, 'silent:true TIDAK boleh memancarkan rak-change (cegah push balik)')
assert.equal(listFavorites().length, 1, 'favorit tetap tersimpan walau silent')
ok('replaceFavorites({silent:true}) menyimpan tanpa memancarkan rak-change')

rakEvents = 0
replaceFavorites([], {}) // tanpa silent → harus memancar
assert.equal(rakEvents, 1, 'tanpa silent HARUS memancarkan rak-change')
assert.equal(listFavorites().length, 0, 'replace-all mengganti isi, bukan menambah')
ok('replaceFavorites tanpa silent memancarkan rak-change (replace-all)')

// --- 3. isValidUsername mencerminkan aturan server -------------------------
for (const good of ['alif', 'alif_2', 'a-b-c', 'user123']) {
  assert.ok(isValidUsername(good), `harus valid: ${good}`)
}
for (const bad of ['ab', 'a', '', '   ', '_alif', '-alif', '../etc/passwd', 'a/b', 'alif!', 'álif']) {
  assert.ok(!isValidUsername(bad), `harus ditolak: ${bad}`)
}
assert.equal(normalizeUsername('  ALIF '), 'alif', 'trim + lowercase = satu akun')
ok('isValidUsername: aturan sama server (tolak path traversal & simbol awal)')

console.log(`\nakun-check: OK — ${checks} verifikasi lulus`)
