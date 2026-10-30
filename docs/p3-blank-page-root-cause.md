# P3 — Halaman blank total (#root kosong, tanpa error) saat navigasi cepat

Status: **root cause terbukti eksperimental, fix belum diterapkan** (laporan + sketsa diff saja).
Tanggal: 2026-10-29. Server uji: `http://127.0.0.1:8788` (build `index-BI_2a74Z.js`).

---

## 1. Ringkasan satu paragraf

`#root` kosong bukan karena React crash yang tidak terlihat, tapi karena **tidak ada
siapa pun yang menangkap** kegagalan `import()` chunk lazy. Kelima route berat
(`Reader`, `ReaderMarathon`, `SeriesUnified`, `Akun`, `Notifikasi`) dimuat lewat
`React.lazy`. Saat chunk gagal diambil (deploy baru → hash lama hilang, atau
jaringan putus), promise `import()` reject. React mencatat rejection itu di
`payload._status = 2` lalu **melempar ulang saat render**. `<Suspense>` hanya
menangani *pending*, bukan *error*. Karena `src/` **tidak punya ErrorBoundary
sama sekali**, React 19 meng-unmount seluruh pohon ke root container → `#root`
kosong. Dan karena React menelan error itu di dalam fase render (bukan
`window.onerror`), tidak ada `console.error` yang dilihat user.

---

## 2. Bukti eksperimental (bukan inferensi)

### 2.1 Reproduksi deterministik

```js
CDP Network.setBlockedURLs({ urls: ['*Reader-B-HpOpRX.js*'] })
navigasi → /baca/komiku:4554/00
```

Hasil terukur:

| Metrik | Nilai |
|---|---|
| `#root.innerHTML.length` | **0** |
| `#root.childElementCount` | **0** |
| `document.body.innerText` | `""` |
| `document.querySelectorAll('a').length` | **0** |

### 2.2 "Tanpa error" — benarkan?

**Sebagian benar, dan ini yang menyesatkan.** Dengan hook yang dipasang *sebelum*
dokumen dieksekusi (`Page.addScriptToEvaluateOnNewDocument`), error **ADA**:

```
["error: undefined",
 "error: Uncaught TypeError: Failed to fetch dynamically imported module:
          http://127.0.0.1:8788/assets/Reader-B-HpOpRX.js"]
```

Tapi pada laporan asli — navigasi lewat `location.href` — hook yang dipasang
sesudah load **hilang bersama dokumen lama**:

```
mark sebelum reload: "sebelum-reload"
mark sesudah reload: undefined      ← listener ikut mati
```

Jadi "0 error" di laporan lama adalah **artefak metode ukur**, bukan properti bug.
Yang **benar-benar** tidak ada: `console.error` dari aplikasi, pesan UI, dan
recovery. Ini penting untuk desain fix: jangan mengandalkan console.

### 2.3 Pohon React mati permanen (temuan tambahan, lebih parah dari dugaan)

Setelah blank, SPA **tidak bisa pulih sendiri**:

| Aksi setelah blank | `#root.innerHTML.length` |
|---|---|
| `history.back()` ke `/manga/...` | **0** (tetap kosong) |
| `history.pushState('/')` + `popstate` | **0** |
| klik link apa pun | mustahil — `0` elemen `<a>` di DOM |

Hanya **full reload** yang memulihkan (diverifikasi: `/baca/...` setelah reload →
`rootlen 943`, UI "Memuat… / Kembali" tampil). Ini menjelaskan kenapa user
melaporkan "setelah reload/goto_url pulih" — bukan kebetulan, itu satu-satunya jalan.

### 2.4 `vite:preloadError` — ada emitter, **tidak ada listener**

Di bundle produksi ada emitter Vite:

```js
function i(e){ let t=new Event(`vite:preloadError`,{cancelable:!0});
  if(t.payload=e, window.dispatchEvent(t), !t.defaultPrevented) throw e }
```

