# Audit Responsif & Aksesibilitas — Halaman Detail Series Komik Hub

**Tanggal:** 2026-10-30
**Target:** `/manga/:handle` — `SeriesUnified.tsx` (handle `sumber:native_id`) dan `Series.tsx` (id numerik legacy)
**Build yang diuji:** `dist/` (production, served oleh Rust `:8788`), commit `fe6a8d7`
**Data uji:** One Piece (`shinigami:one-piece`, 1224 chapter) + judul panjang 49 karakter (`shinigami:5ddf5f28…`, 205 chapter)
**Metode:** Chrome 155 headless via CDP `Emulation.setDeviceMetricsOverride`, pengukuran DOM (`getBoundingClientRect`, `scrollWidth`, `Range.getClientRects`), `Accessibility`/tab-order nyata, dan komputasi rasio kontras WCAG dari nilai token ter-resolve. Transisi CSS dimatikan saat sampling warna (lihat §Catatan metode).

---

## Ringkasan Eksekutif

Ditemukan **7 cacat**, 3 di antaranya berdampak langsung ke tugas utama pengguna (memilih & memulai chapter). Yang paling serius bukan sekadar "tampilan kurang rapi": pada 320 px — lebar iPhone SE / Android kecil yang masih umum — **tombol aksi utama menyusut jadi 46,5 px dan teksnya pecah 3 baris**, sementara halaman **bisa digeser horizontal 20 px** karena bilah aksi meluber keluar viewport.

| # | Cacat | Severity | Dampak |
|---|-------|----------|--------|
| 1 | Bilah aksi (Baca/Maraton/Unduh/Favorit) meluber → scroll horizontal 20 px di 320 px | **High** | Layout rusak, konten terpotong di perangkat 320 px |
| 2 | CTA utama menyusut 46,5 px & teks 3 baris pada 320–390 px | **High** | Label "Lanjut · Chapter 1190" nyaris tak terbaca; target ketuk menyempit |
| 3 | Bilah aksi sticky menutupi 4–5 baris chapter saat scroll | **Medium** | Baris chapter tak bisa dibaca/diketuk selama scroll |
| 4 | Kontras teks di bawah AA (7 elemen terang, 2 gelap) | **Medium** | Teks sekunder & CTA sulit dibaca, khususnya low-vision |
| 5 | Zoom teks 200% → overflow horizontal 110–180 px (gagal WCAG 1.4.4) | **Medium** | Pengguna low-vision kehilangan konten |
| 6 | Latar hero berhenti 18,7 px sebelum konten (desktop) | **Low** | Garis potong visual di bawah meta |
| 7 | Baris chapter bergeser 1 px saat anchor dipilih (mode unduh) | **Low** | Geseran halus; risiko salah ketuk pada tap beruntun |

**Tidak ditemukan** (diverifikasi, bukan diasumsikan): heading skip level, landmark hilang, `<img>` tanpa `alt` pada gambar bermakna, fokus keyboard tak terlihat, dan target sentuh di bawah 24 px (selain 2 item dekoratif/teks).

---

## 1. [HIGH] Bilah aksi meluber → scroll horizontal di 320 px

**Terukur:** `document.documentElement.scrollWidth = 340` vs `clientWidth = 320` → **overflow 20 px**, dan benar-benar dapat digeser (`window.scrollTo(9999,0)` menghasilkan `scrollX = 20`). Halaman legacy `/manga/6426` lebih parah: **22 px**.

**Elemen penyebab** (satu-satunya elemen tak ter-clip di luar viewport):

```
button "Favorit" — left 251.8, right 339.6 (lebar 87.8), position static, overflow visible
```

**Akar masalah** — kontainer `flex` tanpa `flex-wrap`, berisi 3 tombol `shrink-0`:

| Anak | flex-shrink | Lebar |
|---|---|---|
| CTA Baca (`flex-1`) | 1 | 46,5 |
| Maraton | 1 | 78,3 |
| Unduh (`shrink-0`) | 0 | 87,0 |
| Favorit (`shrink-0`) | 0 | 87,8 |

