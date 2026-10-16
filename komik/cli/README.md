# komik — CLI baca komik multi-sumber

Baca komik lintas sumber (Komiku, Mangaku, Shinigami, Kiryuu) dari terminal.
Chapter yang tidak ada di sumber utama otomatis dibaca dari sumber lain
yang punya judul sama — tanpa flag, tanpa dialog.

## Perintah

```
komik popular                      # ranking populer (semua sumber, digabung)
komik latest                       # update terbaru
komik search "<judul>"             # cari judul
komik genres                       # daftar genre
komik list [judul] [--genre G] [--status S] [--sort updated|title]
komik series <id|judul> [-n 30] [--last-source kiryuu]
komik read <id|judul> <chapter> [-o DIR] [--pdf -o out.pdf]
```

`<id>` boleh berbentuk `sumber:native_id` (mis. `komiku:1308`) atau judul
polos (`solo-leveling`). Flag global: `--source <nama>` batasi ke satu
sumber, `--no-cache` matikan disk cache (default TTL 10 menit).

## Cross-source chapter fallback

`komik read komiku:1308 179.6` — kalau chapter 179.6 tidak ada di komiku:

```
note: chapter 179.6 tidak ada di komiku — dibaca dari kiryuu
https://v2.yuucdn.net/.../00.jpg
...
next: komik read kiryuu:solo-leveling 0
prev: komik read kiryuu:solo-leveling 179.5
```

- `note:` (stderr) muncul hanya kalau sumber berpindah.
- URL gambar dicetak ke stdout; stderr hanya untuk catatan/navigasi, jadi
  `komik read ... | xargs curl` tetap bersih.
- `next:` / `prev:` memakai handle dari sumber yang MELAYANI, jadi
  "lanjut baca" lintas sumber jalan apa adanya. Di tepi atas/bawah baris
  itu tidak muncul.
- `-o DIR` dan `--pdf -o x.pdf` sama seperti sebelumnya.

## Sticky source (sumber terakhir dibaca)

Setiap `read` sukses menyimpan sumber yang benar-benar melayani ke disk
cache (`~/.komik/cache/`, kunci `last-source:<judul>`, TTL 10 menit).
`komik series <id|judul>` membaca entri itu dan mencoba sumber tersebut
lebih dulu; kalau hasil resolve ternyata dari sumber lain, muncul 1 baris:

```
(menampilkan chapter dari shinigami — sumber terakhir kamu baca)
```

Override eksplisit: `komik series komiku:1308 --last-source kiryuu`.

## Risiko diketahui

- **Offset nomor antar-sumber** (by design): judul identik + nomor ada di
  dua sumber = nomor sumber pemenang dipakai. Mitigasi: baris `note:` +
  handle di navigasi.
- **Bug Lane-1 (diketahui)**: penanda negatif "chapter absen di primary"
  (TTL 60s) bisa bikin read ULANG chapter yang sama, kurang dari 60 detik
  setelah read pertama, melewati primary sebelum judul aslinya diketahui —
  sumber lain lalu dicari pakai slug id dan selalu miss. CLI mengakalinya
  dengan retry sekali memakai judul (hanya di jalur gagal); perbaikan
  sebenarnya ada di `Aggregator::read_chapter_any` (core).
- **Kegagalan jaringan** tidak di-cache sebagai "tidak ada"; pesan akhir
  membedakan "tidak ditemukan" dari "semua sumber gagal diakses".

## Build & test

```bash
bash scripts/build.sh check   # cargo check
bash scripts/build.sh build   # cargo build
bash scripts/build.sh test    # cargo test (core + unit test CLI)
```

Catatan: `scripts/build.sh` melepas TMP/TEMP untuk hindari LNK1104 dari
link.exe; binary keluar di `target/debug/komik.exe`.