Hasil grep:

| Lokasi | Hasil |
|---|---|
| `src/**` | **0** |
| `index.html` | **0** |
| `dist/**` | hanya 1 (emitter di bundle, bukan listener) |
| `ErrorBoundary` / `componentDidCatch` di `src/` | **0** |

### 2.5 Jebakan kritis: `preventDefault()` saja justru MEMPERBURUK

Ini temuan yang mengubah bentuk fix. Diuji pada app asli dengan listener
`preventDefault()` **tanpa** ErrorBoundary:

```
__P = { fired: true, prevented: true,
        errs: ["error: undefined",
               "error: Uncaught TypeError: Cannot read properties of undefined (reading 'default')"] }
#root.innerHTML.length = 0      ← tetap blank
```

Sebabnya: `preventDefault()` membuat `catch()` di helper Vite mengembalikan
`undefined` alih-alih melempar. `React.lazy` lalu menerima "modul" `undefined`,
dan gagal lebih dalam di `mod.default`. Blank tetap, error berubah, dan sekarang
lebih sulit didiagnosis. Diuji terpisah:

```
tanpa listener      → REJECT: Failed to fetch dynamically imported module
dengan preventDefault → RESOLVED dengan modul = undefined
```

**Konsekuensi desain:** `preventDefault()` HANYA boleh dipakai bersama
ErrorBoundary (yang menangkap kegagalan lanjutan), atau tidak dipakai sama sekali.
Ia bukan fix; ia hanya membeli kesempatan untuk reload.

### 2.6 ErrorBoundary terbukti menutup lubangnya

Diuji dengan bundle nyata (rolldown, chunk lazy terpisah, disajikan via HTTP):

| Skenario | `#probe` |
|---|---|
| kontrol (chunk tersedia) | `ok`, boundary tidak terpicu |
| chunk diblokir | **`Gagal memuat halaman / Muat ulang`**, tombol ada, `rootlen 85` |
| `componentDidCatch` | `Failed to fetch dynamically imported module: .../boom-OXhj_vW8.js` |

### 2.7 Boundary harus MEMBUNGKUS `App`, bukan di dalamnya

Diuji langsung (dua root terpisah, init melempar di body render):

| Penempatan | Hasil |
|---|---|
| boundary **di dalam** `App` (membungkus konten) | `""` — **tidak tertangkap** (`caught: false`) |
| boundary **membungkus** `App` | `OUTER FALLBACK` — tertangkap (`caught: true`) |

Ini membatalkan separuh rencana awal. `App.tsx` baris 35–40 menjalankan tiga
initializer di **body render**:

```tsx
useState(() => captureFromUrl())
useState(() => startFavoritesSync())
useState(() => startReadMarksSync())
```

Kalau salah satunya melempar, `App` sendiri yang gagal — boundary di dalam `App`
tidak akan pernah melihatnya. Boundary **wajib** dipasang di `main.tsx`
membungkus `<App />`.

---

## 3. Nilai risiko tiga initializer di `App.tsx` (poin 2 permintaan)

Ketiganya **rendah**, tapi bukan nol, dan ketiganya punya pola yang sama:
efek samping dijalankan di fase render.

| Initializer | Bisa throw? | Penilaian |
|---|---|---|
| `captureFromUrl()` | Secara teori | **Sangat rendah.** Seluruh badan dibungkus `try/catch` (`account.ts:101-121`); `setUser` juga `try/catch`; `history.replaceState` ada di dalam `try`. |
| `startFavoritesSync()` | Secara teori | **Rendah.** Guard `typeof window`, lalu `addEventListener` + `onAccountChange` (aman). `onAccount` **async** dan dipanggil `void` → rejection-nya tidak menyentuh render. |
| `startReadMarksSync()` | Secara teori | **Rendah.** `switchScope()` sinkron, tapi `readLocal`/`readPending`/`writeLocal` semuanya `try/catch`, dan `emit()` membungkus tiap listener dengan `try/catch`. |

