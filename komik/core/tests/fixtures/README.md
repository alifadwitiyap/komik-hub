# Fixture capture — response live 4 sumber manga

Direkam: **2026-10-13 ~19:39–19:44 WIB (SEA Standard Time, UTC+07:00)**
Host capture: Windows 11 + git-bash, `curl` 7.87 + Python 3.11.16.
Setiap endpoint di-hit **1x** live (kecuali retry otomatis pada 401/403 komiku,
lihat catatan). Header standar: browser `User-Agent` Chrome/131.

Tujuan: test adapter (`komik-core/src/adapters/*`) + aggregator, tanpa jaringan.

---

## komiku (Komiku+ / KomikId mobile API)

Host: `https://index.komikid.org/` (homepage/search/catalogue) dan
`https://content.komikid.org/` (detail + chapter).
Referensi lengkap: `C:\Users\LENOVO LEGION\AppData\Local\hermes\skills\integration\api-reverse-engineering\references\komiku-mobile-api.md`.

**WAJIB header `x-secure-seeds`** (AES-256-CBC dari timestamp millis, PBKDF2-HMAC-SHA1
65536 iter, key 32 byte) atau server balas **403**. Header bersifat timestamp-based →
pakai `komiku.py:seeds()` dari `D:/project/archived/komiku-cli/komiku.py`
(konstanta: seed `qyGjx5h7Bs`, password `org.komiku.qyGjx5V46Tkhh7Bs`, salt `179`,
65536 iter, IV `00..0f`). Header lain yang dikirim: `x-package-name: id.komiku.plus`,
`x-version-code: 11`, `x-country-code: ID`, `Accept: application/json`.

| File | Endpoint | Ukuran | Catatan |
|---|---|---|---|
| `homepage.json` | `GET index.komikid.org/?content=homepage` | 120 562 B | sectioned: `trending`/`hot`/`terbaru`/`genre`/`status`/`recommendation` — **bukan** `data` |
| `search_one_piece.json` | `GET index.komikid.org/page/1/?s=one+piece` | 6 628 B | key response = **`manga`** (bukan `data`); `pages` = jumlah halaman |
| `manga_6426.json` | `GET content.komikid.org/?content=manga&id=6426` | 127 421 B | One Piece; `series{}` + `related[]`; field `chapter` & `series.previews` = blob base64 AES (**jangan di-decrypt di fixture**) |
| `chapter_113228.json` | `GET content.komikid.org/?content=chapter&id=113228` | 2 686 B | Solo Leveling Chapter 180; `chapter.image` + `chapter.thumbnail` = blob AES base64; `chapter.server` = map host |
| `mangalist.partial.json` | `GET index.komikid.org/?content=mangalist` (`Range: bytes=0-51199`) | 51 200 B | **slice mentah, sengaja BUKAN JSON utuh** (full response 5.6 MB; dipotong di tengah entry). Kalau perlu fixture valid, pakai `mangalist.trimmed.json` |
| `mangalist.trimmed.json` | (turunan dari file di atas, diparse lalu dirapatkan) | 6 814 B | JSON valid: 7 bucket (`#`, `&`, `+`, `-`, `.`, `0`, `1`), 1 entry per bucket. Struktur = `data` dict bucket per huruf awal, tiap value array objek manga |

**Catatan penting untuk adapter**
- Bentuk response **beda per host**: search → `manga`, catalogue → `data` bucket-per-huruf,
  homepage → sectioned. Jangan pakai satu parser untuk semua.
- Chapter list & image list **terenkripsi** di wire; fixture menyimpan ciphertext apa adanya.
- Slug/id berbasis integer (`6426`), chapter id integer (`113228`).

---

## shinigami (api.shngm.io)

Host: `https://api.shngm.io/v1` — tanpa auth, tanpa enkripsi.
Envelope: `{retcode, message, meta{request_id,page,page_size,total_page,total_record}, data}`.
ID berbentuk **UUID**. Error = HTTP non-2xx + `{retcode, message}`.

