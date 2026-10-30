# P1 & P3 — Investigasi Mendalam (DITERAPKAN & DIVERIFIKASI)

Status: **fix sudah diterapkan dan diuji.** 187 test Rust lulus (92 core + 95 server), `tsc -b` bersih, build produksi sukses, uji E2E via CDP lulus.

---

## Ringkasan hasil setelah fix

| Uji | Sebelum | Sesudah |
|---|---|---|
| `search?q=nano machine` | 3 item (2 sampah) | **1 item** (Nano Machine) |
| UI `/cari?q=nano+machine` | 3 kartu | **"1 hasil untuk nano machine"** |
| Chunk Reader diblokir | `#root` kosong (blank) | **fallback + tombol Muat ulang** |
| Reload saat chunk hilang | — | **berhenti (tidak loop)** |
| Klik "Muat ulang" setelah blokir dibuka | — | **reader normal, 18 gambar** |
| `has_more` setelah filter | bohong (mati di hal.1) | **benar** (`a`→24/True, `one piece`→15/False) |
| Cache SW | `komiku-shell-v2` | **`komiku-shell-v3`** (v2 terhapus) |

**Dua bug yang kutemukan saat implementasi** (tidak terlihat di proposal awal):
1. **Loop reload 265×** — guard dibersihkan dari `useEffect` di `App`, tapi boundary per-route menangkap error *di dalam* App sehingga App tetap mount sukses → guard terhapus → reload lagi. Perbaikan: guard tidak dibersihkan otomatis.
2. **`preventDefault()` menghasilkan error sekunder** `Cannot read properties of undefined (reading 'default')`. Fallback tetap tampil, tapi pesannya menyesatkan — sekarang didokumentasikan sebagai konsekuensi yang disengaja.

---

## P1 — Search mengembalikan hasil tidak relevan

### Root cause (TERBUKTI)
`komik/core/src/aggregator.rs` → `rank_by_query()` (~baris 2119) **hanya melakukan `sort_by`**, tidak pernah memfilter.

```rust
pub fn rank_by_query<T: Rankable>(items: Vec<T>, query: &str) -> Vec<T> {
    ...
    out.sort_by(|a, b| {
        let (ta, ma) = match_tier(&a.rank_title_key().to_lowercase(), &tokens, &query_key);
        let (tb, mb) = match_tier(&b.rank_title_key().to_lowercase(), &tokens, &query_key);
        ta.cmp(&tb).then_with(|| mb.cmp(&ma)).then_with(|| rank_cmp(a, b))
    });
    out
}
```

`match_tier()` punya varian `Exact | Prefix | AllTokens | Partial | NoMatch` — **`NoMatch` tetap ikut dikembalikan**, cuma diurut paling bawah.

### Bukan bug adapter — upstream memang fuzzy
```
GET https://api.shngm.io/v1/manga/list?page=1&page_size=20&q=nano+machine
(header: User-Agent + Origin: https://app.shinigami.asia)
→ 3 item: ["Nano Machine", "Absolute Sword Sense", "Legend Of Heavenly Chaos Demon"]
```
Persis 3 item yang muncul di UI kita. Jadi parsing adapter benar; upstream shinigami yang mengembalikan sampah.

### Dampak terukur (query → total → setelah filter NoMatch)
| Query | Total | Exact | Prefix | AllTokens | Partial | NoMatch | Setelah filter |
|---|---|---|---|---|---|---|---|
| nano machine | 3 | 1 | 0 | 0 | 0 | 2 | **1** |
| nano | 44 | 0 | 2 | 36 | 0 | 6 | 38 |
| machine | 16 | 0 | 1 | 3 | 0 | 12 | 4 |
| solo leveling | 30 | 1 | 3 | 0 | 8 | 18 | 12 |
| one piece | 27 | 1 | 2 | 0 | 12 | 12 | 15 |
| machine nano | 8 | 0 | 0 | 1 | 0 | 7 | **1** |
| the | 48 | 0 | 44 | 4 | 0 | 0 | 48 |

Uji 18 query tambahan (`a`, `ab`, `x`, `zz`, `manhwa`, `kim`, `12`, `berserk`, ...): **tidak ada satu pun yang jadi 0** setelah filter. → filter `NoMatch` aman tanpa fallback.