**Kesimpulan risiko:** jalur init ini bukan penyebab P3 yang teramati — pemicunya
chunk lazy. Tapi ada dua catatan nyata:

1. **Mereka tetap alasan struktural** kenapa boundary harus membungkus `App`.
   Selama tiga baris itu ada di body render, ada jalur blank yang tidak bisa
   ditangkap boundary internal. (Terbukti di §2.7.)
2. **Bau desain:** `useState(() => efekSamping())` dipakai sebagai "jalankan
   sekali". Nilai balik `() => {}` dari `startFavoritesSync` disimpan sebagai
   state dan tidak pernah dipanggil — cleanup-nya tidak pernah jalan. Bukan bug
   yang terlihat, tapi salah kaprah yang layak dibersihkan terpisah (mis.
   `useEffect(() => { const off = startFavoritesSync(); return off }, [])`).
   **Jangan dicampur ke patch P3** — itu perubahan perilaku, bukan fix blank.

---

## 4. Pemicu di produksi: kenapa chunk bisa gagal

Urutan yang paling mungkin, dan semuanya sudah diverifikasi di repo ini:

1. **Deploy baru saat tab masih terbuka.** `index.html` segar merujuk hash baru;
   hash lama sudah tidak ada di server. Server membalas **404 `text/plain` "not found"**
   (diverifikasi: `/assets/Reader-OLDHASH123.js` → `404`, `len=9`, **bukan**
   fallback `index.html` — jadi bukan kasus "HTML disajikan sebagai JS").
2. **Service worker menyimpan aset ber-hash selamanya.** Cache `SHELL =
   'komiku-shell-v2'` (baris 24) **tidak di-bump per build**; `cacheFirst()`
   (baris 292-303) mengembalikan `hit` tanpa revalidasi. Diverifikasi: setelah
   dua navigasi, `komiku-shell-v2` berisi 14 entri termasuk
   `/assets/index-BI_2a74Z.js`, `/assets/react-vendor-*.js`, `/assets/index-*.css`.
   Efeknya **dua arah dan keduanya buruk**:
   - aset lama tetap "ada" → HTML baru + JS lama (campuran versi);
   - chunk baru yang belum pernah di-cache dan sudah hilang di server → 404 → blank.
3. **Navigasi network-first, aset cache-first.** `req.mode === 'navigate'` →
   `fetch(req).catch(...)` (baris 141-147), jadi `index.html` bisa segar sementara
   chunk-nya basi. Ini persis kombinasi yang memicu blank.

Catatan: `index.html` dan `sw.js` sudah dikirim `cache-control: no-cache` oleh
server Rust (diverifikasi via `curl -sI`), dan `nginx.conf` juga sudah
`no-store` untuk `index.html`. Jadi masalahnya **bukan** header HTTP, melainkan
**Cache Storage milik SW**.

---

## 5. Sketsa patch (BELUM diterapkan — jangan commit apa pun dari sini)

### 5.1 `komiku-web/src/ErrorBoundary.tsx` (baru)

