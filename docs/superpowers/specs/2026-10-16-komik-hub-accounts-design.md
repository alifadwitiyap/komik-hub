# Spec: Akun Komik Hub — identitas per-orang, favorit/notif/unduhan/progress terpisah

Tanggal: 2026-10-16
Status: disetujui (hasil brainstorming), siap implementasi

## Masalah

Komik Hub dipakai ~10 orang (HP masing-masing, kadang laptop). Tiga hal bocor antar-orang:

1. **Favorit + notifikasi** — satu slot global di `komiku-server/data/state.json`
   (`notif.rs` → `BTreeMap<String, Favorite>`). Sinkronisasi replace-all
   (`apply_favorites`, `notif.rs:341`) membuat device yang push terakhir
   menghapus favorit device lain.
2. **Unduhan PDF** — satu index global (`downloads/index.json`). PDF yang diunduh
   satu orang muncul di rak semua orang.
3. **Posisi baca** — per-device (`useProgress.ts`, localStorage). Pindah HP
   mengulang dari awal.

## Keputusan yang sudah diambil

| Pertanyaan | Keputusan |
|---|---|
| Perlu login page? | **Tidak.** Halaman `/akun` sederhana: ketik username → langsung masuk. |
| Daftar butuh password? | **Tidak.** Username saja. |
| Identitas per-orang atau per-device? | **Per-orang.** Satu username dipakai di HP + laptop. |
| Unduhan dipisah? | **Ya**, index per-orang; file PDF tetap dibagi (satu file untuk chapter yang sama). |
| Progress disinkron? | **Ya**, per-orang. |
| Server jadi sumber kebenaran? | **Ya** untuk favorit + progress. |

### Konsekuensi yang diterima sadar

- Siapa pun yang tahu username bisa masuk akun itu. Situs sudah di balik Basic Auth
  satu password (`deploy/Caddyfile:23`), jadi halaman daftar efektifnya undangan.
- Nol "lupa password" — nggak ada yang perlu diingat, tinggal ketik username.
- `Alif` / `alif` / `ALIF` = **satu akun** (dinormalisasi lowercase).

---

## 1. Kontrak identitas

### Aturan username

```
normalize:  trim → lowercase
valid:      ^[a-z0-9][a-z0-9_-]{2,19}$      (3–20 karakter)
```

Validasi ketat ini **wajib**, bukan kosmetik: username dipakai sebagai nama file
(`data/users/<username>.json`). Tanpa validasi, `../../etc/passwd` keluar dari
folder. Karena alfabetnya cuma `[a-z0-9_-]`, path traversal mustahil.

### Header

Semua endpoint ber-scope akun membaca `X-Komik-User: <username>`.

- Header hilang / username invalid / username belum terdaftar → **401**
  `{ "error": "...", "hint": "..." }`
- `CorsLayer::permissive()` sudah `allow_headers(Any)` → tidak perlu ubahan CORS.

### Endpoint akun

| Method | Path | Body | Balasan |
|---|---|---|---|
| `POST` | `/api/user/claim` | `{username}` | `{ok:true, username, created:bool}` |
| `GET` | `/api/user/me` | — | `{username, favorites, downloads}` |

`claim` = daftar sekaligus masuk. `created:true` kalau file baru dibuat,
`created:false` kalau akun sudah ada. Username invalid → 400.

`created` dipakai frontend untuk memutuskan arah sinkronisasi pertama
(lihat §5). Ini bagian dari kontrak, jangan diubah jadi tanpa arti.

### Layout penyimpanan

```
data/
  users/<username>.json              # favorit + baselines + notifikasi
  progress/<username>.json           # posisi baca
  downloads/
    index/<username>.json            # daftar unduhan milik user
    evictions/<username>.json        # log eviction milik user
    settings/<username>.json         # limit unduhan milik user
    refs.json                        # {download_id: jumlah user yang pegang}
    <download_id>.pdf                # FILE DIBAGI — satu per chapter
```

**Satu file per user, bukan satu file besar.** `save_locked` menulis ulang seluruh
state tiap mutasi. 10 user di satu file = 10× tulis + rebutan lock. Per-file,
satu user menulis tidak menyentuh yang lain.

**Progress di file terpisah dari notif.** Kalau digabung, dua modul menulis file
yang sama → lost update, dan dua lane tidak bisa disjoint.

---

## 2. Modul `user.rs` (server) — FONDASI, dibekukan lebih dulu

```rust
/// Normalisasi + validasi. Err(AppError) kalau tidak valid.
pub fn normalize_username(raw: &str) -> Result<String, AppError>;

/// Baca X-Komik-User, normalisasi, pastikan sudah terdaftar.
/// Err(401) kalau header hilang / invalid / belum terdaftar.
pub fn require_user(headers: &axum::http::HeaderMap) -> Result<String, AppError>;

/// Path data/users/<username>.json  (dan progress/downloads varian)
pub fn users_dir() -> PathBuf;
pub fn user_file(dir: &Path, username: &str) -> PathBuf;

/// Router: POST /api/user/claim, GET /api/user/me
pub fn user_routes() -> Router;
```

