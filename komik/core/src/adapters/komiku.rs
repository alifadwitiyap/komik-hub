//! Komiku+ / KomikId adapter (index.komikid.org + content.komikid.org).
//!
//! Semantics ditiru dari CLI Python teruji `komiku-cli/komiku.py` (32/32 test
//! lolos); kripto di-port dari `komiku-server/src/crypto.rs` (hasil RE APK
//! v2.3.0, package `id.komiku.plus`) supaya byte-nya identik.
//!
//! ## Host & endpoint (terverifikasi live 2026-10-13)
//!
//! | method | url | key hasil |
//! |---|---|---|
//! | list populer | `{INDEX}manga/page/{n}/?other=hot` | `series[]` |
//! | update terbaru | `{INDEX}manga/page/{n}/` | `series[]` (urut update_date desc) |
//! | pencarian | `{INDEX}page/{n}/?s={q}` | `manga[]` (BUKAN `data`) |
//! | katalog+genre | `{INDEX}manga/page/{n}/?genre={slug}` | `series[]` |
//! | daftar genre | `{INDEX}?content=categorylist` | grup `category.id=="genre"` |
//! | series | `{CONTENT}?content=manga&id={int}` | `series{}` + `chapter` (blob AES) |
//! | chapter | `{CONTENT}?content=chapter&id={int}` | `chapter.image` (blob AES) |
//!
//! `?content=mangalist` (katalog A-Z 5.6 MB, dict per huruf) & `?content=homepage`
//! (seksi trending/hot/terbaru, TANPA paginasi) hanya dipakai sebagai fallback
//! metadata — `manga/page/{n}/` yang jadi katalog berpaginasi.
//!
//! ## Header wajib (tiap request)
//!
//! `x-secure-seeds` = hex(AES-256-CBC(timestamp_millis)) — server menolak seed
//! basi, jadi di-regenerate per request + retry sekali pada 401/403. Selalu
//! ikut: `x-package-name: id.komiku.plus`, `x-version-code: 11`,
//! `x-country-code: ID`, `Accept: application/json`, UA Android.
//!
//! ## Blob terenkripsi
//!
//! `chapter` (daftar chapter) & `chapter.image` (URL gambar) = base64 AES
//! NO_PADDING; plaintext-nya JSON. Pad ke kelipatan 4 sebelum decode, buang
//! padding PKCS7 setelah dekripsi. Lihat `decrypt_blob`.
//!
//! ## Identitas
//!
//! Manga `native_id` = integer series (`6426`); chapter `native_id` = integer
//! chapter (`578843`). `chapter_pages` hanya butuh chapter native_id — URL
//! gambar datang dari endpoint `content=chapter`, jadi tak ada URL per chapter
//! di model.
use crate::model::*;
use crate::source::{Source, SourceResult};
use aes::cipher::{
    block_padding::Pkcs7, BlockDecryptMut, BlockEncryptMut, KeyIvInit,
};
use base64::Engine;
use hmac::{Hmac, Mac};
use serde_json::Value;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

const BASE_INDEX: &str = "https://index.komikid.org/";
const BASE_CONTENT: &str = "https://content.komikid.org/";
const UA: &str = "Mozilla/5.0 (Linux; Android 13; SM-S908B) AppleWebKit/537.36 \
                  (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36";

type Aes256CbcEnc = cbc::Encryptor<aes::Aes256>;
type Aes256CbcDec = cbc::Decryptor<aes::Aes256>;
type HmacSha1 = Hmac<sha1::Sha1>;

// ---------------------------------------------------------------------------
// Kripto — port byte-identik dari komiku-server/src/crypto.rs
// ---------------------------------------------------------------------------

/// IV hardcoded di APK: 0,1,2,...,15
const IV: [u8; 16] = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15];

/// `keypart = seed[..6] + "V48Tkh".replace("8","6") + seed[6..len-1]`
/// seed = `Base64.decode("cXlHang1aDdCcw==")` = "qyGjx5h7Bs".
fn key_part() -> String {
    let s = "qyGjx5h7Bs";
    format!("{}V46Tkh{}", &s[0..6], &s[6..s.len() - 1])
}

fn password() -> String {
    format!("org.komiku.{}s", key_part())
}

