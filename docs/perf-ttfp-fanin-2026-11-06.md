# Fan-in Verification — Percepatan Mulai Baca (ulw-perf)

Tanggal: 2026-11-06 · Basis: `komik-perf-rencana.md` (audit 5 domain, TTFP = navigasi → halaman manga pertama terpaint)

## Status lane

| Lane | File | Fix | Status |
|---|---|---|---|
| S1 | `komiku-server/src/unified.rs` | buang `probe_dims` → `image_sizes: []` | **SELESAI + terverifikasi live** |
| S2 | `komiku-server/src/img.rs` | matikan AVIF (selalu WebP) | **SELESAI + terverifikasi live** |
| S3 | `komik/core/src/aggregator.rs` (+ test) | neg-cache kegagalan union (TTL 60 s) | **SELESAI + 2 tes baru** |
| W1 | `komiku-web/src/readerSource.ts` | series keluar jalur kritis | **SELESAI + terverifikasi** |
| W2 | `komiku-web/src/App.tsx` | import statis Reader (hapus dead gap) | **SELESAI + terverifikasi** |
| — | `komiku-web/src/downloadStore.ts` | hapus `import('./pages/Reader')` yang jadi no-op | **SELESAI (bonus)** |

## Angka terukur (server live 8788, LAN)

| Metrik | Baseline audit | Sesudah | Δ |
|---|---|---|---|
| Warm `/api/unified/chapter` | 311 ms (dari 471,8 ms warm+probe) | **3 ms** | **−99 %** |
| Cold TTFP (browser, 3 run) | 946 ms (median) | **130 ms** (153/126/130) | **−86 %** |
| Warm TTFP (browser) | 393 ms | **114 ms** (114/115/92) | **−71 %** |
| Dead gap (mount → fetch chapter) | 289–309 ms | **81 ms** (79–97) | **−73 %** |
| True cold TTFP | 2 157 ms | 1 966 / 2 777 / 3 862 ms | lihat catatan¹ |
| Request per buka chapter | 14 | **10–12** | −2…−4 |
| `/img` dengan `Accept: image/avif`, w=320 | `image/avif` | **`image/webp`** | AVIF mati |

¹ True cold masih didominasi latensi upstream shinigami (chapter `dur` 1 225–2 088 ms, series 1 562–2 106 ms). `series` **tidak lagi** menentukan paint: pada run 2 & 3 chapter selesai lebih dulu (1 318 vs 1 789 ms; 1 854 vs 2 209 ms) dan paint mengikuti chapter, bukan series. Sisa waktu = fan-out upstream, bukan jalur kritis klien.

## Bukti per lane

- **S1** — `GET /api/unified/chapter/komiku:354295/41` → `image_sizes: []`, `pages 58`. Latensi warm 3,1–13,9 ms (4 run). Kontrak klien utuh: `readerSource.ts` & `ReaderMarathon.tsx` memakai `?? null`, `Reader.tsx` `.map()` atas array kosong.
- **S2** — `curl -H "Accept: image/avif,image/webp,image/*"` di w=320 dan w=900 → `content-type: image/webp` keduanya. `x-img-cache: hit`. Tes unit `avif_dimatikan_selalu_webp` mengunci 12 kombinasi.
- **S3** — `cargo test` komik-core: `collect_warm_tidak_mengulang_sumber_yang_gagal_saat_cold` (warm tidak memanggil ulang sumber gagal, tapi tetap melaporkannya di `failed`) + `collect_penanda_gagal_kedaluwarsa_setelah_negative_ttl` (dilewati di dalam TTL, dicoba lagi setelahnya).
- **W1** — proxy ber-thread menahan `/api/unified/series` 6 s: paint **181 ms**, toolbar `Lookism · 3%` (judul dari `series_title` respons chapter), 117 gambar tetap termuat setelah series selesai.
  Catatan metodologi: probe pertama (`_w1_stall_series_probe.py`, `time.sleep` di `page.route`) melaporkan paint 6 200 ms — itu **artefak**, handler route memblokir event loop Playwright sehingga `page.evaluate` ikut tertahan. Yang sah adalah probe proxy.
- **W2** — fetch chapter mulai 81 ms (sebelumnya 384–386 ms). Chunk `Reader-*.js` hilang dari `dist/assets` (menyatu ke `index-*.js`, 145,95 kB / 42,11 kB gz); `ReaderMarathon` tetap chunk terpisah.

## Gerbang regresi

| Gerbang | Hasil |
|---|---|
| `komik` suite Rust | **201 lulus, 0 gagal** (sebelumnya 195; +2 tes S3, +lainnya) |
| `npm run build` | lulus, 92 modul, **tanpa warning** (warning `INEFFECTIVE_DYNAMIC_IMPORT` hilang setelah `downloadStore` dirapikan) |
| `run-wiring-check.mjs` | **21/21** |
| `perf-eval.sh 8788 3` | **PASS 4/4** (series cold 1 946 ms ≤ 5 160; chapter cold 992 ms ≤ 2 252; series warm 3 ms; chapter warm 3 ms) |
| `cross_chapter_union_e2e.py` | **16/16** |
| `reader_ux_e2e.py` | **34/34** |
| `chapter_picker_e2e.py` | **22/22** |
| `readmark_e2e.py` | **18/18** |
| `chapter_offline_e2e.py` | **5/5** (skrip diperbaiki — lihat di bawah) |
| `download_range_e2e.py` | **14/14** |

## Temuan tambahan (bug di TES, bukan produk)

`chapter_offline_e2e.py` selalu FAIL 3/4 karena masih mencari
`button[aria-label="Simpan untuk dibaca offline"]` **di toolbar**. Sejak commit
`c951fd2` aksi itu pindah ke sheet **Preferensi** sebagai baris `Row`
(`role="button"`, tanpa `aria-label`) dan sheet-nya dibuka lewat
**Menu → Preferensi**. Skrip diperbarui ke permukaan yang benar → 5/5 PASS.
Jangan "memperbaiki" produk dengan memasang tombol balik ke toolbar.

## Sisa / belum dikerjakan

- **`parse_img_dims` masih tidak mengenali WebP `VP8 `/`VP8L`** (temuan H3 audit). Sekarang tidak berdampak karena probe dibuang; relevan hanya kalau `image_sizes` nanti di-cache per chapter (Fix B). Fungsi `probe_dims` disimpan dengan `#[allow(dead_code)]`.
- **CLS**: `image_sizes` kosong membuat `knownRatios` tak terisi untuk chapter WebP. Terukur tidak berubah (0,0244 vs 0,0240) karena `ComicImage` punya `fallbackRatio` 0,685.
- Perubahan belum di-commit (6 file + 1 skrip E2E).