`users_dir()` mengikuti pola `data_dir()` di `notif.rs:37` — default relatif CWD,
override lewat env. Env yang ada: `KOMIKU_NOTIF_DIR`, `KOMIKU_DOWNLOADS_DIR`.
Tambahan: `KOMIKU_USERS_DIR` (default = `KOMIKU_NOTIF_DIR`).

---

## 3. Notifikasi per-user (`notif.rs`)

State global `NotifStore.state: Mutex<State>` → **`Mutex<BTreeMap<String, State>>`**
(key = username). Perubahan:

- `state_path` tunggal → `dir.join("users")` + `user_file(dir, username)`.
  Simpan hanya file user yang berubah, bukan seluruh map.
- Keempat handler ambil username dari `require_user(headers)`.
- **Tambahan `GET /api/notif/favorites`** → `{favorites:[{title_key,title,cover_url,handle,source}]}`
  Dipakai frontend untuk hydrate. Belum ada sekarang; wajib ada.
- `run_check_cycle` loop **per user**. Fetch sumber tetap **dibagi** lewat cache
  `snapshot()` yang sudah di-key `title_key` (`notif.rs:119`, TTL 30 menit) —
  kalau 5 orang nge-favorit judul yang sama, server tetap fetch **sekali**.
- Baseline tetap **per-user** (bukan cuma soal privasi): `fill_baselines`
  (`notif.rs:403`) menyetel baseline = chapter tertinggi saat itu. Baseline global
  bikin orang yang gabung belakangan kebanjiran notif chapter lama.
- `background_checker` satu task untuk semua user; interval efektif dihitung dari
  total favorit seluruh user.
- `effective_interval` / `BIG_LIST_THRESHOLD` dipertahankan.

Endpoint (semua scoped):

| Method | Path |
|---|---|
| `GET` | `/api/notif/favorites` **(baru)** |
| `PUT` | `/api/notif/favorites` |
| `GET` | `/api/notif/list` |
| `POST` | `/api/notif/read` |
| `POST` | `/api/notif/dismiss` |

---

## 4. Unduhan per-user + refcount (`downloads.rs`, `unified.rs`)

`DownloadStore.state: Mutex<State>` → satu mutex yang memegang
`BTreeMap<username, State>` + `refs: BTreeMap<String, usize>`. Satu mutex, bukan
beberapa, supaya tidak ada deadlock dan eviction tetap serial.

- Index / evictions / settings **per user**.
- **File PDF tetap dibagi.** `download_id = fnv1a64("handle|number")`
  (`downloads.rs:134`) sudah content-addressed: chapter yang sama = ID yang sama =
  satu file. 10 orang baca judul yang sama → disk terpakai sekali.
- **Refcount**: unduh pertama → `refs[id] = 1`. Unduh kedua oleh user lain → `2`.
  Hapus dari satu user → turun. **File fisik dihapus hanya saat refcount = 0.**
  Tanpa ini, satu orang hapus unduhan = orang lain kehilangan PDF-nya.
- `GET /api/unified/downloads/:id` hanya melayani kalau ID ada di index user itu.
- Limit + eviction per user. **Risiko**: 10 user × limit default bisa melebihi disk
  free tier. Tambahkan cek total global sebelum menulis file baru; tolak dengan
  507 kalau melebihi.

Handler di `unified.rs` (`u_download_pdf`, `u_downloads`, `u_download_file`,
`u_download_delete`, `u_download_delete_all`, `u_settings_get`, `u_settings_put`)
menerima username dari `require_user(headers)`.

---

## 5. Frontend

### `account.ts` (baru) — fondasi, dibekukan lebih dulu

```ts
export function getUser(): string | null;

/** created=true → akun baru; false → akun sudah ada; null → boot / ganti akun. */
export type AccountEvent = { username: string | null; created: boolean | null };
export function setUser(username: string | null, created?: boolean): void;
export function onAccountChange(cb: (e: AccountEvent) => void): () => void;
export function captureFromUrl(): string | null;      // baca ?u=, simpan, strip dari URL
export function normalizeUsername(raw: string): string;
export function isValidUsername(u: string): boolean;  // aturan sama dengan server
```

**Aturan arah sinkronisasi — satu aturan untuk favorit DAN progress:**

```
created === true   → PUSH  (akun baru: adopsi rak device ini ke server)
created !== true   → PULL  (akun lama, boot, ganti akun: server menang)
```

`created !== true` sengaja dipakai (bukan `=== false`) supaya **boot** dan
**ganti akun** ikut PULL — dua kasus itu `created` = `null`, dan keduanya memang
harus server-menang: boot wajib hydrate sebelum boleh push, dan ganti akun tidak
boleh membocorkan rak akun sebelumnya.