/// PBKDF2-HMAC-SHA1 (RFC 2898), ditulis tangan karena crate `pbkdf2` 0.12 minta
/// tipe core yang berbeda dari `Hmac<Sha1>` — tambah dep untuk satu fungsi tak
/// sepadan. 65536 iterasi jadi di-cache sekali per proses.
fn prf(key: &[u8], data: &[u8]) -> [u8; 20] {
    let mut m = <HmacSha1 as Mac>::new_from_slice(key).expect("HMAC menerima key apa panjangnya");
    m.update(data);
    m.finalize().into_bytes().into()
}

fn pbkdf2_sha1(password: &[u8], salt: &[u8], rounds: u32, out_len: usize) -> Vec<u8> {
    let mut out = Vec::with_capacity(out_len);
    let mut block: u32 = 1;
    while out.len() < out_len {
        let mut salt_int = salt.to_vec();
        salt_int.extend_from_slice(&block.to_be_bytes());
        let mut u = prf(password, &salt_int);
        let mut t = u;
        for _ in 1..rounds {
            u = prf(password, &u);
            for (a, b) in t.iter_mut().zip(u.iter()) {
                *a ^= *b;
            }
        }
        out.extend_from_slice(&t);
        block += 1;
    }
    out.truncate(out_len);
    out
}

fn aes_key() -> &'static [u8; 32] {
    static K: std::sync::OnceLock<[u8; 32]> = std::sync::OnceLock::new();
    K.get_or_init(|| {
        let v = pbkdf2_sha1(password().as_bytes(), b"179", 65_536, 32);
        v.try_into().expect("32 byte pasti jadi [u8; 32]")
    })
}

fn now_millis() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or_default()
}

/// `x-secure-seeds`: hex(AES-CBC(timestamp_millis)). Wajib segar per request.
fn x_secure_seeds() -> String {
    let plain = now_millis().to_string().into_bytes();
    let mut buf = plain.clone();
    buf.resize(plain.len() + 16, 0);
    let ct = Aes256CbcEnc::new(aes_key().as_slice().into(), &IV.into())
        .encrypt_padded_mut::<Pkcs7>(&mut buf, plain.len())
        .expect("16 byte ruang padding selalu cukup");
    hex::encode(ct)
}

/// Base64 APK memakai NO_PADDING — tambah '=' sampai kelipatan 4.
fn b64_decode_unpadded(s: &str) -> SourceResult<Vec<u8>> {
    let mut t = s.trim().to_string();
    while t.len() % 4 != 0 {
        t.push('=');
    }
    base64::engine::general_purpose::STANDARD
        .decode(t)
        .map_err(|e| anyhow::anyhow!("base64 blob tidak valid: {e}"))
}

/// Blob `chapter` / `chapter.image` -> plaintext UTF-8 (JSON).
fn decrypt_blob(blob: &str) -> SourceResult<String> {
    let mut ct = b64_decode_unpadded(blob)?;
    if ct.is_empty() || ct.len() % 16 != 0 {
        anyhow::bail!(
            "panjang ciphertext {} bukan kelipatan blok AES",
            ct.len()
        );
    }
    // decrypt_padded_mut mendekripsi in-place LALU unpad; kalau padding tak
    // PKCS7 sah, buffer sudah berisi plaintext bertumpuk byte mentah — sama
    // seperti `rstrip(bytes(range(17)))` di CLI Python.
    let pt = match Aes256CbcDec::new(aes_key().as_slice().into(), &IV.into())
        .decrypt_padded_mut::<Pkcs7>(&mut ct)
    {
        Ok(p) => p.to_vec(),
        Err(_) => {
            let mut end = ct.len();
            while end > 0 && (ct[end - 1] as usize) < 17 {
                end -= 1;
            }
            ct[..end].to_vec()
        }
    };
    String::from_utf8(pt).map_err(|e| anyhow::anyhow!("plaintext blob bukan UTF-8: {e}"))
}

/// Blob terenkripsi -> JSON. Kalau bukan blob (gagal decode/dekripsi), nilai
/// asli dikembalkan supaya endpoint tetap melayani data polos.
fn maybe_json(value: &Value) -> Value {
    if let Value::String(s) = value {
        if s.len() > 40 {
            if let Ok(pt) = decrypt_blob(s) {
                if let Ok(v) = serde_json::from_str(&pt) {
                    return v;
                }
            }
        }
    }
    value.clone()
}

