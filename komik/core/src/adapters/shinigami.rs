//! Shinigami adapter — api.shngm.io/v1, JSON envelope `{retcode, data, meta}`.
//! Tanpa auth, tanpa enkripsi (beda dari Komiku+). Manga & chapter id = UUID.
//! Chapter pages dibangun dari `base_url` + `chapter.path` + filename di
//! `assets.shngm.id`. Semantik error & retry mengikuti klien Python acuan
//! (D:/project/shinigami-cli/shinigami.py, 23/23 test): HTTP non-2xx dengan
//! body `{retcode,message}` -> error berisi message; body non-JSON -> error;
//! retcode != 0 pada 200 -> error; retry 429/500/502/503 + network (max 2).
use crate::model::*;
use crate::source::{classified, Source, SourceError, SourceResult};

const API: &str = "https://api.shngm.io/v1";
const WEB: &str = "https://app.shinigami.asia";
const UA: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 \
                  (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
/// page_size daftar katalog: server hormati sampai 500 (referensi).
const PAGE_SIZE: u32 = 30;
/// Chapter list sekali tarik (One Piece 1219 chapter masuk satu request).
const CHAPTER_PAGE_SIZE: u32 = 3000;
const RETRIES: u32 = 2;
const REQ_TIMEOUT_SECS: u64 = 30;

pub struct ShinigamiSource {
    client: reqwest::Client,
}

impl ShinigamiSource {
    pub fn new(client: reqwest::Client) -> Self {
        ShinigamiSource { client }
    }

    /// GET `path` + query; kembalikan envelope `{retcode:0,...}` sebagai Value.
    async fn get(
        &self,
        path: &str,
        params: &[(&str, String)],
    ) -> SourceResult<serde_json::Value> {
        let url = format!("{API}{path}");
        let mut attempt: u32 = 0;
        loop {
            // ponytail: backoff fixed 1s/2s (identik Python 2**attempt), tanpa
            // jitter; naikkan ke backoff+jitter kalau sumber mulai 429 massal.
            let backoff = std::time::Duration::from_secs(1u64 << attempt);
            let resp = self
                .client
                .get(&url)
                .query(params)
                .header("User-Agent", UA)
                .header("Accept", "application/json")
                .header("Referer", format!("{WEB}/"))
                .timeout(std::time::Duration::from_secs(REQ_TIMEOUT_SECS))
                .send()
                .await;
            let resp = match resp {
                Ok(r) => r,
                Err(e) => {
                    if attempt < RETRIES {
                        attempt += 1;
                        tokio::time::sleep(backoff).await;
                        continue;
                    }
                    anyhow::bail!("network error: {e}");
                }
            };
            let status = resp.status();
            // reqwest tidak error pada 4xx/5xx -> baca body manual supaya pesan
            // relcode dari server ikut terbawa.
            let body = resp.text().await.unwrap_or_default();
            if status.is_success() {
                return parse_envelope(&body);
            }
            let msg = extract_message(&body);
            if matches!(status.as_u16(), 429 | 500 | 502 | 503) && attempt < RETRIES {
                attempt += 1;
                tokio::time::sleep(backoff).await;
                continue;
            }
            anyhow::bail!("HTTP {}: {}", status.as_u16(), msg);
        }
    }

    fn manga_list(&self, v: &serde_json::Value) -> Vec<Manga> {
        data_array(v)
            .iter()
            .filter_map(|item| manga_from_value(&self.id(), item))
            .collect()
    }
}

/// Envelope sukses: harus object JSON dengan `retcode == 0`.
fn parse_envelope(body: &str) -> SourceResult<serde_json::Value> {
    let v: serde_json::Value = serde_json::from_str(body)
        .map_err(|e| anyhow::anyhow!("respons bukan JSON: {e}"))?;
    let obj = v
        .as_object()
        .ok_or_else(|| anyhow::anyhow!("respons bukan object JSON"))?;
    let rc = obj.get("retcode");
    if rc.and_then(|r| r.as_i64()) == Some(0) {
        return Ok(v);
    }
    let msg = obj.get("message").and_then(|m| m.as_str()).unwrap_or("");
    anyhow::bail!("API error {}: {}", show_retcode(rc), msg);
}

fn show_retcode(rc: Option<&serde_json::Value>) -> String {
    rc.map(|r| r.to_string())
        .unwrap_or_else(|| "<tanpa retcode>".to_string())
}

/// Pesan error dari body HTTP non-2xx: ambil `.message` kalau JSON, else
/// potong body mentah (identik `body[:200]` di Python).
fn extract_message(body: &str) -> String {
    match serde_json::from_str::<serde_json::Value>(body) {
        Ok(v) => v
            .get("message")
            .and_then(|m| m.as_str())
            .map(str::to_string)
            .unwrap_or_else(|| body.chars().take(200).collect()),
        Err(_) => body.chars().take(200).collect(),
    }
}

fn data_array(v: &serde_json::Value) -> Vec<serde_json::Value> {
    v.get("data")
        .and_then(|d| d.as_array())
        .cloned()
        .unwrap_or_default()
}

fn str_field(v: &serde_json::Value, key: &str) -> Option<String> {
    v.get(key)
        .and_then(|x| x.as_str())
        .filter(|s| !s.is_empty())
        .map(str::to_string)
}

/// Angka JSON -> string tampilan tanpa ".0" yang tak perlu ("921" bukan
/// "921.0"), menerima string apa adanya.
fn num_str(v: Option<&serde_json::Value>) -> Option<String> {
    let v = v?;
    if let Some(s) = v.as_str() {
        return Some(s.to_string());
    }
    let f = v.as_f64()?;
    if f.fract() == 0.0 && f.abs() < 9.0e15 {
        Some((f as i64).to_string())
    } else {
        Some(f.to_string())
    }
}

/// Nama-nama taxonomy ("Author", "Format", "Genre", ...) jadi satu string.
fn tax_names(v: &serde_json::Value, key: &str) -> Option<String> {
    let arr = v.get("taxonomy")?.get(key)?.as_array()?;
    let names: Vec<&str> = arr
        .iter()
        .filter_map(|x| x.get("name").and_then(|n| n.as_str()))
        .filter(|s| !s.is_empty())
        .collect();
    if names.is_empty() {
        None
    } else {
        Some(names.join(", "))
    }
}

fn fmt_status(code: Option<i64>) -> Option<String> {
    match code? {
        1 => Some("Ongoing".to_string()),
        2 => Some("Completed".to_string()),
        _ => None,
    }
}

/// ISO8601 -> epoch millis. Kalau tak bisa diparse, None (best-effort seperti
/// keinginan model `updated_at`). Terima "Z"/naif/offset "+HH:MM"/fraksi detik.
fn iso8601_to_millis(s: &str) -> Option<i64> {
    let b = s.as_bytes();
    // minimal "YYYY-MM-DDTHH:MM:SS"
    if b.len() < 19 || b[4] != b'-' || b[7] != b'-' || b[10] != b'T' || b[13] != b':' || b[16] != b':'
    {
        return None;
    }
    let digits = |i: usize, j: usize| -> Option<i64> {
        let sub = s.get(i..j)?;
        if !sub.bytes().all(|c| c.is_ascii_digit()) {
            return None;
        }
        sub.parse().ok()
    };
    let (y, mo, dy, hh, mm, ss) = (
        digits(0, 4)?,
        digits(5, 7)?,
        digits(8, 10)?,
        digits(11, 13)?,
        digits(14, 16)?,
        digits(17, 19)?,
    );
    if !(1..=12).contains(&mo) || !(1..=31).contains(&dy) || hh > 23 || mm > 59 || ss > 60 {
        return None;
    }
    // days_from_civil (Howard Hinnant): tanggal -> hari sejak 1970-01-01.
    let yy = if mo <= 2 { y - 1 } else { y };
    let era = (if yy >= 0 { yy } else { yy - 399 }) / 400;
    let yoe = yy - era * 400;
    let mp = (mo + 9) % 12;
    let doy = (153 * mp + 2) / 5 + dy - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let mut millis = (era * 146097 + doe - 719468) * 86_400_000
        + hh * 3_600_000
        + mm * 60_000
        + ss * 1000;

    let mut i = 19;
    if b.get(i) == Some(&b'.') {
        i += 1;
        let start = i;
        let mut frac: i64 = 0;
        let mut digits_seen = 0;
        while i < b.len() && b[i].is_ascii_digit() && digits_seen < 3 {
            frac = frac * 10 + i64::from(b[i] - b'0');
            digits_seen += 1;
            i += 1;
        }
        while i < b.len() && b[i].is_ascii_digit() {
            i += 1;
        }
        if i == start {
            return None;
        }
        for _ in digits_seen..3 {
            frac *= 10;
        }
        millis += frac;
    }
    match s.get(i..).unwrap_or_default() {
        "" | "Z" | "z" => Some(millis),
        rest => {
            let sign = match rest.as_bytes().first()? {
                b'+' => 1,
                b'-' => -1,
                _ => return None,
            };
            let off = rest.get(1..)?.replace(':', "");
            if off.len() != 4 {
                return None;
            }
            let oh: i64 = off.get(0..2)?.parse().ok()?;
            let om: i64 = off.get(2..4)?.parse().ok()?;
            Some(millis - sign * (oh * 3_600_000 + om * 60_000))
        }
    }
}

/// Item `/manga/list` maupun `/manga/detail` -> Manga (field relevan sama).
fn manga_from_value(source: &SourceId, v: &serde_json::Value) -> Option<Manga> {
    let id = v.get("manga_id").and_then(|x| x.as_str())?;
    let title = v.get("title").and_then(|x| x.as_str())?;
    let mut m = Manga::new(source.clone(), id, title);
    m.cover_url = str_field(v, "cover_portrait_url").or_else(|| str_field(v, "cover_image_url"));
    m.author = tax_names(v, "Author");
    m.status = fmt_status(v.get("status").and_then(|s| s.as_i64()));
    m.manga_type = tax_names(v, "Format");
    m.rating = num_str(v.get("user_rate"));
    m.last_chapter = num_str(v.get("latest_chapter_number"));
    m.updated_at = str_field(v, "latest_chapter_time").as_deref().and_then(iso8601_to_millis);
    Some(m)
}

fn chapter_from_value(source: &SourceId, v: &serde_json::Value) -> Option<Chapter> {
    let id = v.get("chapter_id").and_then(|x| x.as_str())?;
    let number = num_str(v.get("chapter_number")).unwrap_or_else(|| "0".to_string());
    let base = format!("Chapter {number}");
    let title = match str_field(v, "chapter_title") {
        Some(t) => format!("{base} - {t}"),
        None => base,
    };
    Some(Chapter {
        source: source.clone(),
        native_id: id.to_string(),
        title,
        number,
        updated_at: str_field(v, "release_date").as_deref().and_then(iso8601_to_millis),
        url: None,
    })
}

/// URL gambar chapter: `base_url` (+fallback `base_url_low`) + `path` + filename.
fn image_urls(detail: &serde_json::Value) -> Vec<String> {
    let Some(d) = detail.get("data") else {
        return Vec::new();
    };
    let base = str_field(d, "base_url")
        .or_else(|| str_field(d, "base_url_low"))
        .unwrap_or_default();
    let Some(ch) = d.get("chapter") else {
        return Vec::new();
    };
    let path = ch.get("path").and_then(|p| p.as_str()).unwrap_or("");
    let Some(files) = ch.get("data").and_then(|x| x.as_array()) else {
        return Vec::new();
    };
    files
        .iter()
        .filter_map(|f| f.as_str())
        .filter(|f| !f.is_empty())
        .map(|f| format!("{base}{path}{f}"))
        .collect()
}

/// Nilai param `genre=` untuk filter katalog. Server menerima nama satu-kata
/// (case-insensitive) dan slug; nama berspasi ("Slice of Life") -> HTTP 404,
/// jadi di-slugify supaya cocok entri `genre/list`. Nama tanpa spasi dibiarkan
/// (slug yang sama juga hidup).
fn genre_param(g: &str) -> String {
    if !g.contains(char::is_whitespace) {
        return g.to_string();
    }
    let mut out = String::with_capacity(g.len());
    let mut prev_dash = false;
    for ch in g.chars() {
        if ch.is_alphanumeric() {
            for lc in ch.to_lowercase() {
                out.push(lc);
            }
            prev_dash = false;
        } else if !prev_dash {
            out.push('-');
            prev_dash = true;
        }
    }
    out.trim_matches('-').to_string()
}

#[async_trait::async_trait]
impl Source for ShinigamiSource {
    fn id(&self) -> SourceId {
        SourceId::from("shinigami")
    }

    async fn popular(&self, page: u32) -> SourceResult<Vec<Manga>> {
        let v = self
            .get(
                "/manga/list",
                &[
                    ("page", page.max(1).to_string()),
                    ("page_size", PAGE_SIZE.to_string()),
                    ("sort", "popularity".to_string()),
                ],
            )
            .await?;
        Ok(self.manga_list(&v))
    }

    async fn latest(&self, page: u32) -> SourceResult<Vec<Manga>> {
        let v = self
            .get(
                "/manga/list",
                &[
                    ("page", page.max(1).to_string()),
                    ("page_size", PAGE_SIZE.to_string()),
                    ("sort", "latest".to_string()),
                ],
            )
            .await?;
        Ok(self.manga_list(&v))
    }

    async fn search(&self, query: &str, page: u32) -> SourceResult<Vec<Manga>> {
        let v = self
            .get(
                "/manga/list",
                &[
                    ("page", page.max(1).to_string()),
                    ("page_size", PAGE_SIZE.to_string()),
                    ("q", query.to_string()),
                ],
            )
            .await?;
        Ok(self.manga_list(&v))
    }

    /// Cari judul + filter genre: endpoint `/manga/list` yang sama (sudah
    /// menerima `q` dan `genre` sekaligus). Nama berspasi di-slugify seperti
    /// `list()` — `genre="Slice of Life"` harus 404 kalau tidak.
    async fn search_in_genre(
        &self,
        query: &str,
        page: u32,
        genre: Option<&str>,
    ) -> SourceResult<Vec<Manga>> {
        let mut params: Vec<(&str, String)> = vec![
            ("page", page.max(1).to_string()),
            ("page_size", PAGE_SIZE.to_string()),
            ("q", query.to_string()),
        ];
        if let Some(g) = genre.map(str::trim).filter(|g| !g.is_empty()) {
            params.push(("genre", genre_param(g)));
        }
        let v = self.get("/manga/list", &params).await?;
        Ok(self.manga_list(&v))
    }

    async fn list(&self, genre: Option<&str>, page: u32) -> SourceResult<Vec<Manga>> {
        let mut params: Vec<(&str, String)> = vec![
            ("page", page.max(1).to_string()),
            ("page_size", PAGE_SIZE.to_string()),
        ];
        if let Some(g) = genre.map(str::trim).filter(|g| !g.is_empty()) {
            // DEVIASI dari referensi: `taxonomy.Genre.name=<Nama>` terverifikasi
            // NO-OP (hasil identik dengan tanpa filter, 1000 record). Param yang
            // benar-benar memfilter adalah `genre=`: menerima nama satu-kata
            // (case-insensitive) ATAU slug. Nama berspasi ("Slice of Life")
            // -> HTTP 404, jadi di-slugify. Mirrors Python CLI `-g Genre`.
            params.push(("genre", genre_param(g)));
        }
        let v = self.get("/manga/list", &params).await?;
        Ok(self.manga_list(&v))
    }

    async fn genres(&self) -> SourceResult<Vec<(String, String)>> {
        let v = self.get("/genre/list", &[]).await?;
        Ok(data_array(&v)
            .iter()
            .filter_map(|g| {
                let slug = g.get("slug").and_then(|s| s.as_str())?;
                let name = g.get("name").and_then(|s| s.as_str())?;
                if name.is_empty() {
                    return None;
                }
                if !super::is_genre(slug, name) {
                    return None;
                }
                Some((slug.to_string(), name.to_string()))
            })
            .collect())
    }

    async fn series(&self, native_id: &str) -> SourceResult<SeriesDetail> {
        let detail = self.get(&format!("/manga/detail/{native_id}"), &[]).await?;
        let data = detail
            .get("data")
            .filter(|d| d.is_object() && d.as_object().is_some_and(|o| !o.is_empty()))
            .ok_or_else(|| classified(
                SourceError::Missing,
                format!("manga {native_id} tidak ada data"),
            ))?;
        let manga = manga_from_value(&self.id(), data)
            .ok_or_else(|| anyhow::anyhow!("manga {native_id} tidak bisa diparse"))?;
        // Chapter list sekali tarik; default server = terbaru dulu (terverifikasi).
        let list = self
            .get(
                &format!("/chapter/{native_id}/list"),
                &[
                    ("page", "1".to_string()),
                    ("page_size", CHAPTER_PAGE_SIZE.to_string()),
                ],
            )
            .await?;
        let chapters = data_array(&list)
            .iter()
            .filter_map(|c| chapter_from_value(&self.id(), c))
            .collect();
        Ok(SeriesDetail { manga, chapters })
    }

    async fn chapter_pages(&self, _m: &Manga, chapter: &Chapter) -> SourceResult<ChapterPages> {
        let detail = self
            .get(&format!("/chapter/detail/{}", chapter.native_id), &[])
            .await?;
        let images = image_urls(&detail);
        if images.is_empty() {
            return Err(classified(
                SourceError::Empty,
                format!("chapter {} tidak punya gambar", chapter.native_id),
            ));
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

    fn ok(retcode: i64, data: serde_json::Value) -> String {
        serde_json::json!({"retcode": retcode, "message": "success", "data": data}).to_string()
    }

    #[test]
    fn envelope_ok_meneruskan_data() {
        let v = parse_envelope(&ok(0, serde_json::json!([{"manga_id": "x"}]))).unwrap();
        assert_eq!(v["data"][0]["manga_id"], "x");
    }

    #[test]
    fn envelope_retcode_nonzero_error() {
        let err = parse_envelope(r#"{"retcode":400001,"message":"bad param"}"#).unwrap_err();
        let s = err.to_string();
        assert!(s.contains("400001") && s.contains("bad param"), "{s}");
    }

    #[test]
    fn envelope_non_json_error() {
        let err = parse_envelope("<html>502 Bad Gateway</html>").unwrap_err();
        assert!(err.to_string().contains("bukan JSON"), "{err}");
    }

    #[test]
    fn http_error_message_dari_body() {
        assert_eq!(
            extract_message(r#"{"retcode":404001,"message":"manga not found"}"#),
            "manga not found"
        );
        assert_eq!(
            extract_message("gateway timeout banget banget"),
            "gateway timeout banget banget"
        );
    }

    #[test]
    fn image_url_join() {
        let detail: serde_json::Value = serde_json::from_str(
            r#"{"data":{"base_url":"https://assets.shngm.id","chapter":{
                 "path":"/chapter/manga_x/chapter_y/",
                 "data":["00-a.jpg","01-b.jpg"]}}}"#,
        )
        .unwrap();
        assert_eq!(
            image_urls(&detail),
            vec![
                "https://assets.shngm.id/chapter/manga_x/chapter_y/00-a.jpg".to_string(),
                "https://assets.shngm.id/chapter/manga_x/chapter_y/01-b.jpg".to_string(),
            ]
        );
    }

    #[test]
    fn image_url_fallback_base_low() {
        let detail: serde_json::Value = serde_json::from_str(
            r#"{"data":{"base_url_low":"https://storage.shngm.id","chapter":{
                 "path":"/p/","data":["a.jpg"]}}}"#,
        )
        .unwrap();
        assert_eq!(image_urls(&detail), vec!["https://storage.shngm.id/p/a.jpg".to_string()]);
    }

    #[test]
    fn image_url_kosong_kalau_data_tanpa_base() {
        let detail: serde_json::Value = serde_json::from_str(r#"{"data":null}"#).unwrap();
        assert!(image_urls(&detail).is_empty());
    }

    #[test]
    fn genre_param_slugify_multi_kata() {
        // nama satu-kata dibiarkan (server case-insensitive, slug juga hidup)
        assert_eq!(genre_param("Action"), "Action");
        assert_eq!(genre_param("Romance"), "Romance");
        assert_eq!(genre_param("Sci-fi"), "Sci-fi");
        // nama berspasi -> slug, cocok entri genre/list
        assert_eq!(genre_param("Slice of Life"), "slice-of-life");
        assert_eq!(genre_param("Gender Bender"), "gender-bender");
        assert_eq!(genre_param("Martial Arts"), "martial-arts");
        assert_eq!(genre_param("School Life"), "school-life");
        assert_eq!(genre_param("  School   Life  "), "school-life");
    }

    #[test]
    fn iso8601_epoch_millis() {
        // nilai acuan dari datetime Python (ground truth klien acuan)
        assert_eq!(iso8601_to_millis("1970-01-01T00:00:00Z"), Some(0));
        assert_eq!(iso8601_to_millis("2026-10-11T01:00:21Z"), Some(1791680421000));
        assert_eq!(iso8601_to_millis("2024-11-23T22:43:06Z"), Some(1732401786000));
        assert_eq!(iso8601_to_millis("2000-02-29T12:00:00.500Z"), Some(951825600500));
        // offset non-UTC: WIB (+07:00) mundur 7 jam
        assert_eq!(iso8601_to_millis("1970-01-01T07:00:00+07:00"), Some(0));
        assert_eq!(iso8601_to_millis("2026-10-11T01:00:21"), Some(1791680421000));
        assert_eq!(iso8601_to_millis("bukan tanggal"), None);
        assert_eq!(iso8601_to_millis("2026-13-01T00:00:00Z"), None);
    }

    #[test]
    fn num_str_tanpa_trailing_zero() {
        let n = |s: &str| num_str(Some(&serde_json::from_str::<serde_json::Value>(s).unwrap()));
        assert_eq!(n("921"), Some("921".to_string()));
        assert_eq!(n("8.6"), Some("8.6".to_string()));
        assert_eq!(n("7"), Some("7".to_string()));
        assert_eq!(n("\"12.5\""), Some("12.5".to_string()));
    }

    #[test]
    fn status_mapping() {
        assert_eq!(fmt_status(Some(1)).as_deref(), Some("Ongoing"));
        assert_eq!(fmt_status(Some(2)).as_deref(), Some("Completed"));
        assert_eq!(fmt_status(Some(3)), None);
        assert_eq!(fmt_status(None), None);
    }

    #[test]
    fn manga_dari_list_item() {
        // item lengkap /manga/list
        let item: serde_json::Value = serde_json::from_str(
            r#"{"manga_id":"c0f1d049-ff7f-474d-8c6a-3a55e4c44147",
                 "title":"Demonic Emperor",
                 "cover_portrait_url":"https://assets.shngm.id/p.jpg",
                 "cover_image_url":"https://assets.shngm.id/i.jpg",
                 "status":1,"user_rate":8.6,"latest_chapter_number":921,
                 "latest_chapter_time":"2026-10-11T01:00:21Z",
                 "taxonomy":{"Author":[{"name":"Wuer Manhua"},{"name":"Ye Xiao"}],
                             "Format":[{"name":"Manhua"}]}}"#,
        )
        .unwrap();
        let m = manga_from_value(&SourceId::from("shinigami"), &item).unwrap();
        assert_eq!(m.handle(), "shinigami:c0f1d049-ff7f-474d-8c6a-3a55e4c44147");
        assert_eq!(m.title, "Demonic Emperor");
        assert_eq!(m.author.as_deref(), Some("Wuer Manhua, Ye Xiao"));
        assert_eq!(m.status.as_deref(), Some("Ongoing"));
        assert_eq!(m.manga_type.as_deref(), Some("Manhua"));
        assert_eq!(m.rating.as_deref(), Some("8.6"));
        assert_eq!(m.last_chapter.as_deref(), Some("921"));
        assert_eq!(m.updated_at, Some(1791680421000));
        assert_eq!(m.cover_url.as_deref(), Some("https://assets.shngm.id/p.jpg"));
    }

    #[test]
    fn chapter_judul_dengan_dan_tanpa_chapter_title() {
        let id = SourceId::from("shinigami");
        let c = chapter_from_value(
            &id,
            &serde_json::from_str(
                r#"{"chapter_id":"ch1","chapter_number":12.5,
                     "chapter_title":"The Rise","release_date":"2026-10-10T00:56:48Z"}"#,
            )
            .unwrap(),
        )
        .unwrap();
        assert_eq!(c.title, "Chapter 12.5 - The Rise");
        assert_eq!(c.number, "12.5");
        assert_eq!(c.updated_at, Some(1791593808000));

        let c = chapter_from_value(
            &id,
            &serde_json::from_str(r#"{"chapter_id":"ch2","chapter_number":921,"chapter_title":""}"#)
                .unwrap(),
        )
        .unwrap();
        assert_eq!(c.title, "Chapter 921");
    }
}
