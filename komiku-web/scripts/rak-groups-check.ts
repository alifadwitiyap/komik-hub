/**
 * Cek logika PENGELOMPOKAN tab Unduhan (Rak.tsx): grup per series, total
 * ukuran, urutan terbaru-dulu, aturan default terbuka (<=3 chapter).
 *
 * Fungsi murni — tanpa server, tanpa browser. Sengaja TERPISAH dari
 * run-wiring-check.mjs supaya hitungan "21 verifikasi" gate utama tidak
 * berubah (jalankan keduanya, bukan salah satu).
 *
 *   node scripts/rak-groups-check.mjs
 */
import assert from 'node:assert/strict'
import { defaultOpen, groupBySeries } from '../src/pages/Rak.tsx'
import type { DownloadItem } from '../src/types.ts'

const item = (
  id: string,
  handle: string,
  series_title: string,
  number: string,
  size_bytes: number,
  downloaded_at: number,
): DownloadItem => ({
  id,
  handle,
  number,
  title: `Chapter ${number}`,
  series_title,
  filename: `${id}.pdf`,
  size_bytes,
  downloaded_at,
  last_opened_at: null,
})

// urutan sengaja dicampur (bukan per-series) supaya grup & sort benar-benar diuji
const items: DownloadItem[] = [
  item('a1', 'komiku:6426', 'One Piece', '1', 1000, 100),
  item('b1', 'kiryuu:solo', 'Solo Leveling', '1', 2000, 400),
  item('a2', 'komiku:6426', 'One Piece', '2', 1500, 200),
  item('b2', 'kiryuu:solo', 'Solo Leveling', '2', 2500, 300),
  item('a3', 'komiku:6426', 'One Piece', '3', 1200, 500),
  item('a4', 'komiku:6426', 'One Piece', '4', 1300, 600),
]

let checks = 0
const ok = (label: string) => {
  checks++
  console.log(`  ok ${checks} — ${label}`)
}

const groups = groupBySeries(items)
assert.equal(groups.length, 2, 'dua series → dua grup')
assert.equal(groups[0].handle, 'komiku:6426', 'grup dengan unduhan terbaru tampil dulu')
assert.equal(groups[0].items.length, 4, 'semua chapter series yang sama masuk satu grup')
assert.equal(groups[0].source, 'komiku', 'sumber grup dari prefix handle')
assert.equal(groups[0].bytes, 1000 + 1500 + 1200 + 1300, 'total ukuran = jumlah chapter grup')
assert.equal(groups[1].handle, 'kiryuu:solo', 'grup kedua = series lain')
assert.equal(groups[1].bytes, 4500, 'total ukuran grup kedua')
ok(`grup per series: ${groups.map((g) => `${g.title} (${g.items.length} ch, ${g.bytes}B)`).join(' · ')}`)

assert.equal(defaultOpen(groups[0]), false, '>3 chapter → kartu default tertutup')
assert.equal(defaultOpen(groups[1]), true, '<=3 chapter → kartu default terbuka')
ok('default terbuka hanya untuk grup <=3 chapter')

// handle = kunci grup: judul sama dari sumber berbeda TIDAK digabung
const cross = groupBySeries([...items, item('k1', 'kiryuu:op', 'One Piece', '1', 100, 10)])
assert.equal(cross.length, 3, 'judul sama tapi handle beda → grup terpisah')
ok('grup berkunci handle (bukan judul) — series lintas sumber tidak melebur')

console.log(`\nrak-groups-check: OK — ${checks} verifikasi lulus`)