// ---------------------------------------------------------------------------
// Parsing tanggal (relatif Indonesia + absolut) -> epoch millis
// ---------------------------------------------------------------------------

/// Satuan relatif yang dipakai API ("11 menit lalu", "1 tahun lalu").
const UNIT_SECS: [(&str, u64); 7] = [
    ("detik", 1),
    ("menit", 60),
    ("jam", 3_600),
    ("hari", 86_400),
    ("minggu", 604_800),
    ("bulan", 2_592_000),
    ("tahun", 31_536_000),
];

fn unit_secs(unit: &str) -> Option<u64> {
    UNIT_SECS
        .iter()
        .find(|(key, _)| unit.starts_with(key))
        .map(|(_, s)| *s)
}

/// Nama bulan (Indonesia & Inggris yang muncul di field `date`) -> 1..=12.
/// Cukup prefix 3 byte supaya singkatan MAUPUN nama penuh kena ("jan" ->
/// januari/january, "okt"/"oct" -> oktober/october). "may" wajib eksplisit:
/// satu-satunya yang tak punya padanan 3-huruf di daftar Indonesia ("mei").
fn month_from_name(s: &str) -> Option<u32> {
    let b = s.as_bytes();
    if b.len() < 3 {
        return None;
    }
    let p = std::str::from_utf8(&b[..3]).ok()?.to_ascii_lowercase();
    match p.as_str() {
        "jan" => Some(1),
        "feb" => Some(2),
        "mar" => Some(3),
        "apr" => Some(4),
        "mei" | "may" => Some(5),
        "jun" => Some(6),
        "jul" => Some(7),
        "agu" | "aug" => Some(8),
        "sep" => Some(9),
        "okt" | "oct" => Some(10),
        "nov" => Some(11),
        "des" | "dec" => Some(12),
        _ => None,
    }
}

/// Hari sejak 1970-01-01 (algoritma days_from_civil, Howard Hinnant).
fn days_from_civil(y: i64, m: u32, d: u32) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400;
    let mp = if m > 2 { m - 3 } else { m + 9 } as i64;
    let doy = (153 * mp + 2) / 5 + d as i64 - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

/// Tanggal KomikId -> epoch millis. Bentuk yang muncul live:
/// `"11 menit lalu"`, `"4 hari lalu"`, `"1 tahun lalu"`, `"baru saja"`,
/// `" 9 October 2026"`, `"19 Juli 1997"`. Yang tak dikenali -> None (field
/// `updated_at` memang best-effort di model).
fn parse_komik_date(s: &str) -> Option<i64> {
    let s = s.trim();
    if s.is_empty() || s == "-" {
        return None;
    }
    let low = s.to_ascii_lowercase();

    if low == "baru saja" {
        return Some(now_millis());
    }
    if let Some(rest) = low.strip_suffix("lalu") {
        let toks: Vec<&str> = rest.split_whitespace().collect();
        if toks.len() < 2 {
            return None;
        }
        let n: u64 = toks[toks.len() - 2].parse().ok()?;
        let secs = n.checked_mul(unit_secs(toks[toks.len() - 1])?)?;
        return now_millis().checked_sub((secs as i128 * 1000).min(i64::MAX as i128) as i64);
    }

    // absolut: "<d> <bulan> <yyyy>"
    let toks: Vec<&str> = low.split_whitespace().collect();
    if toks.len() != 3 {
        return None;
    }
    let day: u32 = toks[0].parse().ok()?;
    let month = month_from_name(toks[1])?;
    let year: i64 = toks[2].parse().ok()?;
    if !(1..=31).contains(&day) {
        return None;
    }
    Some(days_from_civil(year, month, day) * 86_400_000)
}

// ---------------------------------------------------------------------------
// Pemetaan JSON -> model
// ---------------------------------------------------------------------------

fn str_field(v: &Value, key: &str) -> Option<String> {
    match v.get(key) {
        Some(Value::String(s)) if !s.trim().is_empty() && s != "-" => Some(s.trim().to_string()),
        Some(Value::Number(n)) => Some(n.to_string()),
        _ => None,
    }
}

/// Field yang datang sebagai list `[{"name": "...", "id": ...}]` -> "A, B".
fn names_joined(v: &Value, key: &str) -> Option<String> {
    let arr = v.get(key).and_then(|x| x.as_array())?;
    let joined = arr
        .iter()
        .filter_map(|it| it.get("name").and_then(|n| n.as_str()))
        .collect::<Vec<_>>()
        .join(", ");
    (!joined.is_empty()).then_some(joined)
}

