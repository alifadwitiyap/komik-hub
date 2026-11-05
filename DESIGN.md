---
name: Komik Hub
description: Union lintas-sumber pembaca komik — fungsional, tenang, biru Komiku+.
colors:
  primary: "#0077b6"
  primary-soft: "#4d9fd6"
  primary-dim: "#b3d9ef"
  accent: "#935bab"
  accent-dark: "#784290"
  accent-soft: "#eedcff"
  surface-page: "#f1f4f7"
  surface-card: "#ffffff"
  surface-elevated: "#eef1f5"
  border: "#e3e7ec"
  ink-hint: "#c6ccd4"
  ink-muted: "#9aa2ac"
  ink-secondary: "#6f7681"
  ink-body: "#2b3340"
  ink-strong: "#161c26"
  healthy: "#15803d"
  warn: "#b45309"
  danger: "#b91c1c"
  night: "#282828"
  night-dark: "#131313"
typography:
  display:
    fontFamily: "'BR Hendrix', 'Nunito Sans', ui-sans-serif, system-ui, sans-serif"
    fontWeight: 600
  body:
    fontFamily: "'Nunito Sans', ui-sans-serif, system-ui, -apple-system, 'Segoe UI', sans-serif"
    fontWeight: 400
  label:
    fontFamily: "'Nunito Sans', ui-sans-serif, system-ui, sans-serif"
    fontWeight: 700
rounded:
  md: "6px"
  lg: "8px"
  xl: "12px"
  xl2: "16px"
  pill: "9999px"
spacing:
  xs: "4px"
  sm: "8px"
  base: "10px"
  md: "12px"
  lg: "16px"
components:
  button-primary:
    backgroundColor: "{colors.primary}"
    textColor: "{colors.ink-strong}"
    typography: "{typography.label}"
    rounded: "{rounded.xl}"
    padding: "12px 16px"
  button-primary-hover:
    backgroundColor: "{colors.primary-soft}"
  button-outline:
    backgroundColor: "transparent"
    textColor: "{colors.primary}"
    rounded: "{rounded.xl}"
    padding: "10px 14px"
  card-manga:
    backgroundColor: "{colors.surface-card}"
    rounded: "{rounded.md}"
    padding: "10px"
  card-row:
    backgroundColor: "{colors.surface-card}"
    rounded: "{rounded.xl}"
    padding: "10px"
  nav-item:
    backgroundColor: "transparent"
    textColor: "{colors.ink-secondary}"
  select:
    backgroundColor: "{colors.surface-card}"
    textColor: "{colors.ink-strong}"
    rounded: "{rounded.pill}"
    padding: "8px 32px 8px 14px"
---

# Design System: Komik Hub

## Overview

**Creative North Star: "The Blue Archive"**

Komik Hub adalah rak komik pribadi yang menyatukan empat sumber. Sistem visualnya berangkat dari biru Komiku+ (`#0077b6`) sebagai jangkar, dengan ungu Komiku+ (`#935bab`) sebagai aksen — dua warna brand yang sudah mengakar di ekosistem sumbernya. Suasananya fungsional dan tenang: antarmuka mundur ke belakang, dan yang menonjol adalah konten komik itu sendiri, bukan dekorasi. Kartu berisi, typografi rapat, aksen digunakan hemat untuk memandu aksi dan status.

Sistem ini bergantung pada tonal layering (kartu lebih terang dari background, dikelilingi border halus) sebagai bahasa kedalaman dasarnya, dengan shadow halus di kartu utama dan elemen terapung untuk memberi rasa "terangkat" (lifted).

**Key Characteristics:**
- Biru jangkar untuk aksi utama dan elemen aktif; ungu untuk aksen/status premium.
- Kartu putih di atas latar abu-abu-biru sangat terang, dipisahkan border halus.
- Typografi dua keluarga: BR Hendrix untuk judul/display, Nunito Sans untuk body.
- Radius konsisten: kartu halus (md), tombol & bar (xl), pill untuk chip/status.
- Fungsional, tenang, konten-first.

## Colors

Palet dua-aksen di atas skala netral sejuk. Sumber kebenaran: `komiku-web/src/index.css` — `@theme` (terang) dan `.dark` (gelap).