Total kebutuhan **323,6 px** (termasuk 3×8 px gap) vs ruang tersedia **288 px** → defisit **35,6 px**. Karena Unduh + Favorit tidak boleh menyusut (253,1 px terkunci) dan CTA sudah di batas minimum, sisanya meluber keluar.

**Ambang pecah** (diukur per 20 px):

| Viewport | Overflow X | Lebar CTA | Baris teks CTA |
|---|---|---|---|
| 300 | 40 px | 46,5 | 3 |
| **320** | **20 px** | **46,5** | **3** |
| 340 | 0 | 46,5 | 3 |
| 360 | 0 | 50,9 | 3 |
| 375 | 0 | 65,9 | 3 |
| 390 | 0 | 80,9 | 3 |
| 412 | 0 | 102,9 | 2 |
| 480 | 0 | 170,9 | 1 |

Artinya: **overflow berhenti di 340 px, tetapi CTA tetap tertekan sampai 412 px.** Dua gejala, satu akar.

**Perbaikan yang disarankan:** beri `flex-wrap` pada baris, atau pindahkan Unduh + Favorit ke baris kedua / jadikan ikon-saja di bawah `sm`. Minimal: `min-w-0` pada CTA + `flex-wrap` pada kontainer, lalu uji ulang di 320 px.

---

## 2. [HIGH] CTA utama menyusut & teks pecah 3 baris (320–390 px)

**Terukur pada 320 px**, state "sudah pernah baca" (label terpanjang):

```
teks   : "Lanjut · Chapter 1190"
tombol : 46,5 × 78,5 px
baris  : 3 (lebar baris: 42 / 47 / 31 px)
line-height 19,5 px → konten 58,5 px
```

Di 360 px: 50,9 px / 3 baris. Di 390 px: 80,9 px / 3 baris. Baru di **412 px** turun ke 2 baris, dan **480 px** menjadi 1 baris.

**Mengapa ini penting:** tombol ini adalah jalur utama "lanjut baca". Pada 320 px label dirender dalam kolom 46,5 px — lebih sempit dari kata "Chapter" — sehingga terbaca sebagai tumpukan suku kata, bukan label aksi. Tinggi bilah ikut membengkak dari 64 px (desktop) → **101 px** (mobile), memakan ruang layar.

**Anggaran chrome vertikal** (terukur):

| Viewport | Header | Bilah sticky | Nav bawah | Total | % viewport |
|---|---|---|---|---|---|
| 320×568 | 57 | 101 | 52 | **209** | **36,8%** |
| 390×844 | 57 | 101 | 52 | 209 | 24,8% |

Pada 320×568 hanya **359 px** tersisa untuk konten. Dengan judul panjang, daftar chapter baru muncul di `y=513` sementara nav bawah di `y=516` → **hanya 1 baris chapter terlihat di lipatan** (vs 3 baris bila judul pendek).

---

## 3. [MEDIUM] Bilah sticky menutupi baris chapter saat scroll

**Terukur** pada 390×844, `position: sticky`, `top: 56px`:

| scrollY | bar bottom | baris pertama terlihat | baris tertutup |
|---|---|---|---|
| 400 | 157 | top 6 | 4 |
| 900 | 157 | top −4 | 4 |
| 1600 | 157 | top −42 | 5 |

Bilah setinggi **101 px** menutupi 4–5 baris chapter sekaligus selama scroll. Baris-baris itu tetap ada di DOM dan tetap bisa difokus keyboard (diverifikasi: 29 baris difokus, **0** tertutup saat auto-scroll fokus), jadi ini murni masalah visual/ketuk — bukan aksesibilitas keyboard. Namun untuk interaksi sentuh, baris di bawah bilah tidak bisa diketuk sampai pengguna menggulir ulang.

**Catatan:** `top: 56px` vs tinggi header **57 px** → overlap 1 px (`gap: −1`). Kecil, tapi menunjukkan offset hardcoded yang tidak terikat ke tinggi header sebenarnya.

---

## 4. [MEDIUM] Kontras teks di bawah WCAG AA

Dihitung dari nilai token ter-resolve (bukan perkiraan), ambang AA: 4,5:1 teks normal, 3:1 teks besar.