/// id API selalu integer; string numerik diterima sebagai toleransi.
fn id_str(v: &Value) -> Option<String> {
    match v.get("id")? {
        Value::Number(n) => Some(n.to_string()),
        Value::String(s) if !s.is_empty() && s.bytes().all(|b| b.is_ascii_digit()) => {
            Some(s.to_string())
        }
        _ => None,
    }
}

/// `latest_chapter: [{"name": "Chapter 1195", "number": "1195"}]` -> "1195".
fn latest_chapter_number(v: &Value) -> Option<String> {
    let first = v.get("latest_chapter").and_then(|x| x.as_array())?.first()?;
    str_field(first, "number").or_else(|| str_field(first, "name"))
}

fn map_manga(v: &Value) -> Option<Manga> {
    let native_id = id_str(v)?;
    let title = str_field(v, "title").or_else(|| str_field(v, "title_alt"))?;
    let mut m = Manga::new(SourceId::from("komiku"), native_id, &title);
    // thumbnail = cover potret (kartu); cover = banner horizontal.
    m.cover_url = str_field(v, "thumbnail").or_else(|| str_field(v, "cover"));
    m.author = str_field(v, "author");
    m.status = names_joined(v, "statusmanga");
    m.manga_type = names_joined(v, "tipe");
    m.rating = str_field(v, "score");
    m.last_chapter = latest_chapter_number(v);
    m.updated_at = str_field(v, "update_date").as_deref().and_then(parse_komik_date);
    Some(m)
}

fn map_chapter(v: &Value) -> Option<Chapter> {
    let native_id = id_str(v)?;
    let number = str_field(v, "number").or_else(|| str_field(v, "name"))?;
    let title = str_field(v, "name").unwrap_or_else(|| format!("Chapter {number}"));
    Some(Chapter {
        source: SourceId::from("komiku"),
        native_id,
        title,
        number,
        updated_at: str_field(v, "date").as_deref().and_then(parse_komik_date),
        url: None,
    })
}

/// `series[]` (katalog) ataupun `manga[]` (pencarian) -> Vec<Manga>.
fn manga_items(v: &Value, key: &str) -> Vec<Manga> {
    v.get(key)
        .and_then(|x| x.as_array())
        .map(|a| a.iter().filter_map(map_manga).collect())
        .unwrap_or_default()
}

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

pub struct KomikuSource {
    client: reqwest::Client,
}

impl KomikuSource {
    pub fn new(client: reqwest::Client) -> Self {
        KomikuSource { client }
    }

    /// GET JSON dengan seed segar. Retry sampai 2x pada 401/403 (seed berbasis
    /// waktu) dan pada error jaringan ringan.
    async fn get(&self, base: &str, path: &str, query: &[(&str, String)]) -> SourceResult<Value> {
        let url = format!("{base}{path}");
        let mut last_err = String::new();
        for attempt in 0..3u32 {
            let mut req = self
                .client
                .get(&url)
                .header("x-secure-seeds", x_secure_seeds())
                .header("x-package-name", "id.komiku.plus")
                .header("x-version-code", "11")
                .header("x-country-code", "ID")
                .header("Accept", "application/json")
                .header("User-Agent", UA);
            if !query.is_empty() {
                req = req.query(query);
            }
            match req.send().await {
                Ok(resp) => {
                    let status = resp.status();
                    if status == 401 || status == 403 {
                        last_err = format!("HTTP {status} (x-secure-seeds ditolak)");
                        if attempt < 2 {
                            tokio::time::sleep(Duration::from_millis(400)).await;
                        }
                        continue;
                    }
                    let body = resp.text().await.unwrap_or_default();
                    if !status.is_success() {
                        anyhow::bail!(
                            "HTTP {} dari {}: {}",
                            status,
                            url,
                            body.chars().take(200).collect::<String>()
                        );
                    }
                    return serde_json::from_str(&body).map_err(|e| {
                        anyhow::anyhow!("{} bukan JSON ({} byte): {e}", url, body.len())
                    });
                }
                Err(e) => {
                    last_err = e.to_string();
                    if attempt < 2 {
                        tokio::time::sleep(Duration::from_millis(300)).await;
                    }
                }
            }
        }
        anyhow::bail!("gagal setelah 3 percobaan untuk {url}: {last_err}")
    }