### Primary
- **Komiku Blue** (#0077b6): Warna brand utama. Tombol aksi primer, indikator aktif (nav bawah, tab, tombol bergulir), badge jumlah/unread, elemen aktif. Teks di atasnya selalu `#161c26` (ink-strong) untuk kontras.
- **Blueprint Soft** (#4d9fd6): Hover tombol primer, variasi aksen terang.
- **Blueprint Dim** (#b3d9ef): Border tombol outline, batas elemen aksen, selected state ring pada tombol favorit/status.

### Secondary (accent)
- **Painted Violet** (#935bab): Aksen ungu — badge "komik" pada kartu, label premium, progress reader, status penekanan. Selalu dengan teks putih.
- **Violet Deep** (#784290): Varian hover accent.
- **Violet Mist** (#eedcff): Latar lembut untuk elemen accent.

### Neutral
- **Page Mist** (#f1f4f7): Background halaman (mode siang).
- **Card White** (#ffffff): Kartu/surface.
- **Card Mist** (#eef1f5): Kartu elevated, dropdown/input hover, tombol ikon sekunder.
- **Edge** (#e3e7ec): Border/divider.
- **Ink Hint** (#c6ccd4): Scrollbar, elemen nonaktif.
- **Ink Muted** (#9aa2ac): Ikon/tinta redup.
- **Ink Secondary** (#6f7681): Teks sekunder.
- **Ink Body** (#2b3340): Teks body utama.
- **Ink Strong** (#161c26): Teks emfasis/maksimal.

### Status (kesehatan sumber)
- **Healthy Green** (#15803d): Sumber sehat.
- **Warn Amber** (#b45309): Sebagian sumber mati.
- **Danger Red** (#b91c1c): Semua/nol sumber mati, status error.

### Night mode (reader)
- **Reader Night** (#282828): Permukaan baca gelap.
- **Reader Night Deep** (#131313): Background reader night shift.

**Named Rules**
**The Two-Color Rule.** Biru memimpin; ungu hadir hanya sebagai aksen sekunder. Keduanya tidak pernah bersaing pada elemen yang sama — ungu hanya muncul sebagai badge/status kecil, biru untuk aksi dan keterlibatan.

**The Ink VLAN Rule.** Warna teks sekunder (`ink-secondary` #6f7681) di atas kartu putih mempertahankan rasio kontras ≥4.5:1. Teks di atas biru primer selalu memakai `ink-strong` gelap, bukan putih.

## Typography

**Display Font:** BR Hendrix (weights 400/600/700, fallback font 'Nunito Sans', ui-sans-serif, system-ui)
**Body Font:** Nunito Sans (regular 400; semibold/bold 600/700 via weight 400/600/700)
**Label/Mono:** Nunito Sans bold — tidak ada font mono.

**Character:** BR Hendrix membawa karakter tegas, geometris, sedikit komersial untuk judul — cocok untuk judul komik dan headline. Nunito Sans yang bulat dan ramah menangani body serta UI, membuat antarmuka terasa mudah dibaca dan tidak kaku.

### Hierarchy
- **Display** (600–700, ~15px — 1.5rem judul kartu, ~20px judul halaman): Judul kartu komik, judul halaman. Muncul dengan `font-display`. Termasuk white-space bila di atas gambar.
- **Headline** (700, ~14px): Judul section, judul series.
- **Title** (600, ~13px): Judul tombol/kontrol, kartu row.
- **Body** (400, ~13–14px): Teks konten, deskripsi, metadata. Panjang baris dibatasi longkap ~65ch.
- **Label** (700, 9.5–12px): Badge, tombol, pill, metadata kecil. Ukuran 9.5–11.5px untuk info overlay di atas gambar (badge sumber/chapter).

**Named Rules**
**The Dense Data Rule.** UI memakai skala type kecil dan rapat (9.5–15px). Ini disengaja — layar penuh konten, dan tiap piksel ekstra dihemat.

## Layout

Grid kisi adaptif berbasis kartu. Konten diatur dalam kolom:

- Kisi kartu sampul (grid/flex wrap) dengan rasio sampul aspek `62/82` (mode grid) dan baris horizontal `MangaRow` (thumbnail 12 + judul).
- **Card grid** di Home: 2 kolom mobile, meluas di desktop; empit snap-scroll untuk katalog samlul.
- Spacing rhythm memakai skala Tailwind: gap 2.5 (10px) antar kartu, padding kartu p-2.5 (10px), padding halaman mx-2 (8px).
- Bottom navigation fixed dengan safe-area inset; konten memiliki padding bawah untuk menghindari overlap.
- Reader: ritme baca rapat — `row-gap:0`, tanpa jeda antar halaman di semua viewport.

## Elevation & Depth

Sistem menggabungkan tonal layering datar dengan lift halus: kedalaman utama disampaikan lewat kartu lebih terang dari background + border halus (`#e3e7ec`), bukan bayangan besar.

- **Flat-by-default** pada kartu umum: card menggunakan border + tonal layering, tanpa bayangan.
- **Lifted** pada kartu utama dan FAB: bayangan halus (`shadow-lg`, e.g. `0 10px 15px -3px rgb(0 0 0 / 0.1)`), terutama untuk elemen terapung (FAB "Lanjut baca", bottom nav).

### Shadow Vocabulary
- **Fab-Lift** (`shadow-lg shadow-black/20`): Tombol aksi terapung (FAB), elemen temporary yang menonjol.
- **Card-Lift** (`shadow` / `shadow-xl`): Kartu utama/hero, modal.

**Named Rules**
**The Flat-By-Default Rule.** Permukaan datar saat istirahat; bayangan muncul hanya sebagai respons terhadap status (hover, elevated, focus) atau pada elemen terapung khusus.

## Shapes

Bahasa bentuk didominasi radius konsisten:

- **Halus (md `6px`)**: kartu sampul manga (`rounded-md`).
- **Kartu/bar (xl `12px`)**: kartu row, tombol primer, tooltip, halaman kartu besar (`rounded-xl`).
- **Pill (`9999px`)**: badge sumber, chip, tombol ikon bulat, select dropdown, status kesehatan, progress bar, halaman aktif / scroll indicator.

Border tipis (0.8–1px) `#e3e7ec` dipakai sebagai pemisah alih-alih shadow pada kartu.

## Components

### Buttons
- **Shape:** radius xl (12px); tombol ikon bulat penuh (pill).
- **Primary:** `bg-brand-amber text-ink-950 font-bold` — padding vertikal py-2.5 (10px), horizontal px-3–4 (12–16px). Teks gelap di atas biru untuk kontras.
- **Hover:** `hover:bg-brand-amber-soft` (biru lebih terang).
- **Secondary / Outline:** border brand-amber-dim, teks brand-amber, hover bg brand-amber-dim/20. Dibuat untuk aksi alternatif (mis. "Favorit" saat belum dipilih).
- **Selected/Active:** fill `bg-brand-amber-soft text-ink-950` dengan `ring-2 ring-brand-amber/50` untuk state terpilih.

### Chips / Badge
- **Style:** pill (`rounded-full`), padding px-1.5 (6px) py-0.5 (2px), ukuran teks 9.5–10.5px, font-bold.
- **On-image:** background `bg-black/55–70`, teks putih, `backdrop-blur-sm`. Badge sumber non-komiku memakai `ring-1 ring-brand-amber/60`; badge "komik" memakai `bg-brand-red/90` (ungu) dengan teks putih.

### Cards / Containers
- **MangaCard (sampul):** CornerStyle md (6px), background `bg-ink-850` saat kosong / gambar, border `border-ink-800`. Overlay judul pakai `bg-gradient-to-t from-black/80` + BR Hendrix putih bershadow.
- **MangaRow:** CornerStyle xl (12px), background `bg-ink-900`, border `border-ink-800`, padding p-2.5, hover `hover:border-ink-700`.
- **Shadow Strategy:** flat + border; FAB dan hero pakai lift.

### Inputs / Fields / Select
- **Style:** `rounded-full`, border `border-ink-300`, background `bg-ink-900`, padding py-2 (8px) pl-3.5 (14px) pr-8 (32px untuk chevron), teks 12.5px medium.
- **Focus:** `focus:border-brand-amber focus:outline-none` — border berubah biru, tanpa ring default.
- **Error/Disabled:** opasitas 50% (`disabled:opacity-50`) untuk tombol; status error memakai `danger` merah.

### Navigation (bottom)
- **Style:** fixed bottom, border-top `border-ink-800`, background `bg-ink-950/95` + backdrop-blur. Ikon 16px + caption.
- **Active:** indikator garis atasan `h-0.5 w-8 rounded-b-full bg-brand-amber` + ikon teks `ink-200`. Inactive: `ink-300`.
- **Ikon circle:** `size-[40px] rounded-full bg-ink-850 text-ink-200`, transisi warna.

## Do's and Don'ts

### Do:
- **Do** gunakan biru Komiku (#0077b6) untuk semua aksi utama dan state aktif — itu jangkar brand.
- **Do** pakai teks gelap (`ink-strong`) di atas tombol biru primer untuk kontras maksimal.
- **Do** gunakan ungu (#935bab) hanya sebagai aksen sekunder kecil (badge, label premium), tidak pernah bersaing dengan biru.
- **Do** hormati kontras teks sekunder (ink-secondary ≥4.5:1 di atas putih).
- **Do** gunakan radius konsisten: md untuk kartu sampul, xl untuk tombol/bar, pill untuk chip/status.
- **Do** gunakan border halus `#e3e7ec` sebagai pemisah; simpan shadow untuk FAB dan elemen terapung.

### Don't:
- **Don't** pakai shadow pada kartu sehari-hari — sistem flat-by-default; shadow hanya untuk FAB/hero.
- **Don't** gabungkan biru dan ungu pada elemen yang sama.
- **Don't** manfaatkan teks putih di atas biru primer (kontras jatuh); selalu `ink-strong` gelap.
- **Don't** tambah font pihak ketiga di luar BR Hendrix + Nunito Sans — kedua keluarga sudah disubset dan dioptimalkan.
- **Don't** buat UI memakai teks berukuran >15px untuk judul kartu — density konten adalah fitur.