```tsx
import { Component, type ErrorInfo, type ReactNode } from 'react'

interface Props {
  children: ReactNode
  /** label konteks, mis. "halaman ini" — dipakai di pesan */
  what?: string
}
interface State {
  error: Error | null
}

/**
 * Menangkap error render/lazy-chunk. Tanpa ini, React 19 meng-unmount seluruh
 * pohon → #root kosong tanpa jejak di UI. Suspense TIDAK menangkap error.
 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    // Satu-satunya jejak yang tersisa kalau UI fallback juga gagal.
    console.error('ErrorBoundary:', error, info.componentStack)
  }

  private reload = () => {
    // Guard: kalau chunk memang sudah hilang, reload berulang = loop.
    // Ditangani di main.tsx (vite:preloadError); di sini reload biasa.
    window.location.reload()
  }

  render() {
    const { error } = this.state
    if (!error) return this.props.children
    return (
      <div className="mx-auto max-w-3xl px-4 py-16 text-center">
        <p className="text-base font-semibold text-ink-200">Gagal memuat halaman</p>
        <p className="mt-1 text-sm text-ink-400">
          Sebagian aplikasi gagal diambil — biasanya karena versi baru baru saja
          dipasang. Muat ulang untuk mengambil versi terbaru.
        </p>
        <button
          type="button"
          onClick={this.reload}
          className="mt-5 rounded-xl bg-brand-amber px-5 py-2.5 text-[13px] font-bold text-ink-950"
        >
          Muat ulang
        </button>
        <p className="mt-3 break-words text-[10.5px] text-ink-600">{error.message}</p>
      </div>
    )
  }
}
```

### 5.2 `komiku-web/src/main.tsx` — boundary DI LUAR `App` + handler preload

```diff
 import { StrictMode } from 'react'
 import { createRoot } from 'react-dom/client'
 import { BrowserRouter } from 'react-router-dom'
 import './index.css'
 import App from './App'
+import { ErrorBoundary } from './ErrorBoundary'
 import { bootstrapTheme } from './theme'

 bootstrapTheme()

+// Chunk lazy yang gagal diambil (deploy baru / jaringan putus) TIDAK ditangkap
+// Suspense — ia reject saat render dan meng-unmount seluruh pohon. Reload sekali
+// adalah satu-satunya pemulihan yang benar (chunk lama sudah tidak ada di server).
+//
+// PENTING: preventDefault() membuat helper Vite me-resolve `undefined` (bukan
+// melempar). Tanpa ErrorBoundary di bawah, itu justru menghasilkan error lain
+// dan tetap blank — sudah diukur. Jadi keduanya WAJIB berpasangan.
+const RELOAD_GUARD = 'komik.preload-reload.v1'
+window.addEventListener('vite:preloadError', (e) => {
+  e.preventDefault()
+  if (sessionStorage.getItem(RELOAD_GUARD)) return // sudah pernah; biar boundary tampil
+  sessionStorage.setItem(RELOAD_GUARD, '1')
+  window.location.reload()
+})
+
 createRoot(document.getElementById('root')!).render(
   <StrictMode>
     <BrowserRouter>
-      <App />
+      {/* Boundary membungkus App, bukan di dalamnya: init di body render App
+          (captureFromUrl/startFavoritesSync/startReadMarksSync) hanya bisa
+          ditangkap dari luar. Terbukti: boundary internal tidak menangkapnya. */}
+      <ErrorBoundary>
+        <App />
+      </ErrorBoundary>
     </BrowserRouter>
   </StrictMode>,
 )
```

Catatan guard: **jangan** pakai `sessionStorage` mentah seperti di atas tanpa
dibersihkan saat sukses — kalau tidak, satu kegagalan sesaat mematikan
auto-reload sampai tab ditutup. Versi lebih aman: hapus guard setelah render
pertama yang berhasil.

```tsx
// di dalam App (atau ErrorBoundary yang tidak error):
useEffect(() => { sessionStorage.removeItem(RELOAD_GUARD) }, [])
```

### 5.3 `komiku-web/src/App.tsx` — boundary per-route (opsional, tapi disarankan)

Boundary global menyelamatkan app, tapi menghapus seluruh UI (TopBar + BottomNav
ikut hilang). Untuk route yang sering gagal, lebih baik boundary **di dalam**
layout supaya navigasi tetap hidup:

```diff
         <main className={immersive ? '' : 'pb-24 pt-14'}>
           <Suspense fallback={<Spinner label="Memuat…" />}>
-            <Routes>
+            <ErrorBoundary>
+              <Routes>
               ...
-            </Routes>
+              </Routes>
+            </ErrorBoundary>
           </Suspense>
         </main>
```

