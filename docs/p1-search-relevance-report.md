# P1 — Relevansi Search: Akar Masalah & Fix Konkret

Tanggal: 2026-10-29. Semua angka di bawah **terukur** (bukan perkiraan) lewat
`komik/target/debug/komik search <q> --limit 200`, yang menjalankan jalur kode
yang sama dengan `/api/unified/search`.

---

## 1. Contoh nyata dulu

```
$ komik search "nano machine"
komiku:5179     Nano Machine                        [Ch 336 | Manhwa | Ongoing]
shinigami:4b42  Legend Of Heavenly Chaos Demon      [Ch 122 | Manhwa | Ongoing]  ← sampah
shinigami:f0a8  Absolute Sword Sense                [Ch 207 | Manhwa | Ongoing]  ← sampah
```

Bukan kasus terisolasi. `one piece` mengembalikan **27** item, hanya **3** yang
judulnya memuat kedua kata. `solo leveling` → 30 item, **4** relevan.

---

## 2. Akar masalah (dua lapis, keduanya nyata)

### Lapis A — upstream shinigami memang fuzzy, dan mencocokkan field non-judul

```
GET https://api.shngm.io/v1/manga/list?page=1&page_size=20&q=nano+machine
→ total_record: 3
   Nano Machine
   Absolute Sword Sense          ← deskripsi: "Dari author yang sama dengan Nano Machine"
   Legend Of Heavenly Chaos Demon ← deskripsi: "...penulis yang membawakan Nano Machine..."
```

Parameter `search_by` **tidak berfungsi** — `title`, `alternative_title`, `all`,
`synopsis` menghasilkan respons identik byte-per-byte. Tidak ada cara meminta
"judul saja" ke upstream.

Konsekuensi penting: ada kelas kueri yang **hanya** cocok di field yang tidak
kita lihat. `q=redice` → 30 item, **tidak satu pun** memuat "redice" di judul;
upstream mencocokkan studio/author. Ini bukan bug kita, tapi harus ditangani
secara sadar (lihat §5).

### Lapis B — `rank_by_query` hanya MENGURUTKAN, tidak pernah MEMBUANG

`komik/core/src/aggregator.rs:2119`

```rust
pub fn rank_by_query<T: Rankable>(items: Vec<T>, query: &str) -> Vec<T> {
    // ...
    out.sort_by(|a, b| {
        let (ta, ma) = match_tier(&a.rank_title_key().to_lowercase(), &tokens, &query_key);
        let (tb, mb) = match_tier(&b.rank_title_key().to_lowercase(), &tokens, &query_key);
        ta.cmp(&tb).then_with(|| mb.cmp(&ma)).then_with(|| rank_cmp(a, b))
    });
    out   // ← jumlah item TIDAK pernah berubah
}
```

`match_tier` (`:2053`) punya `Exact | Prefix | AllTokens | Partial | NoMatch`.
`NoMatch` diperlakukan sebagai **tier urutan**, bukan sebagai **sinyal buang**.
Item yang judulnya sama sekali tidak berbagi kata dengan kueri tetap sampai ke
UI, hanya duduk di bawah.

Lapis B inilah yang mengubah "upstream agak fuzzy" menjadi "UI menampilkan
sampah sebagai hasil". Tanpa Lapis B, 2 item shinigami itu akan terlihat sebagai
"hasil tambahan", bukan "hasil yang salah".

---

## 3. Jawaban pertanyaan yang diminta

### 3a. Test yang mengunci perilaku "NoMatch tetap dikembalikan" — ADA

| Lokasi | Test | Status setelah fix |
|---|---|---|
| `aggregator.rs:2385` | `hasil_set_tidak_berubah` — fixture `"Unrelated Title"` + `assert_eq!(out.len(), input.len())` | **GAGAL** — ini pengunci sebenarnya. Harus diubah. |
| `aggregator.rs:2290` | `exact_mengalahkan_non_match_yang_lebih_baru` | **LOLOS** — meski namanya "non_match", fixture `"Solo Necromancy"` untuk kueri `"solo leveling"` sebenarnya **Partial** (1 token cocok), bukan NoMatch. Nama test menyesatkan; sebaiknya di-rename. |
| `core/tests/aggregator_units.rs` | tidak ada | tidak terpengaruh |
| `komiku-server/src/unified.rs:1813` | `assert_eq!(out0.items.len(), 0)` | tidak terpengaruh (itu filter tipe, bukan NoMatch) |