### Fix yang diusulkan (belum diterapkan)
Filter `NoMatch` di dalam `rank_by_query` (sebelum `sort_by`, bukan di pemanggil — supaya terjadi **sebelum** `truncate(limit)` di baris 560/594/668/679/716), dengan graceful degradation: kalau hasil filter kosong padahal input tidak kosong, kembalikan input yang sudah di-rank apa adanya.

**Koreksi penting soal test** (klaim subagent P1 salah di satu titik):
- `exact_mengalahkan_non_match_yang_lebih_baru` (baris 2290) **TETAP HIJAU**. Judul `"Solo Necromancy"` dengan query `"solo leveling"` cocok token `solo` (1 dari 2) → `match_tier` mengembalikan **`Partial`**, bukan `NoMatch`. Jadi tidak ikut difilter. Nama test itu menyesatkan, isinya sebenarnya menguji Partial vs Exact.
- `hasil_set_tidak_berubah` (baris 2385) **MERAH** — satu-satunya. Input 5 item, `"Unrelated Title"` = NoMatch → hilang → `out.len()` jadi 4. Assertion `out.len() == input.len()` harus diubah jadi 4, dan assertion set-equality (`a == b`) harus disesuaikan karena `"d"` memang sengaja dibuang.
- `kueri_kosong_noop` (baris 2371) tetap hijau (early-return saat token kosong).

Sebaiknya tambah test baru: (a) filter membuang NoMatch, (b) fallback saat SEMUA item NoMatch (hasil tidak boleh 0 kalau input tidak kosong).

---

## P3 — Halaman blank total (#root kosong, tanpa error)

### Root cause (TERBUKTI EKSPERIMENTAL)
`import()` chunk lazy gagal → React `lazy()` reject saat render → **tidak ada ErrorBoundary** → React unmount seluruh tree → `#root` kosong, **tanpa error console sama sekali**.

Reproduksi deterministik:
```js
CDP: Network.setBlockedURLs({urls: ["*Reader-B-HpOpRX.js*"]})
navigasi → /baca/<handle>/336
hasil: #root.innerHTML.length === 0
       document.body.innerText === ''
       window error events === 0
       unhandledrejection === 0
       console.error === 0
```
Diulang pada route `/maraton/...` dengan chunk `ReaderMarathon-*.js` → hasil identik (blank, 0 error).

### Mengapa terlihat "nol error"? — ARTEFAK METODE UKUR
`import()` sebenarnya melempar error yang bisa ditangkap:
```
import('/assets/does-not-exist-xyz.js').catch(...)
→ "Failed to fetch dynamically imported module: http://localhost:8788/assets/does-not-exist-xyz.js"
```
Tapi React `lazy()` menangkap rejection itu di dalam fase render dan me-render ulang tanpa boundary → pohon di-unmount, error ditelan.

"0 error" yang kulaporkan sebelumnya **tidak valid**: hook `window.addEventListener` kupasang lewat `js()` SETELAH `location.href`, sehingga listener mati bersama dokumen lama. Dengan `Page.addScriptToEvaluateOnNewDocument` (hook terpasang sebelum dokumen dieksekusi), error-nya nyata:
```
"error: Uncaught TypeError: Failed to fetch dynamically imported module: .../Reader-B-HpOpRX.js"
```
→ Acceptance criteria harus "UI fallback tampil", **bukan** "tidak ada error console".

### Fakta lain yang terkoreksi
- React **19.2.8** (bukan 18). Di React 19, error tanpa boundary meng-unmount seluruh pohon ke root container.
- Pohon mati **permanen**: `history.back()` → tetap `rootlen 0`; `pushState('/')` + `popstate` → 0; tidak ada `<a>` untuk diklik. Hanya full reload yang memulihkan.
- Header HTTP **bukan** penyebab: `index.html` & `sw.js` sudah `cache-control: no-cache` (diverifikasi `curl -sI`), `nginx.conf` `no-store`. Pemicunya Cache Storage milik SW.
- 404 chunk dibalas `text/plain "not found"` (len=9) — bukan SPA fallback HTML, jadi bukan kasus "HTML-as-module".
- Tiga initializer di `App.tsx:35-40` berisiko **rendah** (semua `try/catch`) — bukan pemicu P3. Tapi tetap alasan struktural boundary harus membungkus `App`, bukan di dalamnya.

