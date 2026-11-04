# Audit UI Komik Hub — Laporan Agregat

Audit menyeluruh via **9 subagent paralel** (2 round): Home, Search/Explore, Series, SeriesUnified, Reader+Marathon, Rak/Akun/Notifikasi, App shell/nav, komponen murni, dan lintas-sumber global. Metode: detector `impeccable` + inspeksi source + cek browser. Server 8788 jalan (api 200, home 200). Sumber kebenaran visual: `DESIGN.md` + `PRODUCT.md`.

## Audit Health Score

| # | Dimensi | Skor | Temuan kunci |
|---|---------|------|--------------|
| 1 | Accessibility | 2/4 | Tanpa h1 di Home/Reader/ReaderMarathon; sheet modal tanpa semantik dialog; kontras sub-AA; tanpa fokus keyboard |
| 2 | Performance | 3/4 | Lazy route di App; anti-CLS reader; tapi rerender berantai carousel + hero blur non-lazy |
| 3 | Theming | 2/4 | Token kuat, tapi hardcode #f59e0b & #005f92; "tombol putih di atas amber" melanggar DESIGN.md; disparitas amber-vs-biru |
| 4 | Responsive | 3/4 | Layout adaptif baik; touch target <44px tersebar (36-40px) |
| 5 | Implementation Integrity | 3/4 | Detector bersih (0 anti-slop); bug sort `localeCompare`; bug filter Search (URL tanpa refetch) |
| **Total** | | **13/20** | **Acceptable (significant work needed)** |

## P0 danP1 (harus diperbaiki sebelum release)

- **P1 [Bug, Search]** — Mengubah filter di mode cari (`?q=`) hanya memperbarui URL, tidak memicu refetch (deps effect `useUnifiedSearch` tak menyertakan filter). Filter tidak berdampak. — `Search.tsx:126-137`, `useUnifiedSearch.ts:186-215`
- **P1 [A11y]** — Tidak ada `<h1>` di Home, Reader, ReaderMarathon (struktur mulai h2 / tanpa heading) → screen reader kehilangan landmark. — `Home.tsx`, `Reader.tsx`, `ReaderMarathon.tsx`
- **P1 [A11y/Modal]** — Sheet modal (ReaderSettings, ModeBaca, DownloadRangePicker, NotifPanel) tanpa `role=dialog`/`aria-modal`, focus trap, & awal, pemulihan fokus, Escape. — `components/*Sheet.tsx`, `NotifPanel.tsx`
- **P1 [A11y/Contrast]** — `ink-secondary #6f7681` di atas `#f1f4f7` = 4.1:1; hijau sehat `#15803d` di `#d7e6e1` = 3.9:1; biru brand `#0077b6` di `#f1f4f7` = 4.4:1 — semua <4.5:1 AA. Terulang lintas halaman.  **P1 [A11y/Carousel]** — Autoplay 4s tanpa cek `prefers-reduced-motion` & tanpa kontrol pause (WCAG 2.2.2); dots dekoratif tak fokusabel. — `Home.tsx:233-306`
- **P1 [Theming]** — Tombol primer pakai `text-white` di atas `bg-brand-amber` (kontras ~3.5:1), melanggar DESIGN.md (harus ink-strong gelap). Terulang di ErrorBoundary, Akun, ReaderFooter, Search, Series. — `ErrorBoundary.tsx:57`, `Akun.tsx:115`, `ReaderFooter.tsx:114`, `Search.tsx:306`

## P2 (perbaikan di pass berikutnya)

- Rerender berantai carousel→±108 kartu tak-memoize — `Home.tsx:384` (React.memo)
- Hero blur dimuat 2× tanpa lazy/dimensi → CLS — `Series*.tsx`
- Bug sort chapter `return b.number.localeCompare(b.number)` selalu 0 — `SeriesUnified.tsx:103`
- Side-effect `rememberSeriesLite` dipanggil di render — `SeriesUnified.tsx:183`; useState(()=>...) double-run StrictMode — `App.tsx:36-41`
- Tanpa focus-visible ring (BottomNav, CircleButton, input/kirim, chips) — `App.tsx:257-280`, `Search.tsx:304`, `SourceSortBar.tsx:68`
- Tab Rak tanpa `role=tab/tabpanel/aria-selected` — `Rak.tsx:95-106`
- Empty state palsu tab Unduhan saat load — `Rak.tsx:407-448`
- Touch target <44px: HeartButton 36px, CircleButton 40px, link balik 16px, logo 23px, pill sehat 35px, tombol "Coba lagi" ~24-28px
- Hardcode `#f59e0b` (heart) & `#005f92` (ReaderFooter) di luar @theme — `HeartButton.tsx:41`, `ReaderFooter.tsx:114`
- 45+ instance teks fungsional <11px (badge 9.5px, tanggal 10.5px, nav 10.5px)
- Tanpa skip-link & fokus tak dikelola saat navigasi route — `App.tsx:51`

## P3 (polish)

- Field `related` ter-fetch tak terpakai — `Series.tsx:22`
- Reader non-virtualized (ratusan halaman) — `Reader.tsx:698`, `ReaderMarathon.tsx:773`
- Loading gelap vs reader putih siang (inkonsistensi surface) — `Reader.tsx:460`
- Badge count `aria-hidden` tanpa `role=status` — `Rak.tsx:220`, `App.tsx:159`
- `aria-expanded` tanpa `aria-controls` — `Rak.tsx:456`
- Placeholder username 3.2:1 — `Akun.tsx`
- prefers-color-scheme hanya dibaca sekali (tanpa opsi "ikut sistem") — `theme.ts`

## Positif (dipertahankan)

- Detector anti-slop **0 temuan** di seluruh src (kode koheren, token dipakai konsisten)
- Dark mode solid: bootstrapTheme pre-render, `.dark` sumber tunggal, tanpa media-query salah
- ChapterPickerSheet sudah punya a11y modal lengkap (focus trap, aria-modal, Escape, live region)
- ComicImage fallback gagal-muat lengkap (+ timer stuck, alt, tombol refresh 80px)
- Bundle sehat: gzip inti ≈128KB (react-vendor 81.6 + app 30.4 + css 10.5), semua chunk rute di-lazy
- Anti-CLS reader via rasio aspek tersimpan + srcset WebP proxy + fetchPriority
- SourceStatus/SourceHealthBadge, reader-muted tokens (6:1 terang, 10:1 malam) terdokumentasi

## Rekomendasi perintah (prioritas)

1. `/impeccable harden` — a11y: heading h1 (Home/Reader), semantik dialog+focus trap, focus-visible, skip-link, carousel reduced-motion
2. `/impeccable colorize` — kontras token: gelapkan `ink-secondary`/brand/healthy + teks tombol primer
3. `/impeccable optimize` — memoize kartu, lazy hero blur, perbaiki deps filter Search
4. `/impeccable adapt` — touch target ≥44px; `/impeccable typeset` — naikkan teks fungsional ≥11px
5. `/impeccable document` — sinkronkan disparitas palet amber-vs-biru di DESIGN.md
6. `/impeccable polish` — pass terakhir
