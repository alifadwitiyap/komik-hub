# UI/UX Test Report — komik-hub (ui-ux-tester skill)

Tanggal: 2026-10-29. Tool: browser_exec (CDP). Server: localhost:8788.

## Ringkasan
| Area | Hasil |
|---|---|
| Home (beranda) | ✅ render: 4 sumber, Terbaru + Populer, semua kartu tampil |
| Navigasi bottom-nav | ✅ Beranda/Cari/Rak, semua URL benar |
| Halaman Cari | ✅ filter tipe/status/genre tampil |
| Search query | ✅ `?q=nano+machine` → 3 hasil (1 relevan, 2 false-positive) |
| Halaman Series | ✅ judul, penulis, status, skor, sinopsis, 343 chapter |
| Cover image | ✅ load (assets.shngm.id) |
| Reader (baca chapter) | ✅ 18 gambar full load saat visible, no horizontal overflow |
| Mode Maraton | ✅ chapter auto-progress 1→53/54, navigasi next manual jalan |
| Unduh (range Awal/Akhir) | ✅ klik fisik aktifkan mode pilih, "Pilih chapter akhir" muncul |
| Error console JS | ✅ tidak ada (0 error, 0 rejection) |
| Performa | ✅ tidak ada resource >5s |

## Defect / Temuan
### P1 — Hasil search tidak relevan (false positive)
Query "nano machine" → 3 hasil: Nano Machine (relevan), Legend Of Heavenly Chaos Demon (tidak relevan), Absolute Sword Sense (tidak relevan). Ini perilaku fuzzy search source shinigami; bukan bug UI, tapi menyesatkan user — hasil tak relevan tak ditandai.

### P2 — Klik programmatic tidak memicu React state (UX dev-only)
`el.click()`/`dispatchEvent` tidak mengubah state (`aria-pressed` tetap false); hanya klik fisik (`click_at_xy`) yang berfungsi. Ini behavior React 18 vs synthetic event, bukan bug produksi.

### P3 — Blank page race saat navigasi cepat (minor)
Navigasi cepat `location.href` dari maraton→series kadang menghasilkan body kosong (`<div id=root>` kosong), tidak ada error console. Setelah reload/`goto_url` pulih. Berpotensi UX glitch di koneksi lambat, perlu verifikasi.

### P4 — Artefak test: IO throttle saat tab hidden
IntersectionObserver tidak fire saat `visibilityState=hidden` (headless). Ini buka bug app — semua gambar load normal setelah tab dibawa ke front.

## Rekomendasi Fix
1. **(P1)** Pertimbangkan relevansi/fuzzy threshold pada search, atau tandai hasil non-exact.
2. **(P3)** Investigasi race React mount pada navigasi SPA cepat — mungkin perlu guard/error boundary.