Key localStorage: `komik-akun-v1`. `captureFromUrl` memakai
`history.replaceState` supaya kode tidak tertinggal di address bar.

### `api.ts` — header otomatis

`get()` dan `send()` menyisipkan `X-Komik-User` kalau `getUser()` tidak null.
Tambahan: `userApi.claim(username)`, `userApi.me()`, `progressApi.get()`,
`progressApi.put(entries)`, dan `notifApi.getFavorites()`.

### Sinkron favorit — **urutan wajib: hydrate dulu, baru push**

Ini bagian paling rawan. `notifStore` sekarang push replace-all, dan server
membuang favorit yang tidak ada di kiriman (`notif.rs:345`).

Kalau push terjadi sebelum hydrate: buka di laptop yang raknya masih lama →
push rak lama → **favorit di HP terhapus**.

Aturan:

```
startFavoritesSync():
  kalau getUser() === null  → no-op (app tetap jalan lokal, tanpa sync)
  GET /api/notif/favorites
  rakStore.replaceFavorites(serverFavorites, { silent: true })
  notifStore.lastSentHash = hash(payload hasil hydrate)   ← cegah push balik
  baru pasang listener 'rak-change' + izinkan push
```

`rakStore` dapat fungsi baru `replaceFavorites(entries, opts?)`. `silent:true`
berarti **tidak** memancarkan `rak-change` (supaya tidak memicu push).

**Migrasi saat claim:**

| `created` | Arah |
|---|---|
| `true` (akun baru) | **push** rak lokal ke server (adopsi rak device) |
| `false` (akun lama) | **pull** rak server, timpa lokal (adopsi rak server) |

Ini yang bikin "ganti akun" masuk akal: data akun lama tetap utuh di servernya.

### Sinkron progress (`useProgress.ts`)

Urutan sama: pull → merge → push.

- Merge per `seriesId`: ambil entri dengan `at` terbesar.
- `MAX = 24` dipertahankan.
- localStorage tetap jadi cache; kalau `getUser() === null`, perilaku lama
  (murni lokal) tidak berubah.
- Debounce push, jangan blok UI.

Endpoint: `GET /api/progress` → `{entries:[...]}`; `PUT /api/progress` `{entries:[...]}`
→ `{ok,count}`. Bentuk entri = `ProgressEntry` di `useProgress.ts:3`.

### Halaman `/akun` (`pages/Akun.tsx` baru)

**Belum masuk:**
```
  Masuk atau daftar
  [ username              ]
  [ Lanjut ]
  Belum punya? Ketik nama baru — langsung dibuat.
```

**Sudah masuk:**
```
  <username>
  Tautan akun: <origin>/?u=<username>   [ Salin ]
  [ Ganti akun ]   [ Keluar ]
```

- `App.tsx`: tambah `<Route path="/akun" element={<Akun />} />`
- `App.tsx` TopBar: tambah `CircleButton` dengan `IconUser` (sudah ada di
  `icons.tsx`) menuju `/akun`.
- Ganti akun = `setUser(null)` lalu tampilkan form lagi.

---

## 6. Verifikasi

| Lane | Perintah |
|---|---|
| Server | `cargo test` di `komiku-server/` |
| Web | `npm run build` + `npm run lint` di `komiku-web/` |
| Integrasi | server jalan → curl dua user berbeda → pastikan favorit tidak saling bocor |

Test yang **wajib** ada:

- `normalize_username`: valid, uppercase→lowercase, terlalu pendek, karakter
  terlarang, percobaan path traversal (`../x`, `a/b`) ditolak.
- Isolasi: favorit user A tidak muncul di `GET /api/notif/favorites` user B.
- Refcount: dua user unduh chapter sama → satu file; user A hapus → file masih ada
  dan user B masih bisa ambil; user B hapus → file hilang.
- `replaceFavorites` silent tidak memicu push.
- Merge progress: entri `at` lebih besar menang.

---

## 7. Di luar cakupan

- Password, email, reset akun, verifikasi.
- Multi-tenant beneran (akun rahasia). Kalau nanti perlu, baru tambah kode akses
  per akun — desainnya sudah menyediakan tempatnya (`data/users/<username>.json`).
- Perubahan pada fetch sumber / cache katalog (tetap global, sengaja).
- Migrasi otomatis `data/state.json` lama. File lama dibiarkan; user baru mulai bersih.

## 8. Risiko

| Risiko | Mitigasi |
|---|---|
| Push sebelum hydrate → favorit terhapus | Gate eksplisit di `startFavoritesSync` (§5) + test |
| Refcount salah → PDF orang lain terhapus | Test wajib di §6 |
| Path traversal lewat username | Alfabet dibatasi `[a-z0-9_-]` + test |
| Disk free tier penuh (10 user × limit) | Cek total global, tolak 507 |
| Dua orang pakai username sama → berbagi akun | Diterima; konsekuensi model username-only |