### 3b. Apakah `search_dua_fase` dan `search_in_genre` kena? — YA, semua jalur

`rank_by_query` dipanggil di **5 titik**, semuanya jalur search:

| Baris | Fungsi | Kena? |
|---|---|---|
| `aggregator.rs:560` | `search` | ya |
| `aggregator.rs:594` | `search_dua_fase` — cache hit fase 2 | ya |
| `aggregator.rs:668` | `search_dua_fase` — task background penulis cache | ya |
| `aggregator.rs:679` | `search_dua_fase` — respons fase 1 | ya |
| `aggregator.rs:716` | `search_in_genre` | ya |
| `unified.rs:314` | `list_out_filtered` (dipakai `/api/unified/search` **dan** `/catalogue`) | ya, saat `query` ada |

Karena itu fix **cukup di dalam `rank_by_query`** — satu perubahan menutup
keenam jalur, termasuk fase 1/2 dan cache (cache menyimpan hasil yang sudah
terfilter, jadi konsisten).

### 3c. Aman filter `NoMatch` saja, atau perlu fallback? — PERLU FALLBACK

Data terukur (limit 200):

| Query | Total | Exact | Prefix | AllTokens | Partial | NoMatch | Setelah buang NoMatch |
|---|---|---|---|---|---|---|---|
| `nano machine` | 3 | 1 | 0 | 0 | 0 | 2 | **1** |
| `machine nano` | 8 | 0 | 0 | 1 | 0 | 7 | **1** |
| `nano` | 41–44 | 0 | 2 | 33 | 0 | 6 | 35 |
| `machine` | 16 | 0 | 1 | 3 | 0 | 12 | 4 |
| `one piece` | 27 | 1 | 2 | 0 | 12 | 12 | 15 |
| `solo leveling` | 30 | 1 | 3 | 0 | 8 | 18 | 12 |
| `art` | 75 | 0 | 2 | 58 | 0 | 15 | 60 |
| `the` | 68 | 0 | 39 | 23 | 0 | 6 | 62 |
| **`redice`** | **30** | 0 | 0 | 0 | 0 | **30** | **0** ← bahaya |
| `zzz` | 0 | — | — | — | — | — | 0 |

**Kesimpulan:** filter `NoMatch` saja **tidak cukup**. `redice` (dan kelas kueri
author/studio: `chugong`, `siu`, `studio redice`) akan berubah dari 30 hasil
menjadi **0 hasil** — kebohongan baru yang lebih buruk daripada sampah, karena
user diberi tahu "tidak ada" padahal ada.

Jadi: **filter + graceful degradation**. Degradasi hanya aktif ketika
**seluruh** item NoMatch (tidak ada satu pun sinyal judul). Saat itu, kembalikan
input apa adanya dan biarkan lapisan atas menandainya.

