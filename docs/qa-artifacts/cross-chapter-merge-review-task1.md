# Review Task 1 — ringkasan final

**Commit:** `2631b2b` — `feat(core): union chapter di halaman series (series_merged + u_series)`
**Base:** `6f2121f` (Task 0 — fondasi union)
**Branch:** `feat/cross-chapter-union` · **Worktree:** `D:/wt/komik-union`
**Reviewer:** subagent review (read-only) · **Review read:** diff package diverifikasi identik dengan `git diff 6f2121f..2631b2b` (309 baris `+`/`-` sama persis; hanya konteks hunk yang beda) — tidak ada yang disembunyikan.

## Verdict

- Spec compliance: ✅
- Task quality: approved — tidak ada blocker; 2 temuan Important (non-blocking) + 6 Minor.

## Critical

tidak ada

## Important (2)

### IMP-1 — Fan-out union ditunggu sinkron sebelum respons; cold path halaman series bisa +10s

**Lokasi**
- `komik/core/src/aggregator.rs:697-699` — `collect_series_across_sources(&manga.title, Some(&manga.source), limit).await`
- `komiku-server/src/unified.rs:675-683` — `aggregator().series_merged(...).await` di dalam handler `u_series`

**APA yang sebenarnya**
`series_merged` memanggil API internal core
`Aggregator::collect_series_across_sources(&self, title: &str, skip_source: Option<&SourceId>, limit: u32) -> (Vec<SourceChapterList>, Vec<(SourceId, String)>)`
(`aggregator.rs:1135-1143`). Implementasinya melakukan fan-out ke **semua** sumber yang dikenal: `join_sources` (`aggregator.rs:1063-1093`) menypawn satu task per sumber di `tokio::task::JoinSet` dan membungkus tiap panggilan dengan `tokio::time::timeout(self.timeout, fut)`, di mana `self.timeout = Duration::from_secs(PER_SOURCE_TIMEOUT_SECS)` = **10 detik per sumber** (`komik/core/src/source.rs:9`, `aggregator.rs:303`). Fan-out itu **paralel**, jadi menambah **+10s** (bukan × jumlah sumber), tapi tetap satu round-trip network tambahan **setelah** primary selesai. Hasil union di-cache dengan key `series-union:{title_key}` dan TTL `DEFAULT_TTL` = **10 menit** (`komik/core/src/cache.rs:22`, tulis di `aggregator.rs:1230` via `cache_put`); karena `Aggregator::new` memakai `Cache::memory(DEFAULT_TTL)` (`aggregator.rs:302`) dan server unified membangun aggregator dengan `Aggregator::new(all_sources(client))` (`komiku-server/src/unified.rs:72-82`), cache union ini **memory per-proses** — hilang saat restart dan tidak dibagi antar-instance.

**Kenapa Important**
Ini bukan pelanggaran spec (union memang diminta; brief justru mensyaratkan `failed` berisi sumber yang gagal), tetapi ini **risiko latensi utama endpoint ini** dan tidak diukur sama sekali di laporan Task 1. Endpoint `/api/unified/series/{handle}` tadinya hanya menyentuh satu sumber (primary) dengan fallback berurutan; sekarang ia menyentuh semua sumber sekaligus. Handler tidak punya batas waktu total untuk fase union — timeout 10 detik adalah batas **per sumber**, dan `join_sources` menunggu **semua** task selesai sebelum kembali.

**Dampak nyata ke user**
- Buka halaman series untuk judul yang belum pernah ter-cache: respons tertahan sampai fan-out union selesai — paling lama ~10 detik tambahan kalau ada sumber yang timeout/lambat. Di koneksi mobile lambat ini terasa jelas sebagai halaman kosong/loading panjang.
- Setelah title itu ter-cache (10 menit, per-proses), permintaan berikutnya untuk title yang sama jauh lebih cepat (hanya primary + cache union hit).
- Restart/deploy server (atau load-balanced multi-instance) mengembalikan seluruh title ke cold path — user bisa mengulang +10s untuk title yang sama setelah restart.
- Catatan: `failed_sources` yang muncul di respons **adalah** penanda bahwa sebagian sumber gagal — user melihat union tidak lengkap tanpa tahu sumber mana yang hilang (hanya daftar id sumber, tanpa pesan error).

**Rekomendasi: terima-sebagai-tradeoff sekarang + follow-up (bukan blocker Task 1)**
1. Follow-up: ukur p95/p99 latensi cold path `/api/unified/series/{handle}` di produksi sebelum dan sesudah Task 1, supaya/+10s ini jadi angka, bukan dugaan.
2. Follow-up (opsional): batas waktu **total** untuk fase union — kalau fan-out melewatimisal 3–4 detik, pakai hasil union yang sudah terkumpul (partial) dan sisanya tandai `failed`.Butuh perubahan core di luar owner files Task 1, jadi harus task terpisah.
3. Fix ringan kalau mau: sertakan pesan kegagalan (bukan hanya id sumber) di `failed_sources` atau field terpisah, supaya user bisa diberi tahu episode mana yang kemungkinan hilang. Tidak wajib untuk rilis.