    async fn index(&self, path: &str, query: &[(&str, String)]) -> SourceResult<Value> {
        self.get(BASE_INDEX, path, query).await
    }

    async fn content(&self, query: &[(&str, String)]) -> SourceResult<Value> {
        self.get(BASE_CONTENT, "", query).await
    }
}

#[async_trait::async_trait]
impl Source for KomikuSource {
    fn id(&self) -> SourceId {
        SourceId::from("komiku")
    }

    /// Ranking populer = seksi HOT situs (`manga/page/{n}/?other=hot`).
    async fn popular(&self, page: u32) -> SourceResult<Vec<Manga>> {
        let raw = self
            .index(&format!("manga/page/{page}/"), &[("other", "hot".to_string())])
            .await?;
        Ok(manga_items(&raw, "series"))
    }

    /// Update terbaru = katalog `manga/page/{n}/` (urut update_date desc).
    async fn latest(&self, page: u32) -> SourceResult<Vec<Manga>> {
        let raw = self.index(&format!("manga/page/{page}/"), &[]).await?;
        Ok(manga_items(&raw, "series"))
    }

    /// Pencarian judul. Perhatikan: key hasil `manga`, BUKAN `data`.
    async fn search(&self, query: &str, page: u32) -> SourceResult<Vec<Manga>> {
        let raw = self
            .index(&format!("page/{page}/"), &[("s", query.to_string())])
            .await?;
        Ok(manga_items(&raw, "manga"))
    }

    /// Cari judul + filter genre: endpoint `s` yang sama dengan `search`,
    /// ditambah `genre` — pola sama seperti `list()` di bawah (slug).
    async fn search_in_genre(
        &self,
        query: &str,
        page: u32,
        genre: Option<&str>,
    ) -> SourceResult<Vec<Manga>> {
        let mut q: Vec<(&str, String)> = vec![("s", query.to_string())];
        if let Some(g) = genre.map(str::trim).filter(|s| !s.is_empty()) {
            q.push(("genre", g.to_string()));
        }
        let raw = self.index(&format!("page/{page}/"), &q).await?;
        Ok(manga_items(&raw, "manga"))
    }

    /// Katalog berpaginasi + filter genre opsional. `genre` = SLUG genre
    /// (mis. "action", sama seperti yang keluar dari `genres()`), bukan nama
    /// tampilan — `?genre=Aksi` balas 404.
    async fn list(&self, genre: Option<&str>, page: u32) -> SourceResult<Vec<Manga>> {
        let mut query: Vec<(&str, String)> = Vec::new();
        if let Some(g) = genre.map(str::trim).filter(|s| !s.is_empty()) {
            query.push(("genre", g.to_string()));
        }
        let raw = self.index(&format!("manga/page/{page}/"), &query).await?;
        Ok(manga_items(&raw, "series"))
    }

    /// Genre dari grup `categorylist` ber-id "genre" (112 entri). Grup lain
    /// (Berwarna/Status/Tipe/Series/…) sengaja dibuang.
    async fn genres(&self) -> SourceResult<Vec<(String, String)>> {
        let raw = self.index("", &[("content", "categorylist".to_string())]).await?;
        let groups = raw
            .get("data")
            .and_then(|d| d.as_array())
            .ok_or_else(|| anyhow::anyhow!("respons categorylist tanpa 'data'"))?;
        let mut out = Vec::new();
        for grp in groups {
            let is_genre = grp
                .get("category")
                .and_then(|c| c.get("id"))
                .and_then(|i| i.as_str())
                == Some("genre");
            if !is_genre {
                continue;
            }
            if let Some(items) = grp.get("data").and_then(|d| d.as_array()) {
                for it in items {
                    if let (Some(slug), Some(name)) = (
                        it.get("id").and_then(|i| i.as_str()),
                        it.get("name").and_then(|n| n.as_str()),
                    ) {
                        out.push((slug.to_string(), name.to_string()));
                    }
                }
            }
        }
        if out.is_empty() {
            anyhow::bail!("daftar genre kosong (struktur categorylist berubah?)");
        }
        Ok(out)
    }