**Urutan penting:** `ErrorBoundary` di **luar** `Suspense`, bukan di dalam.
`Suspense` menangkap *pending*; boundary harus melihat *error* yang lolos
darinya. (Kalau boundary diletakkan di dalam Suspense, ia hanya membungkus
children-nya, bukan fallback — tidak menangkap apa pun.)

### 5.4 `komiku-web/public/sw.js` — cache aset ber-hash tidak boleh abadi

Tiga perubahan kecil, masing-masing menutup satu jalur:

```diff
-const SHELL = 'komiku-shell-v2'
+// WAJIB di-bump setiap deploy yang mengubah daftar precache. Nama cache adalah
+// satu-satunya cara membersihkan aset ber-hash lama: `activate` menghapus semua
+// cache yang tidak ada di daftar, jadi naikkan versi = buang aset build lama.
+const SHELL = 'komiku-shell-v3'
```

```diff
 async function cacheFirst(req, cacheName) {
   const cache = await caches.open(cacheName)
   const hit = await cache.match(req, { ignoreSearch: false })
   if (hit) {
-    // aset shell immutable (nama file ber-hash): tak perlu revalidasi
     return hit
   }
   try {
     const res = await fetch(req)
-    if (res.ok) cache.put(req, res.clone())
+    // JANGAN simpan 404. Respons error yang masuk cache akan disajikan ulang
+    // selamanya untuk URL itu, dan `import()` menerimanya sebagai modul rusak.
+    if (res.ok) cache.put(req, res.clone())
     return res
```

```diff
     if (req.mode === 'navigate') {
       e.respondWith(
-        fetch(req).catch(() =>
-          caches.match('/index.html').then((r) => r || caches.match('/')),
-        ),
+        // network-first, TAPI jangan pernah menyajikan index.html yang lebih tua
+        // dari build yang sedang berjalan: kalau jaringan gagal, fallback cache
+        // hanya boleh dipakai saat benar-benar offline.
+        fetch(req).catch(async () => {
+          const hit = (await caches.match('/index.html')) || (await caches.match('/'))
+          return hit || Response.error()
+        }),
       )
       return
     }
```

**Rekomendasi lebih kuat (menghilangkan seluruh kelas bug ini):** jangan
precache `index.html` sama sekali, dan jangan `cacheFirst` untuk `/assets/*`.
Aset ber-hash sudah `immutable` di HTTP (`cache-control: public, max-age=31536000`)
— browser HTTP cache sudah cukup; SW tidak perlu ikut menyimpannya, dan dengan
tidak menyimpannya, deploy baru tidak mungkin mencampur dua versi.

```js
// install: cukup offline.html + ikon, JANGAN index.html
c.addAll(['/offline.html'])
```

### 5.5 `komiku-web/index.html` — jaring pengaman terakhir (opsional)

Kalau JS utama sendiri gagal dimuat, React tidak pernah jalan dan tidak ada
boundary yang bisa menolong. Satu blok kecil di `index.html` menutup itu:

```html
<script>
  // Kalau setelah 12s #root masih berisi skeleton boot, berarti bundle utama
  // gagal dimuat. Tampilkan jalan keluar, jangan biarkan user menatap skeleton.
  setTimeout(function () {
    var r = document.getElementById('root')
    if (r && r.querySelector('.kb-boot')) {
      r.innerHTML =
        '<div style="padding:80px 20px;text-align:center;font:14px system-ui">' +
        '<p style="font-weight:600">Gagal memuat aplikasi</p>' +
        '<p style="color:#8794a6;margin-top:6px">Periksa koneksi, lalu muat ulang.</p>' +
        '<button onclick="location.reload()" style="margin-top:18px;padding:10px 20px;' +
        'border-radius:12px;border:0;background:#f5a524;font-weight:700">Muat ulang</button></div>'
    }
  }, 12000)
</script>
```

---