### IMP-2 — Arti `from_cache` menyempit: dari "seluruh respons dari cache" jadi "detail primary saja"

**Lokasi**
- `komik/core/src/aggregator.rs:709` — `from_cache: outcome.from_cache` di dalam `MergedSeries { … }`
- `komiku-server/src/unified.rs:697` — `"from_cache": merged.from_cache` di JSON respons `u_series`

**APA yang sebenarnya**
`MergedSeries.from_cache` disalin apa adanya dari `SeriesOutcome.from_cache` hasil `series_resolve_pref`. Dan `SeriesOutcome.from_cache` bernilai `true` **hanya** bila cache key `series:{source}:{handle}` hit — yaitu cache **detail primary** saja (`aggregator.rs:589-593`: `if let Some(hit) = cache.fresh_json::<SeriesDetail>(&key) { return Ok(SeriesOutcome { detail: hit, from_cache: true }); }`). Cache **union** punya key terpisah (`series-union:{title_key}`, `aggregator.rs:1145`) yang status hit-nya **tidak diekspos** sama sekali — `collect_series_across_sources` mengembalikan hanya `(lists, failed)`, tanpa flag cache. Jadi ketika `from_cache = true`, baris-baris union bisa saja **fresh dari network**, dan sebaliknya `from_cache = false` tidak berarti seluruh respons fresh.

**Kenapa Important**
Field JSON `from_cache` ada di kontrak lama dan sekarang punya **makna berbeda**, tanpa penanda apa pun di kontrak header file (`komiku-server/src/unified.rs:10-16` menyebut `from_cache:bool` tanpa menjelaskan cakupannya). Kontrak yang berubah diam-diam = sumber kebingungan nanti, dan `from_cache` justru field yang biasa dipakai tooling/monitoring untuk mengukur efektivitas cache.

**Dampak nyata ke user**
- **Tidak ada kerusakan yang terlihat hari ini**: tidak ada konsumen web yang membaca field ini — `UnifiedSeries` di `komiku-web/src/types.ts:78-84` tidak mendeklarasikan `from_cache` sama sekali, dan `UnifiedChapterOut` (`:71-76`) juga tidak. Jadi user tidak melihat apa pun yang salah.
- Risiko nyata ada di lapisan observability: monitoring/alerting yang memakai `from_cache=true` sebagai proxy "respons dilayani cache" akan **salah baca** — respons `from_cache=true` bisa saja separuh barisnya baru diambil dari jaringan, dan `from_cache=false` bisa saja seluruh union-nya dari cache.
- Risiko lanjutan: kalau task berikutnya menambahkan field turunan dari `from_cache` (mis. "hasil union stale"), maknanya akan diwarisi dan salah tafsir makin dalam.

**Rekomendasi: terima-sebagai-tradeoff sekarang + follow-up (bukan blocker Task 1)**
1. Follow-up: perjelas cakupannya di kontrak header `komiku-server/src/unified.rs` — misalnya `from_cache:bool` → "hanya detail primary". Perubahan komentar, nol risiko fungsional.
2. Follow-up (opsional, breaking): rename jadi `primary_from_cache` (atau tambah `union_from_cache`) di rilis kontrak berikutnya, kalau ada konsumen eksternal/tooling yang mulai bergantung.
3. Fix sekarang **tidak** perlu: field tetap ada, backward compatible, dan tidak ada konsumen yang rusak. Yang berbahaya justru mengubahnya sekarang tanpa penanda.

## Minor