    /// Detail series + chapter. API sudah mengurut chapter terbaru-dulu.
    async fn series(&self, native_id: &str) -> SourceResult<SeriesDetail> {
        let id: i64 = native_id
            .trim()
            .parse()
            .map_err(|_| anyhow::anyhow!("id komiku harus integer, dapat '{native_id}'"))?;
        let raw = self
            .content(&[
                ("content", "manga".to_string()),
                ("id", id.to_string()),
            ])
            .await?;
        let s = raw
            .get("series")
            .ok_or_else(|| anyhow::anyhow!("respons series {native_id} tanpa objek 'series'"))?;
        let manga = map_manga(s)
            .ok_or_else(|| anyhow::anyhow!("series {native_id} tanpa id/title yang bisa dipakai"))?;

        // daftar chapter datang sebagai blob AES -> dekripsi dulu
        let blob = maybe_json(raw.get("chapter").unwrap_or(&Value::Null));
        let chapters: Vec<Chapter> = blob
            .as_array()
            .map(|a| a.iter().filter_map(map_chapter).collect())
            .unwrap_or_default();
        if chapters.is_empty() {
            anyhow::bail!("series {native_id} tak punya chapter (blob gagal didekripsi?)");
        }
        Ok(SeriesDetail { manga, chapters })
    }

