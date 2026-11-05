# Laporan ulw-qa + Perbaikan — 2026-11-06

Ruang lingkup: semua perubahan perf (`24f547d`, `79bea5f`, `5b10041`) + perbaikan hasil QA (`0b516aa`).

Metode: 4 lane QA paralel dengan **metode berbeda** (bukan mengulang E2E yang sudah hijau), lalu 2 lane perbaikan, lalu verifikasi mandiri oleh koordinator.

## Lane QA & verdict

| Lane | Fokus | Metode | Hasil |
|---|---|---|---|
| A | Kontrak & kompatibilitas | curl matriks Accept/width, grep konsumen, round-trip JSON | **6/6 PASS** |
| B | State, race, kebocoran | probe Playwright + baca kode + hitung file cache | **1 FAIL**, sisanya PASS |
| C | Stress & resource | burst 8/16/32 paralel, RSS, throttle 4 Mbit/s, ukur bundle | **1 FAIL**, sisanya PASS |
| D | Regresi fitur | 39 check lintas permukaan + akun throwaway | **39 PASS / 0 FAIL** |

## Temuan yang diperbaiki

### F1 — `liteInflight` bocor permanen (lane B) → commit `0b516aa`

`backgroundSeriesLite` memanggil `unifiedApi.series()` tanpa timeout. Server yang tidak membalas membuat promise tak pernah settle → `.finally` tak jalan → entri `liteInflight` permanen → retry series untuk handle itu terblokir sampai reload.

Bukti lane B: probe route-menggantung, 2 chapter handle sama → `SERIES-HANG count = 1`.
Fix: `AbortController` + timeout 8 s + `clearTimeout` di `.finally`.
**Verifikasi mandiri:** `qaF1_verify.py` (proxy ber-thread, bukan `page.route`+`sleep`) → **1 → 2 request series** setelah timeout. PASS.

### F2 — chapter cold path tanpa single-flight (lane C) → commit `0b516aa`

16 request paralel ke chapter SAMA yang belum di-cache → **48 upstream call** (komiku +32, kiryuu +16). Pola yang sama sudah diperbaiki untuk `/unified/series` (`series_gate`) tapi belum untuk chapter.

Fix: `chapter_gates` + `chapter_cache` (TTL 120 s, cap 128) + `chapter_single_flight` dengan **double-check cache DI DALAM gerbang**. Kunci = `handle` + `chapter_number_key` (jadi `04` == `4`).

Catatan penting: percobaan pertama hanya menaruh double-check di closure pemanggil — **test menangkapnya**: 16 task tetap fan-out bergiliran (`hits = 16`, bukan 1). Mutex menyerialkan, tidak mendedupe. Helper harus menerima `cached` sebagai parameter.

**Verifikasi mandiri:** `qaF2_verify.py` → **48 → 3–7 upstream call**, 0 non-200. PASS.

### Perbaikan gate perf

`check_ratio` (WARM ≤ 60% COLD) tidak menangkap kebangkitan kerja per-request: kalau `probe_dims` kembali (warm ~900 ms vs cold ~1900 ms), rasio tetap PASS. Ditambah **P5: chapter WARM plafon absolut 300 ms** (terukur 1–3 ms).

## Temuan yang TIDAK diperbaiki (tercatat)

1. 55 file `.avif` basi di `data/imgcache/` — tidak terlayani (lookup selalu `.webp`), hanya disk.
2. `liteCache` tanpa eviction — ~40–60 KB per 200 series, tidak relevan.
3. `pick_cross_source_neighbors` dead_code di `komik/core/src/rank.rs:436` — sudah ada sejak `3b23fac`, bukan dari commit ini. CI tidak punya job clippy untuk `komik/`.
4. Bundle: `Reader` inline menambah ~41,7 KB gz ke jalur kritis Home. Trade-off untuk −300 ms dead gap; Home FCP di throttle 4 Mbit/s = 1036 ms.
5. TTFP di throttle: cold 444 → 1817 ms. Sisa biaya = transfer gambar, bukan jalur kritis klien.

## Gerbang regresi (semua hijau sebelum push)

| Gerbang | Hasil |
|---|---|
| `cargo test` komiku-server | **110/0** (5 tes baru single-flight) |
| `cargo test` komik-core | 201/0 |
| `cargo clippy --all-targets -- -D warnings` | bersih (hanya warning pre-existing di komik-core) |
| `tsc -b` | exit 0 |
| `npm run build` | ok, 92 modul, tanpa warning |
| `run-wiring-check.mjs` | 21/21 |
| `perf-eval.sh` | **5/5** (P5 baru) |
| `cross_chapter_union_e2e.py` | 16/16 |
| `reader_ux_e2e.py` | 34/34 |
| `readmark_e2e.py` | 18/18 |
| `chapter_offline_e2e.py` | 5/5 |

## Rilis

- Commit `0b516aa` di-push ke `origin/main`.
- **CI GitHub Actions TIDAK BISA JALAN**: annotation `"The job was not started because your account is locked due to a billing issue."` — semua workflow gagal 3–5 s tanpa satu pun step dieksekusi (termasuk `24f547d` sebelumnya). Bukan masalah kode.
- Image dibangun **lokal** dan di-push ke GHCR (multi-arch amd64+arm64) sebagai pengganti CI.
- Verifikasi **dari registry** (pull ulang, bukan build lokal): health 200, title benar, 4/4 sumber sehat, `image_sizes: []`, AVIF mati (`Accept: image/avif` → `image/webp`), warm chapter 3,6–3,8 ms.