### Jebakan: `preventDefault()` sendirian MEMPERBURUK
Handler `vite:preloadError` yang hanya `preventDefault()` membuat helper Vite me-resolve `undefined` alih-alih melempar → error baru `Cannot read properties of undefined (reading 'default')`, `#root` tetap kosong. Ia hanya boleh dipasang **bersama** ErrorBoundary.

### Faktor pemicu di produksi
1. **Tidak ada ErrorBoundary** — `grep -rn 'ErrorBoundary|componentDidCatch' src/` = 0 hasil. `<Suspense>` hanya menangani *pending*, bukan *error*.
2. **Tidak ada handler `vite:preloadError`** — dicek di `src/main.tsx`, `index.html`, `dist/` = tidak ada.
3. **Service worker `komiku-shell-v2`** (`public/sw.js`):
   - nama cache **tidak di-bump per build**;
   - precache `['/', '/index.html', '/offline.html']` (baris ~46);
   - `cacheFirst(req, cacheName)` untuk aset JS: hit → return tanpa revalidasi; miss → `fetch`, `if (res.ok) cache.put(...)`, lalu `return res` (404 juga diteruskan ke `import()`).
   - navigasi: network-first (baris ~141-147) → `index.html` bisa segar sementara chunk hash lama sudah hilang dari server → 404 → blank.

### Fix yang diusulkan (belum diterapkan) — 4 lapis
1. **`src/ErrorBoundary.tsx`** — class component: `static getDerivedStateFromError` → `{error}`, `componentDidCatch` → `console.error` (satu-satunya jejak), `render()` fallback "Gagal memuat halaman" + penjelasan versi baru baru dipasang + tombol **Muat ulang** → `location.reload()`.
2. **`src/main.tsx`** — bungkus `<App />` dengan `<ErrorBoundary>` **DI LUAR App** (di dalam `StrictMode`/`BrowserRouter`). Terbukti eksperimental: boundary di dalam `App` → `caught: false`, blank; boundary membungkus `App` → `OUTER FALLBACK`, `caught: true`. Plus listener `vite:preloadError` → `preventDefault()` + reload sekali dengan guard `sessionStorage` (`komiku.preload-reload.v1`), guard dibersihkan setelah render sukses pertama. **Jangan pasang `preventDefault` sendirian** (lihat jebakan di atas).
3. **`src/App.tsx`** — boundary per-route membungkus `<Routes>` dan diletakkan **DI LUAR `<Suspense>`** (boundary di dalam Suspense tidak menangkap apa pun), supaya TopBar/BottomNav tetap hidup dan user masih bisa navigasi.
4. **`public/sw.js`** — bump `SHELL` → `'komiku-shell-v3'`; **jangan `cache.put` respons non-ok** (404 masuk cache akan disajikan selamanya); fallback `caches.match('/index.html')` hanya saat benar-benar offline. Rekomendasi lebih kuat: jangan precache `index.html` dan jangan `cacheFirst` untuk `/assets/*` — aset ber-hash sudah `immutable` via HTTP (`max-age=31536000`), jadi SW tidak bisa lagi mencampur dua versi build.

Opsional (jaring terakhir): skrip di `index.html` yang setelah ~12s memeriksa `#root` masih berisi skeleton boot → tampilkan "Gagal memuat aplikasi" + tombol reload. Menutup kasus bundle utama gagal dimuat (React tidak pernah jalan, boundary tidak bisa menolong).

### Cara verifikasi fix
(a) `Network.setBlockedURLs(['*Reader-*.js*'])` + navigasi → `#root.innerHTML.length > 0`, teks mengandung "Gagal memuat halaman", ada `<button>` "Muat ulang", `querySelectorAll('a').length > 0`. **Gagal** kalau `innerHTML.length === 0` atau muncul `Cannot read properties of undefined (reading 'default')`.
(b) Blokir permanen + reload berkali-kali → reload maksimal 1×.
(c) Buka blokir, klik "Muat ulang" → reader tampil normal.
(d) Setelah rebuild, `caches.keys()` tidak lagi memuat `komiku-shell-v2`.
(e) Regresi: `npx tsc -b && npm run build`, `scripts/gate_served_surface.py`, `scripts/marathon_gate_e2e.py`, `scripts/search_ux_e2e.py`.

Laporan lengkap + 5 sketsa diff: `docs/p3-blank-page-root-cause.md` (19.962 byte).