**Mode terang — 7 kegagalan:**

| Teks | Rasio | Butuh | Ukuran | Warna |
|---|---|---|---|---|
| "← Beranda" | **2,85:1** | 4,5 | 12 px / 500 | `ink-400` #8a929d di `ink-950` |
| "Terbaru dari komiku" | **3,14:1** | 4,5 | 10,5 px / 500 | `ink-400` di putih |
| "Komiku" (badge sumber) | **3,14:1** | 4,5 | 11,5 px / 400 | `ink-400` di putih |
| "Penulis" (label) | 4,15:1 | 4,5 | 12 px / 400 | `ink-500` #6f7681 di `ink-950` |
| "(1224)" | 4,15:1 | 4,5 | 13 px / 600 | `ink-500` di `ink-950` |
| "Baca Chapter 1" (CTA) | 4,41:1 | 4,5 | 13 px / 700 | `ink-950` di `brand` #0077b6 |
| "Maraton" | 4,41:1 | 4,5 | 13 px / 600 | `brand` di `ink-950` |

**Mode gelap — 2 kegagalan:**

| Teks | Rasio | Butuh | Penyebab |
|---|---|---|---|
| "Baca Chapter 1" (CTA) | **3,54:1** | 4,5 | teks `ink-950` = #1a1b1e di atas `brand` #0077b6 |
| "Maraton" | **3,54:1** | 4,5 | `brand` #0077b6 di atas `ink-950` #1a1b1e |