| File | Endpoint | Ukuran | Catatan |
|---|---|---|---|
| `manga_list_popularity.json` | `GET /v1/manga/list?page=1&page_size=5&sort=popularity` | 12 928 B | `data[]` (5 manga) + `facet` (top-5 saja). `meta.total_record` = 1000 (cap server) |
| `manga_list_search_one_piece.json` | `GET /v1/manga/list?page=1&page_size=5&q=one+piece` | 12 376 B | query param namanya **`q`**; `total_record` 24 |
| `manga_detail_one_piece.json` | `GET /v1/manga/detail/48270276-bd79-4a46-b15e-fdd2cf5655b1` | 2 445 B | `data.taxonomy{Author,Artist,Format,Genre,Type}`; `status` 1 = Ongoing |
| `chapter_list_one_piece.json` | `GET /v1/chapter/48270276-.../list?page=1&page_size=5` | 1 995 B | chapter urut terbaru dulu (One Piece ch. 1195 lebih dulu). Server mengizinkan `page_size=3000` = semua chapter 1 request |
| `chapter_detail_one_piece.json` | `GET /v1/chapter/detail/69211040-3c41-4fbc-9c57-c4f9b9cba64a` | 1 409 B | URL gambar = `base_url` + `chapter.path` + tiap nama file di `chapter.data[]` (`0-ed0db8.webp`). Ada `prev/next_chapter_id` |
| `genre_list.json` | `GET /v1/genre/list` | 5 893 B | 51 genre `{name, slug, taxonomy_id, type}` |

**Catatan penting untuk adapter**
- `sort` hanya menerima `popularity|rank|latest`; nilai lain → HTTP 400.
- Chapter list boleh 1 request (`page_size=3000`), tapi `list` catalogue di-cap 1000 record.
- Gambar di `assets.shngm.id`; judul baru `.webp` (perlu jalur PDF beda dari jpeg).

---

## kiryuu (kiryuu.to, WordPress/NatsuId)

Base saat capture: `https://v7.kiryuu.to`.
**`*.kiryuu.to` DNS-POISONED di jaringan build** (Telkomsel → `202.3.218.139`, SSL error).
Cara akses: resolve dulu via **DoH** `https://cloudflare-dns.com/dns-query?name=v7.kiryuu.to&type=A`
(balas `172.67.216.21` / `104.21.69.249`), lalu `curl --resolve v7.kiryuu.to:443:<IP>`.
Referensi: `references/kiryuu-api.md`.

| File | Endpoint | Ukuran | Catatan |
|---|---|---|---|
| `homepage.head.html` | `GET /` | 102 450 B | head slice dari full 630 802 B. **`search_nonce` TIDAK ada di HTML homepage** — dimuat via admin-ajax (lihat file berikut) |
| `search_nonce.response.html` | `GET /wp-admin/admin-ajax.php?type=search_form&action=get_nonce` | 60 B | `<input type='hidden' name='search_nonce' value='f2d44e938a'>`. Nilai hanya valid per-run → jangan pakai sebagai konstanta test |
| `advanced_search.html` | `POST /wp-admin/admin-ajax.php?action=advanced_search` (form) | 29 766 B | form: `nonce, page=1, order=desc, orderby=popular, query=solo leveling, inclusion=OR, exclusion=OR, genre=[], genre_exclude=[], author=[], artist=[], project=0, type=[], status=[]`. Balas HTML fragment berisi `/manga/{slug}/`; hasil: `solo-leveling`, `solo-leveling-side-story`, `solo-leveling-ragnarok`, `solo-leveling-arise-hunter-origin` |
| `wp_manga_solo_leveling.json` | `GET /wp-json/wp/v2/manga?slug[]=solo-leveling&per_page=2&_embed` | 45 230 B | array 1 objek (id 278284). `_embed` **wajib** — tanpa itu cover & `wp:term` hilang. `wp:term` dikelompokkan per `taxonomy`: status/type/genre/series-author/artist. `metadata.meta.alternative_title` = judul lain dipisah koma |
| `manga_solo_leveling.head.html` | `GET /manga/solo-leveling` | 103 649 B | head slice dari full 1 031 145 B. Berisi 191 link chapter dengan suffix opaque (`chapter-179.6.425255`) |
| `chapter_179.6.head.html` | `GET /manga/solo-leveling/chapter-179.6.425255/` | 102 710 B | head slice dari full 138 554 B. **URL chapter = `chapter-<num>.<opaque>`, bukan `chapter/<num>`** — endpoint yang diminta (`/chapter/210`) 301-redirect ke homepage. Slug asli Solo Leveling Chapter Spesial |
| `reader_section_extract.html` | — (extract dari `chapter_179.6.head.html`) | ~2 KB | `<section data-image-data="1">` = blok pembaca: 12 `<img>` reader saja (logo/ads/banner ada di luar section). Gambar di `v2.yuucdn.net` |
| `wp_genre.json` | `GET /wp-json/wp/v2/genre?per_page=5` | 4 729 B | 5 genre; field `{id, slug, name, count, taxonomy}` |