- `komik/core/src/aggregator.rs:697-699` — filter `source` (`--source`) dihormati untuk **primary** (`series_resolve_pref` menerimanya), tapi **diabaikan untuk pengumpulan union**: `collect_series_across_sources` tidak punya parameter filter sumber (`:1135-1143`), jadi union tetap menyapu semua sumber. Tidak ada caller yang kena sekarang (`u_series` selalu mengirim `None`, `unified.rs:675-683`), tapi asimetri ini akan menggigit saat CLI/endpoint baru memakai filter.
- `komik/core/src/aggregator.rs:200-207` — `MergedSeries` menambah field `from_cache` di luar struct 3-field yang tertulis di brief. Justru perlu agar Deliverable B ("`from_cache` tetap diteruskan") bisa dipenuhi, dan sudah didokumentasikan (Concern #3 laporan Task 1). Diterima, asalkan renaming seperti IMP-2 tidak dilakukan diam-diam.
- `komik/core/src/aggregator.rs:701-707` + `komiku-server/src/unified.rs:66` — `limit` (2000) diterapkan **per sumber**, union tidak punya plafon global → payload bisa ~4× limit untuk manga sangat panjang (One Piece dsb). Sudah dicatat di Concern #2 laporan Task 1. Tidak ada truncation union di level ini — disengaja (memotong episode eksklusif justru merusak tujuan union), tapi layak dipantau.
- `komik/core/src/aggregator.rs:707` — dedup `chapter_number_key` juga berlaku **di dalam** daftar primary, bukan hanya lintas sumber (`komik/core/src/union.rs:42-47`: satu `HashSet` untuk semua list). Jadi chapter yang label-nya berduplikasi pada satu sumber ("Extra"/"Extra", "1"/"01") kini hilang diam-diam; endpoint lama menampilkan apa adanya. Dampak rendah (adapter besar sudah unik), konsekuensi tak langsung dari merge Task 0.
- `komiku-server/scripts/build.sh:29` — skrip meneruskan `"$@"` ke `cargo build`, jadi `bash scripts/build.sh check` (perintah verifikasi di brief) memang tidak bisa jalan. **Pre-existing, bukan bawaan Task 1.** Implementer memakai `build` penuh + `cargo test` (superset dari `check`) — sah.
- `komiku-web/src/types.ts:71-76` — `UnifiedChapterOut` belum mendeklarasikan `source`/`handle` → dua field baru itu **inert** bagi klien sekarang. Web = taboo untuk plan ini, jadi diterima; butuh follow-up kalau badge sumber / handle per-chapter mau dipakai (mis. menampilkan asal episode eksklusif dari sumber lain).

## ⚠️ Cannot verify from diff

- **Hasil test (core 40+4+9, server 62)** — tidak saya jalankan ulang (sesuai aturan review read-only). Sebagai ganti, kelayakan statik diverifikasi: `Mock` mengimplementasikan 8 metode wajib `Source`; `async-trait` sudah jadi dependency `komik-core` (`Cargo.toml`, tanpa dependency baru); `Aggregator::new(Vec<Arc<dyn Source>>)` cocok; `pub mod union;` ada di `komik/core/src/lib.rs:7`; field `MergedChapter` yang dibaca `ChapterRow::from` (`komik/core/src/union.rs:14-24`) cocok semua dengan yang di-isi `From<&MergedChapter>` (`unified.rs:145-155`). Alur mock ditelusuri manual: `resolve` default → `search` → `title_key` cocok "chainsaw man"; mock gagal menghasilkan `SourceError::Other` (bukan conclusive) → masuk `failed`, konsisten dengan assertion test.
- **Verifikasi live HTTP (235 chapter, 277 muncul, handle shinigami, 277 terbaca 200)** — bukti runtime dari laporan Task 1; jalur kode handler→JSON saya verifikasi dengan membaca kode, angka live tidak bisa saya konfirmasi tanpa menjalankan server.
- **Server benar-benar compile terhadap core worktree** — terverifikasi statis: `komiku-server/Cargo.toml:27` → `komik-core = { path = "../komik/core" }` (relatif, jadi core worktree), dan output compile di laporan menunjuk path `D:\wt\komik-union\komik\core`.
- **"0 warning"** — tidak terverifikasi (butuh run build).
- **Total union live: 235 vs 234 di plan** — wajar: dedup by `chapter_number_key` menggabungkan nomor yang overlap; hitungan = 232 (komiku) + 2 (shinigami, mis. 233 & 277) + 1 (mangaku). Target plan "max 277" tercapai.

## Bukti verifikasi klaim implementer (spec compliance)

| Klaim | Hasil | Bukti |
|---|---|---|
| (a) `u_series` pakai union | ✅ | `komiku-server/src/unified.rs:675-683` → `series_merged`; `:685` map `merged.chapters` |
| (b) `ChapterRow` field lama utuh + 2 baru | ✅ | `unified.rs:134-143` (`number,title,native_id,updated_at` + `source,handle`) |
| (c) `failed_sources` = sumber gagal union | ✅ | `unified.rs:692-696` ← `merged.failed` (id sumber saja) |
| (d) `source` top-level = primary | ✅ | `unified.rs:690` ← `merged.manga.source` |
| (e) primary di urutan pertama → menang dedup | ✅ | `aggregator.rs:701-703` `push(primary)` lalu `extend(others)`; `merge_chapter_lists` first-seen-wins (`union.rs:45`) |
| (f) tanpa `use` baru di aggregator.rs | ✅ | `git show 2631b2b -- aggregator.rs \| grep '^[+-]use '` → kosong; pakai `crate::union::…` full path |

Global Constraint: TDD ✅ (file test baru, 4 skenario persis Deliverable C) · identitas string-based ✅ (lewat `merge_chapter_lists` → `chapter_number_key`, tanpa f64) · backward compatible ✅ (field JSON lama utuh) · web tidak disentuh ✅ · partial failure ✅ · tanpa dependensi/file baru di luar owner files ✅.

Lane hygiene: hunk Task 1 = `aggregator.rs @@189/@@645`; Task 2 = `@@847/@@1390/@@1409` — tanpa overlap; HEAD (`d6e1b43`) bersih tanpa conflict marker. `union.rs`/`lib.rs` tak tersentuh sejak Task 0.

---

*Tidak ada file repo yang saya ubah saat menyusun laporan ini — working tree, index, HEAD, dan branch tidak disentuh. Review read-only.*
