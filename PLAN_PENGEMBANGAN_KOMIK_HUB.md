# Rencana Pengembangan UI/UX Komik Hub

Sasaran utama adalah membantu pembaca menemukan komik, membaca dengan nyaman, dan kembali ke panel terakhir dalam mode baca yang sama.

Rencana ini berdasarkan audit sebagai tamu di Chromium pada viewport 1.212 × 799 dan 400 × 639 piksel. Alur setelah login dan perilaku di perangkat sentuh perlu diverifikasi saat implementasi. [Situs Komik Hub](https://komik-hub-web-1-b6au7e.runkiri.cloud/)

## Urutan pengerjaan

| Prioritas | Paket | Target |
| --- | --- | --- |
| P0 | Lanjut baca | Pulihkan chapter, panel, dan mode baca dari Beranda, Rak, serta detail seri. |
| P0 | Reader dan Preferensi | Perbesar area baca dan pastikan seluruh kontrol dapat dijangkau. |
| P1 | Pencarian dan detail seri | Tampilkan hasil lebih cepat di HP dan permudah lompat ke chapter tertentu. |
| P1 | Beranda, Rak, dan Unduhan | Tampilkan bacaan pribadi lebih awal dan beri aksi yang jelas sesuai status. |
| P2 | Animasi dan aksesibilitas | Beri umpan balik tanpa menggeser panel komik. |

## 0. Persiapan

- [ ] Petakan jalur penyimpanan progres di reader biasa dan Maraton, termasuk cara seri serta chapter dicocokkan lintas sumber.
- [ ] Rekam ulang kasus Solo Leveling. Saat ditinggalkan, Maraton menunjukkan Chapter 00.1 halaman 3/52. Rak membuka reader biasa di halaman 8–9. Detail yang dibuka dari Favorit menawarkan Chapter 0.
- [ ] Siapkan data uji untuk tamu, akun, catatan progres lama, dan sumber cadangan. Catat waktu hingga gambar pertama tampil sebagai pembanding.

## 1. P0 — Pulihkan posisi "Lanjut baca"

- [ ] Gunakan satu catatan progres per pengguna atau sesi tamu dan per seri. Gunakan relasi seri lintas sumber yang sudah terverifikasi.
- [ ] Simpan identitas chapter dalam bentuk string agar `0` dan `00.1` tetap berbeda. Simpan juga sumber, mode baca, nomor halaman, dan posisi relatif di dalam gambar.
- [ ] Simpan saat pengguna menggulir dan pastikan posisi terakhir tersimpan saat pindah chapter atau meninggalkan reader. Pembaruan yang tiba terlambat tidak boleh menimpa posisi yang lebih baru.
- [ ] Arahkan tombol Lanjut baca di Beranda, Rak, dan detail ke catatan yang sama. Pulihkan posisi setelah dimensi gambar tersedia. Untuk data lama yang hanya memiliki nomor chapter, lanjutkan dari awal chapter itu.
- [ ] Saat sumber berganti, pulihkan halaman bila versi yang setara dapat dipetakan. Jika pemetaan belum tersedia, buka awal chapter yang sama dan jelaskan pergantian sumber.

**Kriteria selesai.** Tinggalkan Chapter 00.1 di halaman 3 dalam mode Maraton. Buka lagi dari Beranda, Rak, dan detail secara terpisah. Ketiganya membuka chapter, mode, serta panel yang sama, termasuk setelah memuat ulang atau mengubah lebar layar. Menunggu gambar selesai dimuat tidak menandai chapter sebagai selesai dibaca.

## 2. P0 — Ringkas reader dan perbaiki Preferensi

- [ ] Jadikan kontrol bawah satu baris berisi **Sebelumnya**, **Chapter**, dan **Berikutnya**. Nonaktifkan aksi yang tidak tersedia dan tampilkan tombol **Chapter berikutnya** di akhir chapter.
- [ ] Pertahankan ketuk panel untuk menyembunyikan kontrol. Sediakan pemicu lewat keyboard dan keluarkan kontrol tersembunyi dari urutan Tab.
- [ ] Batasi tinggi dialog Preferensi mengikuti viewport. Buat area opsi dapat digulir dengan judul serta tombol **Tutup** selalu terlihat. Dukung Escape dan kembalikan fokus ke tombol pembuka.
- [ ] Tampilkan progres sebagai **Hal. 3 dari 52**. Beri label tersendiri untuk pemuatan gambar. Jika satu gambar gagal, sediakan **Coba lagi** pada gambar itu sambil menjaga ukuran panel.
- [ ] Pertahankan pesan singkat ketika chapter dilayani sumber cadangan dan pastikan pembaca layar dapat mengumumkannya.

**Kriteria selesai.** Pada tinggi layar 639 dan 799 piksel, seluruh opsi Preferensi dapat diakses. Uji chapter pertama, tengah, dan terakhir di kedua mode. Ketuk panel, buka menu, dan coba ulang gambar tanpa memindahkan posisi komik yang sedang dibaca.

## 3. P1 — Sederhanakan Cari dan daftar chapter

- [ ] Di HP, tampilkan **Cari komik**, satu tombol **Filter**, filter aktif, jumlah hasil, lalu kartu komik.
- [ ] Masukkan sumber, urutan, tipe, status, dan genre ke panel dengan tombol **Terapkan** serta **Reset**. Tampilkan pencarian terakhir dan saran ketika kolom kosong.
- [ ] Buka Cari dari atas saat masuk melalui navigasi. Simpan query, filter, dan posisi hasil saat pengguna membuka detail agar tombol Kembali dapat memulihkan ketiganya.
- [ ] Bedakan keadaan memuat, hasil kosong, dan gagal. Tawarkan **Reset filter** jika filter aktif dan hasil kosong.
- [ ] Beri label pada nomor dan jumlah chapter, misalnya **Terbaru · Ch. 180** dan **190 entri chapter**. Tampilkan sumber jika kedua angka memakai cakupan berbeda.
- [ ] Gunakan pencarian nomor chapter yang sudah ada di reader pada halaman detail. Dukung nomor desimal, urutan lama atau terbaru, dan status baca.

**Kriteria selesai.** Label filter terbaca pada lebar 400 piksel dan kartu pertama terlihat tanpa melewati beberapa baris kontrol. Cari Solo Leveling, buka detail, lalu kembali ke hasil dengan filter dan posisi gulir yang sama. Pencarian `00.1` membuka chapter yang tepat.

## 4. P1 — Tata Beranda, Rak, dan Unduhan

- [ ] Letakkan **Lanjut membaca** di bawah header bila pembaca punya riwayat. Tampilkan judul, chapter, halaman, dan tombol **Lanjut**.
- [ ] Ringkas banner Beranda agar pengunjung baru melihat awal katalog pada layar pertama.
- [ ] Ubah label **Sejarah** menjadi **Riwayat baca** dan jadikan tab awal Rak. Pertahankan akses ke katalog Terbaru melalui Beranda atau Cari dan tangani tautan lamanya.
- [ ] Tampilkan **Tersimpan di Rak** setelah Favorit berhasil disimpan. Beri tombol **Cari komik** ketika Favorit masih kosong.
- [ ] Jika unduhan perlu akun, tampilkan **Masuk untuk mengunduh** dan pulihkan pilihan chapter setelah login. Bedakan keadaan kosong, sedang memuat, dan gagal yang bisa dicoba ulang.

**Kriteria selesai.** Favorit dari Cari muncul di Rak. Pembaca yang kembali bisa langsung melanjutkan bacaan. Tamu mendapat aksi yang sesuai saat membuka Unduhan dan kembali ke chapter pilihan setelah login.

## 5. P2 — Terapkan animasi dan aksesibilitas

| Interaksi | Perilaku |
| --- | --- |
| Toolbar reader | Fade 140–180 ms. Pertahankan posisi gulir dan panel yang terlihat. |
| Filter dan Pilih Chapter | Geser dari bawah selama 200–240 ms dengan perlambatan di akhir. Kembalikan fokus ke tombol pembuka saat panel ditutup. |
| Favorit | Isi ikon saat status berubah, beri pembesaran satu kali sekitar 1,08× selama 150 ms, lalu tampilkan konfirmasi teks. |
| Pemuatan gambar | Sediakan ruang sesuai rasio gambar sejak awal. Pertahankan ukuran area saat gambar muncul atau dicoba ulang. |
| Carousel Beranda | Pertahankan tombol jeda, hentikan putar otomatis setelah interaksi manual, dan sinkronkan indikator dengan slide yang tampil. |

- [ ] Saat `prefers-reduced-motion: reduce` aktif, matikan putar otomatis dan gunakan perubahan langsung atau fade singkat.
- [ ] Targetkan kontras minimal 4,5:1 untuk teks normal. Mulai dari tautan **Lihat rak** pada tema gelap yang terukur sekitar 3,03:1.
- [ ] Periksa fokus keyboard, label tombol ikon, dan target sentuh utama sekitar 44 × 44 piksel. Uji saat teks diperbesar atau membungkus.

## Validasi dan rilis

- [ ] Uji alur **Cari → Detail → Baca → Maraton → Rak → Lanjut** pada lebar 360, 400, 768, 1.212, dan 1.440 piksel. Gunakan setidaknya satu perangkat sentuh dan jalankan satu alur dengan keyboard.
- [ ] Uji tamu, akun, progres lama, pergantian sumber, koneksi lambat, gambar gagal, dan pembaruan progres yang tiba tidak berurutan.
- [ ] Bandingkan waktu hingga panel pertama tampil dan kestabilan posisi gulir sebelum dan sesudah perubahan.
- [ ] Rilis per paket, mulai dari progres baca dan reader. Pantau laporan chapter salah, posisi hilang, dan gambar gagal dimuat.
- [ ] Sebelum rilis publik, verifikasi pemilik akun dan uji bahwa riwayat tiap pengguna terisolasi. Untuk demo bersama, gunakan label **Pilih profil** agar fungsi username jelas. Gunakan domain produk agar pengunjung publik langsung mencapai beranda.