Catatan: klaim di `docs/p1-p3-investigation.md:45` ("18 query, tidak ada satu
pun yang jadi 0") **tidak akurat** — `redice` adalah counter-example yang
terukur.

### 3d. Apakah `nano` aman? — Ya, dan justru membaik

Kekhawatiran "filter memotong `nano` jadi 0" tidak terbukti: 41–44 → 35 item.
Yang dibuang 6 item, semuanya NoMatch asli (mis. `Legend Of Heavenly Chaos
Demon` yang cocok lewat deskripsi).

Tapi ada temuan **sekunder** di sini: pencocokan token memakai `contains`
(substring), bukan batas kata. `nano` ikut mencocokkan judul Jepang
`...Onnanoko...` (`o·nano·ko`), `art` mencocokkan `M·art·ial`. Terukur:

| Query | Lolos (substring, sekarang) | Lolos (word-boundary) | Dibuang |
|---|---|---|---|
| `art` | 60 | 25 | 35 |
| `nano` | 38 | 16 | 22 |
| `one piece` | 3 | 3 | 0 |
| `solo leveling` | 4 | 4 | 0 |

Untuk kueri multi-kata, substring vs word-boundary **tidak berbeda** — jadi ini
bukan penyebab P1, melainkan noise tambahan untuk kueri pendek. Layak jadi fix
tahap 2, bukan tahap 1.

---

## 4. Diff sketsa (BELUM diterapkan)

### 4a. `komik/core/src/aggregator.rs` — sebelum `rank_by_query` (~baris 2119)

```rust
/// Token kueri: lowercase, tanpa duplikat, urutan dipertahankan.
/// (Diekstrak dari `rank_by_query` supaya filter & sort memakai token identik.)
fn query_tokens(query: &str) -> Vec<String> {
    let mut seen = HashSet::new();
    query
        .to_lowercase()
        .split_whitespace()
        .filter(|t| seen.insert(t.to_string()))
        .map(|t| t.to_string())
        .collect()
}

/// Buang item yang judulnya TIDAK berbagi satu token pun dengan kueri
/// (`MatchTier::NoMatch`).
///
/// Kenapa: sumber (shinigami) mencocokkan author/studio/sinopsis, bukan hanya
/// judul, lalu mengembalikan item yang judulnya sama sekali asing. `rank_by_query`
/// hanya MENGURUTKAN mereka ke bawah — tidak membuang — sehingga "nano machine"
/// menampilkan 2 judul tak berhubungan di bawah hasil yang benar.
///
/// Degradasi anggun: kalau SEMUA item NoMatch (mis. `q=redice`, yang di upstream
/// cocok lewat studio), hasil filter = 0. Membalas "tidak ada hasil" untuk kueri
/// yang jelas punya hasil adalah kebohongan baru, jadi kembalikan input apa adanya.
fn retain_relevant<T: Rankable>(items: Vec<T>, query: &str) -> Vec<T> {
    let tokens = query_tokens(query);
    if tokens.is_empty() {
        return items; // kueri kosong = no-op (kontrak lama)
    }
    let query_key = tokens.join(" ");
    let keep: Vec<bool> = items
        .iter()
        .map(|it| {
            match_tier(&it.rank_title_key().to_lowercase(), &tokens, &query_key).0
                != MatchTier::NoMatch
        })
        .collect();

    // Tidak ada satu pun sinyal judul -> jangan balas kosong.
    if !keep.iter().any(|k| *k) {
        return items;
    }
    items
        .into_iter()
        .zip(keep)
        .filter_map(|(it, k)| k.then_some(it))
        .collect()
}
```

### 4b. `rank_by_query` — tambah satu baris filter

```rust
 pub fn rank_by_query<T: Rankable>(items: Vec<T>, query: &str) -> Vec<T> {
-    let mut seen = HashSet::new();
-    let tokens: Vec<String> = query
-        .to_lowercase()
-        .split_whitespace()
-        .filter(|t| seen.insert(t.to_string()))
-        .map(|t| t.to_string())
-        .collect();
+    let mut out = retain_relevant(items, query);   // <-- FILTER
+    let tokens = query_tokens(query);
     if tokens.is_empty() {
-        return items;
+        return out;
     }
     let query_key = tokens.join(" ");
-    let mut out: Vec<T> = items;
     out.sort_by(|a, b| { /* tidak berubah */ });
     out
 }
```

### 4c. Test yang harus ikut berubah

```rust
// aggregator.rs:2385 — GANTI nama + ekspektasi.
#[test]
fn hasil_set_tidak_berubah_kecuali_nomatch() {
    let input = vec![
        m("komiku", "a", "Solo Leveling"),
        m("komiku", "b", "Solo Leveling Reawakening"),
        m("komiku", "c", "Solo Necromancy"),
        m("komiku", "d", "Unrelated Title"),   // NoMatch -> HARUS hilang
        m("komiku", "e", "solo max level newbie"),
    ];
    let out = rank_by_query(input, "solo leveling");
    assert_eq!(out.len(), 4, "NoMatch dibuang, sisanya utuh");
    assert!(!ids(&out).contains(&"d"));
}

// BARU — kasus utama P1.
#[test]
fn nomatch_dibuang_saat_ada_yang_cocok() {
    let input = vec![
        m("shinigami", "nano", "Nano Machine"),
        m("shinigami", "sword", "Absolute Sword Sense"),
        m("shinigami", "demon", "Legend Of Heavenly Chaos Demon"),
    ];
    let out = rank_by_query(input, "nano machine");
    assert_eq!(ids(&out), vec!["nano"]);
}

// BARU — graceful degradation (kelas kueri author/studio).
#[test]
fn semua_nomatch_dikembalikan_utuh() {
    let input = vec![
        m("shinigami", "a", "Nano Machine"),
        m("shinigami", "b", "Pick Me Up"),
    ];
    let out = rank_by_query(input, "redice");
    assert_eq!(out.len(), 2, "jangan balas 0 untuk kueri author/studio");
}

// BARU — Partial tidak boleh ikut terbuang.
#[test]
fn nomatch_tidak_memotong_partial() {
    let input = vec![
        m("shinigami", "one", "One Piece"),
        m("shinigami", "punch", "One Punch Man"),
        m("shinigami", "unrelated", "Kingdom"),
    ];
    let out = rank_by_query(input, "one piece");
    assert_eq!(ids(&out), vec!["one", "punch"]);
}
```

### 4d. Nama test yang menyesatkan (bukan gagal, tapi perbaiki)

```rust
// :2290 — fixture-nya Partial, bukan NoMatch.
- fn exact_mengalahkan_non_match_yang_lebih_baru()
+ fn exact_mengalahkan_partial_yang_lebih_baru()
```

---

## 5. Efek samping yang WAJIB ikut diperbaiki: `has_more` jadi bohong

`komiku-server/src/unified.rs:326`

```rust
out.has_more = out.items.len() >= max;   // dihitung SETELAH filter
out.items.truncate(max);
```

Setelah `NoMatch` dibuang, `out.items.len()` menyusut, sehingga `has_more`
berubah `false` padahal halaman berikutnya masih ada isi. Terukur:

```
"one piece"  page 1: 27 item (3 relevan)   -> setelah filter 15
"one piece"  page 2:  2 item (2 relevan)   -> TIDAK PERNAH TERJANGKAU
```

Tombol "Berikutnya" akan mati di halaman 1. Fix: hitung `has_more` dari jumlah
**sebelum** filter, mis. tambahkan `filtered_out: usize` ke `ListOut` lalu
`has_more = items.len() + filtered_out >= max`, atau simpan `pre_filter_len`
sebelum `rank_by_query`.

---

## 6. Urutan pengerjaan yang disarankan

| # | Langkah | Risiko | Dampak |
|---|---|---|---|
| 1 | `retain_relevant` + filter di `rank_by_query` (§4a–4b) | rendah | `nano machine` 3→1, `one piece` 27→15, `solo leveling` 30→12 |
| 2 | Update test §4c + rename §4d | rendah | kontrak terkunci ulang |
| 3 | Perbaiki `has_more` (§5) | rendah | paginasi tidak patah |
| 4 | (opsional) word-boundary `word.starts_with(token)` ganti `contains` | sedang | `art` 60→25, `nano` 38→16 |
| 5 | (opsional) `search_blob` = title + alt title + author + studio, cocokkan ke blob & tandai `matched_field` | sedang | `redice` tidak lagi bergantung pada degradasi; UI bisa bilang "cocok di author/studio" |

Langkah 5 adalah jawaban jujur untuk Lapis A: selama kita hanya melihat judul,
kelas kueri author/studio **tidak bisa** dibedakan dari sampah — jadi tandai,
jangan sembunyikan.