    /// Gambar chapter. Hanya butuh chapter native_id (integer) — URL gambar
    /// datang dari `?content=chapter&id=...` sebagai blob terenkripsi.
    async fn chapter_pages(&self, _manga: &Manga, chapter: &Chapter) -> SourceResult<ChapterPages> {
        let id: i64 = chapter.native_id.trim().parse().map_err(|_| {
            anyhow::anyhow!(
                "native_id chapter komiku harus integer, dapat '{}'",
                chapter.native_id
            )
        })?;
        let raw = self
            .content(&[
                ("content", "chapter".to_string()),
                ("id", id.to_string()),
            ])
            .await?;
        let ch = raw
            .get("chapter")
            .ok_or_else(|| anyhow::anyhow!("respons chapter {id} tanpa objek 'chapter'"))?;
        let blob = maybe_json(ch.get("image").unwrap_or(&Value::Null));
        let images: Vec<String> = blob
            .as_array()
            .map(|a| {
                a.iter()
                    .filter_map(|u| u.as_str().map(str::to_string))
                    .collect()
            })
            .unwrap_or_default();
        if images.is_empty() {
            anyhow::bail!(
                "chapter {} ({}) tak punya gambar",
                chapter.number,
                chapter.native_id
            );
        }
        Ok(ChapterPages {
            source: self.id(),
            title: chapter.title.clone(),
            number: chapter.number.clone(),
            images,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn x_secure_seeds_16_byte_hex() {
        let s = x_secure_seeds();
        assert_eq!(s.len(), 32, "timestamp millis selalu 1 blok AES -> 32 hex");
        assert!(s.bytes().all(|b| b.is_ascii_hexdigit()), "bukan hex: {s}");
    }

    #[test]
    fn seed_kunci_sesuai_re() {
        // Ground truth dari komiku-server/src/crypto.rs + komiku-cli/komiku.py
        assert_eq!(key_part(), "qyGjx5V46Tkhh7B");
        assert_eq!(password(), "org.komiku.qyGjx5V46Tkhh7Bs");
        assert_eq!(aes_key().len(), 32);
    }

    #[test]
    fn tanggal_relatif_dan_absolut() {
        let now = now_millis();
        let menit = parse_komik_date("11 menit lalu").expect("relatif menit");
        assert!((now - menit - 11 * 60_000).abs() < 5_000);
        let hari = parse_komik_date("4 hari lalu").expect("relatif hari");
        assert!((now - hari - 4 * 86_400_000).abs() < 5_000);
        let tahun = parse_komik_date("1 tahun lalu").expect("relatif tahun");
        assert!((now - tahun - 365 * 86_400_000).abs() < 5_000);

        let ok = parse_komik_date(" 9 October 2026").expect("absolut en");
        assert_eq!(ok, days_from_civil(2026, 10, 9) * 86_400_000);
        let juli = parse_komik_date("19 Juli 1997").expect("absolut id");
        assert_eq!(juli, days_from_civil(1997, 7, 19) * 86_400_000);

        assert!((parse_komik_date("baru saja").expect("baru saja") - now).abs() < 5_000);
    }

    #[test]
    fn bulan_inggris_dan_indonesia_lengkap() {
        // Bug asli: API komiku mengirim tanggal Inggris ("May", "June", ...);
        // "may" tak ada di tabel -> parse gagal -> chapter tanpa updated_at.
        for (name, want) in [
            ("January", 1),
            ("Jan", 1),
            ("Januari", 1),
            ("February", 2),
            ("Februari", 2),
            ("March", 3),
            ("Maret", 3),
            ("April", 4),
            ("April", 4),
            ("May", 5),
            ("Mei", 5),
            ("June", 6),
            ("Juni", 6),
            ("July", 7),
            ("Juli", 7),
            ("August", 8),
            ("Agustus", 8),
            ("September", 9),
            ("Oct", 10),
            ("Oktober", 10),
            ("November", 11),
            ("Desember", 12),
            ("December", 12),
        ] {
            assert_eq!(month_from_name(name), Some(want), "bulan {name}");
        }
        // bukan nama bulan -> tetap None
        assert_eq!(month_from_name("Xyz"), None);
        assert_eq!(month_from_name("be"), None);
    }

    #[test]
    fn tanggal_absolut_bulan_inggris_lengkap() {
        // " 9 May 2026" sebelumnya None (bukan dikenal) -> baris tanpa tanggal
        assert_eq!(
            parse_komik_date(" 9 May 2026"),
            Some(days_from_civil(2026, 5, 9) * 86_400_000)
        );
        assert_eq!(
            parse_komik_date("1 December 2019"),
            Some(days_from_civil(2019, 12, 1) * 86_400_000)
        );
        // Februari Inggris tahun kabisat tetap 29 hari -> hanya dicek lewat
        // days_from_civil, jadi nilai bisa dibandingkan langsung.
        assert_eq!(
            parse_komik_date("29 February 2024"),
            Some(days_from_civil(2024, 2, 29) * 86_400_000)
        );
    }

    #[test]
    fn tanggal_tak_dikenali_none() {
        assert_eq!(parse_komik_date("-"), None);
        assert_eq!(parse_komik_date(""), None);
        assert_eq!(parse_komik_date("besok"), None);
        assert_eq!(parse_komik_date("99 Xyz 2020"), None);
    }

    #[test]
    fn id_integer_atau_string_numerik() {
        assert_eq!(
            id_str(&serde_json::json!({"id": 578843})).as_deref(),
            Some("578843")
        );
        assert_eq!(
            id_str(&serde_json::json!({"id": "578843"})).as_deref(),
            Some("578843")
        );
        assert_eq!(id_str(&serde_json::json!({"id": "abc"})), None);
        assert_eq!(id_str(&serde_json::json!({})), None);
    }

    #[test]
    fn map_manga_ambil_field_kartu() {
        let m = map_manga(&serde_json::json!({
            "id": 6426,
            "title": "One Piece",
            "title_alt": "One Piece",
            "score": "9",
            "author": "Eiichiro Oda",
            "thumbnail": "https://thumbnail.komiku.org/t.jpg",
            "cover": "https://thumbnail.komiku.org/c.jpg",
            "statusmanga": [{"name": "Ongoing", "id": "ongoing"}],
            "tipe": [{"name": "Manga", "id": "manga"}],
            "latest_chapter": [{"name": "Chapter 1195", "number": "1195"}],
            "update_date": "4 hari lalu"
        }))
        .expect("manga valid");
        assert_eq!(m.native_id, "6426");
        assert_eq!(m.title_key, "one piece");
        assert_eq!(m.status.as_deref(), Some("Ongoing"));
        assert_eq!(m.manga_type.as_deref(), Some("Manga"));
        assert_eq!(m.rating.as_deref(), Some("9"));
        assert_eq!(m.last_chapter.as_deref(), Some("1195"));
        assert!(m.cover_url.as_deref().unwrap().ends_with("t.jpg"));
        assert!(m.updated_at.is_some());
    }

    #[test]
    fn kunci_pencarian_vs_katalog() {
        let search = serde_json::json!({"manga": [{"id": 1, "title": "a"}]});
        let catalog = serde_json::json!({"series": [{"id": 2, "title": "b"}]});
        assert_eq!(manga_items(&search, "manga").len(), 1);
        assert_eq!(manga_items(&catalog, "series").len(), 1);
        // key salah -> kosong (bukan panic)
        assert!(manga_items(&search, "series").is_empty());
        assert!(manga_items(&catalog, "manga").is_empty());
    }
}