**Catatan penting untuk adapter**
- `manga_id` numerik (`278284`) ≠ slug; detail bisa diambil via `wp-json/wp/v2/manga/{id}?_embed`.
- Chapter href pakai 301 → trailing slash; ikuti redirect.
- Path gambar bisa berisi **spasi literal** (`/S/Solo Leveling/Chapter 00.1/00.jpg`) — percent-encode sebelum fetch.
- `nonce` bisa kedaluwarsa mid-run: balik kosong → ambil nonce baru + retry sekali.

---

## mangaku (mangaku.lol, Laravel + Inertia/Ziggy)

Base: `https://mangaku.lol`. **Tidak DNS-poisoned** (beda dengan kiryuu.to/komiku.id),
curl biasa cukup, tanpa DoH. Semua data datang dalam atribut **`data-page`**
(HTML-entity-encoded) → HTML mentah + props yang sudah di-decode disimpan berdampingan.

| File | Endpoint | Ukuran | Catatan |
|---|---|---|---|
| `manga_popular.html` | `GET /manga?page=1&sort=popular` | 189 883 B | HTML penuh (Inertia page) |
| `manga_popular.props.json` | (props dari `data-page` file di atas) | 122 786 B | `props.mangas` = paginator `{data, current_page, last_page, per_page, total}` (total **7 722**, 24/halaman) + `props.genres` (106). **`last_chapter` = objek chapter penuh**, bukan angka |
| `manga_search_batsu.html` | `GET /manga?search=batsu` | 147 424 B | |
| `manga_search_batsu.props.json` | (props dari file di atas) | 78 308 B | 12 hasil; echo filter di `props.filters` |
| `manga_batsu-harembatsu-harem.html` | `GET /manga/batsu-harembatsu-harem` | 202 575 B | series page |
| `manga_batsu-harembatsu-harem.props.json` | (props dari file di atas) | 132 514 B | `props.manga` **termasuk daftar chapter inline** + `props.chapters`; `manga.slug` ada untuk tolak slug-mismatch |
| `manga_batsu-harembatsu-harem_chapter_210.html` | `GET /manga/batsu-harembatsu-harem/chapter/210` | 119 416 B | chapter page |
| `manga_batsu-harembatsu-harem_chapter_210.props.json` | (props dari file di atas) | 48 204 B | `props.chapter.images[] = [{image_path, order}]` (URL absolut), `props.prev`/`next` |

**Catatan penting untuk adapter**
- Identitas chapter = **`chapter_number` desimal** (`210`, `1.1`, `35.3`) — bukan DB id,
  bukan slug. Route Ziggy: `manga.read`.
- `data-page` di-encode HTML-entity (`&quot;`) — unescape sebelum `json.loads`.
- Gambar di `image2/3.komiku.to`; gambar pertama sering `komiku-promosi.webp`
  (banner situs asli, bukan bug).
- Mangaku adalah agregator: banyak field `source_url` menunjuk komiku.org, tapi
  chapter/gambar adalah data milik Mangaku sendiri.

---

## Endpoint yang gagal direkam

| Sumber | Endpoint | Alasan |
|---|---|---|
| kiryuu | `GET /manga/solo-leveling/chapter/210` | Route tidak ada. Kiryuu pakai pola `chapter-<num>.<opaque-suffix>` (`/manga/solo-leveling/chapter-179.6.425255/`). URL `/chapter/210` balas 301 → redirect ke homepage (200, HTML homepage 630 KB, bukan halaman chapter). Diganti dengan `chapter_179.6.head.html` dari slug asli yang diambil dari halaman series |

Selain itu: **tidak ada** kegagalan lain (DNS/403/429) selama capture.

## Yang perlu diingat saat pakai fixture ini di test

1. Nilai dinamis (nonce kiryuu, `x-secure-seeds`, `meta.request_id`, `meta.timestamp`,
   URL CDN ber-timestamp, `chapter_id`) **tidak stabil** — test harus parse struktur,
   bukan mencocokkan string persis.
2. Blob AES komiku (`chapter`, `chapter.image`, `series.previews`) tetap base64 mentah;
   decrypt butuh key dari `komiku.py`.
3. HTML yang besar disimpan sebagai head slice (≥100 KB) atau full (mangaku); ukuran
   full dicatat di tabel masing-masing.
4. Capture script + manifest ada di
   `C:/Users/LENOVO LEGION/AppData/Local/Temp/komik-fixtures/` (`capture.py`,
   `manifest.json`) — scratch, jangan di-commit.
