# Task Perf — Optimasi cold path union chapter

## Goal

Turunkan cold path `GET /api/unified/series/{handle}` dari **4.75s** → target
jauh lebih kecil, **tanpa mengubah** perilaku yang sudah diverifikasi live.

## Angka baseline (server fresh, cache kosong, port 8790, build 04:09)

| Endpoint | COLD | WARM (cache 10m) |
|---|---|---|
| `/api/unified/series/komiku%3A6167` | **4.75s** | 9ms |
| `/api/unified/chapter/komiku%3A6167/232` | **1.56s** | 3ms |
| `/api/unified/chapter/komiku:1284/121` | 2.05s | — |
| `/api/unified/search?q=naruto&page=2` | 2.1s | — |

`search` 2.1s itu **PRE-EXISTING** (fan-out 4 sumber sudah ada sebelum fitur
union) — jangan dianggap regresi dan jangan "#{optimasi}" itu sebagai target.

Latency upstream per sumber itu sendiri cepat: komiku 14ms, mangaku 68ms,
shinigami 3ms, kiryuu 87ms. Jadi 4.75s itu **bukan jaringan lambat** — itu
jumlah round-trip yang dikalikan.

## Root cause (terverifikasi)

`Aggregator::collect_series_across_sources` (`komik/core/src/aggregator.rs`,
sekitar baris 1160-1270) per sumber melakukan:

1. `src.resolve(&cand)` → default trait `Source::resolve` (source.rs:154)
   memanggil `self.search(title, 1)` lalu mencocokkan `title_key` → **1 HTTP
   request penuh**
2. lalu `src.series(&m.native_id)` → **1 HTTP request lagi**

= 2 round-trip per sumber × 4 sumber = 8 request. Fan-out sudah paralel
(`join_sources`), jadi cold path terikat **jumlah round-trip**, bukan CPU.

Ditambah: `series_merged` memanggil `series_resolve_pref` (1 sumber, fan-out
terpisah) DAN `collect_series_across_sources` (3 sumber, fan-out kedua) — dua
fan-out yang **tidak paralel satu sama lain**.

## Arah yang boleh dikerjakan (pilih yang paling aman)

**(a) HEMAT ROUND-TRIP.** `resolve` default sebenarnya cuma `search` + filter
`title_key`. Kalau `collect_series_across_sources` memanggil `search` sekali
dan memfilter `title_key` sendiri, `native_id` bisa didapat dari 1 request —
tanpa request `resolve` terpisah. Perhatikan: `resolve` default = `search`
(1 request) → `series` (1 request) = 2; kalau `resolve` bisa di-inline ke
dalam satu `search` call, tetep 2. Yang bisa dihemat: **jangan panggil
`resolve` lalu `search` lagi**; dan kalau `search` responsnya sudah memuat
manga yang cocok, `series` dipanggil 1x. Steele: hitung dulu, jangan
asumsikan.

**(b) GABUNGKAN DUA FAN-OUT.** `series_merged` = `series_resolve_pref` +
`collect_series_across_sources`. Kalau keduanya bisa jalan dalam SATU fan-out
paralel (bukan dua giliran), cold path turun ~2x.

**(c) SHORT-CIRCUIT.** Kalau `collect_series_across_sources` sudah punya cache
hit untuk `title_key` itu, jangan fan-out ulang. (Periksa apakah sudah begitu
di implementasi sekarang — `series-union:{title_key}` menyimpan map per
sumber, dan `targets` di-filter sumber yang sudah ada di cache. Kalau sudah
benar, jangan diubah.)

**(d) PERPERSISIAN.** Kalau union tidak menambah episode apa pun (daftar union
== daftar primary), latency tidak boleh lebih buruk dari 1 sumber.

## Perilaku yang WAJIB tetap sama (regresi harus hijau)

- `/api/unified/series/komiku:6167` → **235 chapter**, max **277**, chapter
  `277` punya `source=shinigami` +
  `handle=shinigami:3b1eab91-4a88-4d5c-babe-f9cf40be1347`.
- `/api/unified/chapter/komiku:6167/232` → `next = {number "277", source
  "shinigami", handle "shinigami:3b1eab91-4a88-4d5c-babe-f9cf40be1347"}`.
- `/api/unified/chapter/komiku:6167/277` → 200, `source=shinigami`, 15 gambar,
  `switched_from=komiku`.
- `/api/unified/chapter/komiku:6426/1195` → `source=komiku` (chapter yang ADA
  di primary TIDAK boleh pindah sumber).
- `/api/unified/chapter/komiku:1284/121` → 200, images=84, next=122, prev=120.
- Partial failure tolerated: satu sumber gagal → sumber lain tetap hasil,
  sumber gagal dilaporkan di `failed` / `failed_sources`.
- Timeout per sumber tetap dipakai (`PER_SOURCE_TIMEOUT_SECS`, source.rs:9).

## Larangan

- TIDAK menambah dependensi baru.
- TIDAK mengubah trait `Source` (4 adapter ikut berubah —禁止).
- TIDAK menyentuh `komiku-web/**` (file-nya sedang dikerjakan sesi Hermes lain).
- TIDAK menyentuh `komik/core/tests/aggregator_units.rs` (dipakai lane lain).
  Test baru = file baru, mis. `komik/core/tests/union_perf_units.rs`.
- TIDAK mengubah `komik/core/src/union.rs` (milik Task 0, sudah direview).

## Metode (TDD, wajib)

1. Test RED dulu, lalu implementasi, lalu GREEN.
2. Test mengukur **jumlah request yang jatuh ke mock** (deterministik) —
   BUKAN assertion timing yang flaky. Pakai pola `Mock` yang sudah ada di
   `komik/core/tests/aggregator_units.rs` (counter `AtomicUsize` di
   `resolve_calls` / `series_calls`).
3. Test harus membuktikan jumlah request per sumber turun (mis. "4 sumber =
   N request, bukan 2N"), dan semua regresi di atas tetap hijau.
4. Semua test existing (124) harus tetap hijau.

## Worktree & build

- Worktree: `D:/wt/komik-perf` (branch `feat/cross-chapter-perf`, base
  `d6e1b43` = union + nav merged).
- JANGAN kerjakan di `D:/project` — dipakai sesi Hermes lain (file web dirty).
- Build: `cd D:/wt/komik-perf/komik && bash scripts/build.sh test`
  (WAJIB pakai script; `cargo` biasa bisa gagal LNK1104 di mesin ini).
- Kalau set `CARGO_TARGET_DIR`, pakai path NATIVE (`D:/wt/komik-perf/...`),
  BUKAN `/d/wt/...` — path MSYS bikin artifact nyasar ke `D:/d/wt/...`.

## Verifikasi wajib sebelum commit

1. `bash scripts/build.sh test` → semua hijau (sebut jumlah test).
2. **Live cold path**: jalankan server dari worktree di **PORT 8790** (JANGAN
   8788 — dipakai sesi lain), ukur `time_total` via curl untuk
   `/api/unified/series/komiku%3A6167` dan
   `/api/unified/chapter/komiku:6167/232`. Tulis angka SEBELUM vs SESUDAH
   (baseline di atas). Matikan server 8790 setelah selesai.
3. Cek juga `/api/unified/chapter/komiku:6426/1195` tetap `source=komiku`.

## Commit

Branch `feat/cross-chapter-perf`, pesan `perf(core): ...` gaya repo.
