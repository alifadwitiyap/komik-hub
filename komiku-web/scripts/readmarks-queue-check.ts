/**
 * Cek logika antrean mark "sudah dibaca" (readMarksQueue) — tanpa browser.
 *
 * Fungsi murni — tanpa server, tanpa DOM. Sengaja TERPISAH dari
 * run-wiring-check.mjs supaya hitungan "21 verifikasi" gate utama tidak
 * berubah (jalankan keduanya, bukan salah satu).
 *
 * Yang diuji:
 *  1. snapshot() membekukan key yang terkirim + payload server yang benar.
 *  2. commit() menghapus HANYA key yang terkirim.
 *  3. PERLOMBAAN: mark baru yang masuk saat request lama masih jalan TIDAK
 *     ikut terhapus → flush berikutnya membawanya.
 *     (Bug nyata: `delete pending[scope]` menghapus SELURUH antrean, mark baru
 *     hilang dari memory DAN storage → tak pernah sampai ke server.)
 *  4. Penolakan key tanpa ':' (key rusak) — tak boleh jadi payload.
 *
 *   node scripts/readmarks-queue-check.mjs
 */
import assert from 'node:assert/strict'
import { commit, snapshot } from '../src/readMarksQueue.ts'

let checks = 0
const ok = (label: string) => {
  checks++
  console.log(`  ok ${checks} — ${label}`)
}

// 1. snapshot: payload benar + key terkirim dibekukan
{
  const bag = { 'one piece:1195': 100, 'one piece:1194': 200 }
  const { sent, payload } = snapshot(bag)
  assert.deepEqual(sent.sort(), ['one piece:1194', 'one piece:1195'])
  assert.deepEqual(payload, { 'one piece': { '1195': 100, '1194': 200 } })
  ok('snapshot: payload server benar + daftar key terkirim dibekukan')
}

// 2. commit: hanya key terkirim yang terhapus
{
  const bag: Record<string, number> = { 's:1': 10, 's:2': 20 }
  commit(bag, ['s:1'])
  assert.deepEqual(Object.keys(bag), ['s:2'])
  ok('commit: hanya key yang terkirim yang dihapus')
}

// 3. PERLOMBAAN — inti bug ini
{
  // antrean berisi mark pertama; request pertama sedang jalan
  const bag: Record<string, number> = { 's:1': 10 }
  const { sent, payload } = snapshot(bag)
  assert.deepEqual(Object.keys(payload['s']), ['1'])

  // mark kedua masuk SAAT request masih jalan (antrean = objek yang sama)
  bag['s:2'] = 20

  // request selesai → commit hanya key yang terkirim
  commit(bag, sent)

  assert.ok('s:2' in bag, 'mark yang masuk saat request jalan harus tetap di antrean')
  assert.ok(!('s:1' in bag), 'mark yang sudah terkirim boleh dihapus')

  // flush berikutnya membawa mark kedua
  const next = snapshot(bag)
  assert.deepEqual(Object.keys(next.payload['s']), ['2'])
  ok('perlombaan: mark baru saat request jalan TIDAK ikut terhapus, flush berikutnya membawanya')
}

// 4. key tanpa ':' ditolak (tak jadi payload, tak jadi key terkirim)
{
  const bag = { rusak: 1, 's:1': 5 }
  const { sent, payload } = snapshot(bag)
  assert.deepEqual(sent, ['s:1'])
  assert.deepEqual(Object.keys(payload), ['s'])
  ok('key tanpa titik dua ditolak (tak jadi payload)')
}

console.log(`\nreadmarks-queue-check: OK — ${checks} verifikasi lulus`)