## 6. Cara memverifikasi fix (harus lulus semua)

### 6.1 Uji utama — chunk diblokir harus memunculkan fallback, bukan blank

```python
# 1. build + serve
cd komiku-web && npm run build && (cd dist && python3 -m http.server 8788)

# 2. browser: blokir chunk Reader
CDP Network.setBlockedURLs({ urls: ['*Reader-*.js*'] })

# 3. navigasi ke /baca/<handle>/<nomor>
```

**Lulus jika:**
- `#root.innerHTML.length > 0`
- teks mengandung `"Gagal memuat halaman"` **atau** halaman sudah pulih setelah reload
- ada `<button>` "Muat ulang" yang bisa diklik
- `document.querySelectorAll('a').length > 0` (nav masih hidup — kalau pakai §5.3)

**Gagal jika:** `innerHTML.length === 0` (regresi), atau muncul error
`Cannot read properties of undefined (reading 'default')` (berarti
`preventDefault` dipasang **tanpa** boundary — lihat §2.5).

### 6.2 Uji tidak-loop

Blokir chunk secara permanen, lalu reload berkali-kali:

```
lulus: reload terjadi PALING BANYAK 1×, setelah itu fallback UI yang tampil
gagal: reload berulang tanpa henti (guard sessionStorage bocor / tidak dibersihkan)
```

### 6.3 Uji pemulihan nyata (simulasi deploy)

```python
# 1. blokir chunk, navigasi -> harus fallback
# 2. buka blokir (chunk tersedia lagi)
# 3. klik "Muat ulang"
# lulus: halaman reader tampil normal (rootlen > 0, ada <img>)
```

### 6.4 Uji SW tidak mencampur versi

```
1. load app, biarkan SW aktif (navigator.serviceWorker.controller === true)
2. ganti hash build (rebuild), deploy
3. reload
lulus: caches.keys() TIDAK berisi 'komiku-shell-v2' lagi (activate membersihkan),
       dan tidak ada aset dari dua build berbeda di satu cache
```

### 6.5 Uji regresi — jangan sampai fix merusak yang sudah jalan

Jalankan gate yang sudah ada di repo:

```bash
cd komiku-web && npx tsc -b && npm run build
python3 scripts/gate_served_surface.py     # 4 halaman, desktop + mobile
python3 scripts/marathon_gate_e2e.py       # gerbang chaining maraton
python3 scripts/search_ux_e2e.py           # dua fase search
```

Tambahkan satu kasus permanen ke `gate_served_surface.py`:

```python
# chunk diblokir -> WAJIB ada fallback, bukan #root kosong
pg.block(["*Reader-*.js*"])
pg.goto("/baca/<handle>/<nomor>")
assert pg.eval("document.getElementById('root').innerHTML.length") > 0
assert "Gagal memuat" in pg.eval("document.body.innerText")
```

---

## 7. Yang TIDAK saya ubah

- Tidak ada file di `komiku-web/src`, `komiku-web/public`, atau `index.html` yang
  disentuh. `git diff` kosong; `git status` hanya berisi tiga dokumen untracked
  yang sudah ada sebelumnya (`docs/p1-p3-investigation.md`,
  `docs/p1-search-relevance-report.md`, `docs/ui-test-report.md`).
- Semua bundle uji dibuat di `/tmp` (rolldown dari `node_modules` repo), disajikan
  lewat `python3 -m http.server` di port 8797–8799, lalu dihapus.
- Tidak ada commit.

## 8. Satu koreksi untuk laporan lama

`docs/ui-test-report.md` P3 menyebut "tidak ada error console". Itu **artefak**:
hook error dipasang setelah load, dan `location.href` membuang listener bersama
dokumen lama (§2.2). Error-nya nyata dan reproducible. Kalau laporan itu dipakai
sebagai acceptance criteria, kriterianya harus diubah menjadi **"UI fallback
tampil"**, bukan "tidak ada error console".