**Akar masalah:** `brand-amber` (#0077b6) dipakai sebagai **warna teks** dan **latar tombol** sekaligus. Di mode terang, teks `ink-950` (#f1f4f7) di atasnya hanya 4,41:1; di mode gelap token `ink-950` berubah jadi #1a1b1e sehingga rasio turun ke 3,54:1. Putih murni di atas #0077b6 = 4,87:1 (lolos) — jadi memperbaiki CTA cukup dengan warna teks eksplisit, bukan mengubah brand.

`ink-400` (#8a929d) hanya 2,85:1 di latar halaman dan 3,14:1 di kartu putih — di bawah AA untuk semua ukuran teks yang dipakai.

---

## 5. [MEDIUM] Zoom teks 200% → overflow horizontal (gagal WCAG 1.4.4)

Root `font-size` dinaikkan ke 32 px (setara zoom teks 200%):

| Viewport | Overflow X | Elemen meluber |
|---|---|---|
| 320×568 | **180 px** | `h1`, badge sumber, `dt` label, CTA |
| 390×844 | **110 px** | badge sumber, `dt` label, CTA |
| 768×1024 | 0 | — |

Bilah CTA ikut membengkak ke **140,5 px** tinggi dengan tombol 98,5 px. Ini kegagalan **WCAG 1.4.4 (Resize Text)** — pengguna yang memperbesar teks kehilangan konten secara horizontal. Karena layout memakai `max-w-3xl` + flex tanpa wrap, pembesaran teks tidak punya jalur reflow.

---

## 6. [LOW] Latar hero berhenti sebelum kontennya (desktop)

Latar blur `h-56` (224 px) bersifat `absolute` di dalam hero yang tingginya ditentukan konten:

| Viewport | Tinggi latar | Tinggi konten | Selisih |
|---|---|---|---|
| 320 / 360 / 390 | 224 | 221,3 | −2,7 (aman) |
| 768 / 1280 | 224 | 242,7 | **+18,7 px** |

Di ≥768 px, konten hero 18,7 px lebih tinggi dari latar → gradasi berhenti mendadak dan menyisakan pita latar halaman di bawah meta. Tidak merusak fungsi, tapi terlihat sebagai garis potong.

---

## 7. [LOW] Baris chapter bergeser 1 px saat anchor dipilih

Pada mode unduh (`pickMode`), baris anchor mendapat `border border-brand-amber`. Border 1 px **menambah tinggi kotak** (bukan `outline`/`ring-inset`):

```
tinggi baris anchor : 44,5 → 45,5 px  (+1,0)
posisi baris sesudah: +1,0 px
```

Setiap kali anchor berpindah, seluruh daftar di bawahnya bergeser 1 px. Dampaknya kecil, tetapi pada pola "tap baris Awal lalu Akhir" pergeseran ini terjadi **tepat di antara dua ketukan** — berpotensi membuat ketukan kedua mendarat di baris yang salah jika daftar sedang di tepi. `Series.tsx` sudah benar memakai `ring-1 ring-inset`; `SeriesUnified.tsx` memakai `border` — jadi ini inkonsistensi antara dua halaman, bukan keterbatasan teknis.

---

## Yang diverifikasi AMAN (bukan asumsi)

Agar laporan ini tidak menuduh tanpa bukti, berikut diperiksa dan **tidak** ditemukan masalah:

- **Struktur heading:** `H1` (judul series) → `H2` (Chapter) — tidak ada level yang dilompati.
- **Landmark:** tepat 1 `<main>`, 1 `<nav>`, 1 `<header>`; `lang="id"` benar.
- **Alt text:** gambar sampul punya `alt` = judul; latar blur dekoratif `alt=""` (benar).
- **Fokus keyboard:** 12 langkah Tab nyata semuanya menampilkan outline UA 1 px; tidak ada `outline: none` yang menghapus indikator.
- **Target sentuh:** hanya 2 elemen < 24 px — logo (104,9×23, dekoratif, ada `aria-label`) dan link "← Beranda" (60,2×16). Sisanya ≥ 40 px.
- **Baris chapter:** tinggi 43,5 px (≥ 44 px praktis), label `aria-label` menyebut status "sudah/belum dibaca".
- **`aria-pressed`** pada tombol Unduh & anchor sudah benar.
- **Tinggi bilah seleksi range stabil** (77,3 px sebelum & sesudah tap) — tidak ada pergeseran daftar saat memilih rentang. Slot hint memang sengaja dipesan.

---

## Catatan metode (penting untuk reproduksi)

1. **Transisi CSS harus dimatikan saat sampling warna.** Pada tab headless `document.hidden === true`, animasi/transisi CSS dibekukan, sehingga `getComputedStyle(body).backgroundColor` bisa mengembalikan nilai *lama* (mis. tetap terang setelah `.dark` dipasang). Pengukuran pertama saya sempat menunjukkan "mode gelap rusak total" — itu **artefak headless, bukan bug**. Setelah transisi dinonaktifkan, latar mode gelap benar (#1a1b1e). Angka kontras di laporan ini diambil dari kondisi transisi-mati.
2. **Sesi browser bersama dapat dinavigasi proses lain.** Pengukuran awal sempat mendarat di halaman berbeda; setiap batch final menyertakan penjaga `location.pathname` dan assertion.
3. **Scrollbar headless memakan 8 px** dari lebar CSS. `Emulation.setScrollbarsHidden(true)` dipakai agar `clientWidth` = lebar viewport sesungguhnya (kondisi mobile).
4. `captureScreenshot` timeout pada halaman 1224 chapter; audit dilakukan text-first lewat DOM, bukan analisis gambar.

## Rekomendasi prioritas

1. **Perbaiki bilah aksi (cacat 1 & 2 sekaligus).** `flex-wrap` pada kontainer + `min-w-0` pada CTA, atau sembunyikan label Unduh/Favorit di bawah `sm`. Target: 0 overflow di 320 px dan CTA ≥ 1 baris di 360 px.
2. **Naikkan kontras** `ink-400` → `ink-500` untuk teks sekunder, dan set warna teks CTA eksplisit (putih murni di atas `brand`, bukan `ink-950` yang berubah antar tema).
3. **Samakan `border` → `ring-inset`** pada baris anchor `SeriesUnified.tsx` agar konsisten dengan `Series.tsx`.
4. **Uji regresi** di 320/360/390/412 px + zoom teks 200% sebagai bagian dari gate rendered-surface yang sudah ada.

---

*Semua angka dalam laporan ini dihasilkan oleh skrip pengukuran dan tersimpan di workspace audit (`summary.json`, `breakpoint.json`, `contrast.json`, `fold.json`, `hero.json`, `legacy.json`, `zoom.json`).*
