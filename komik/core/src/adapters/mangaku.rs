//! Mangaku adapter (mangaku.lol) — Laravel + Inertia.js SPA.
//!
//! Semua data datang sebagai props JSON di atribut `data-page` pada
//! `<div id="app">` (HTML-entity-encoded), BUKAN JSON API. Halaman error
//! Inertia punya `data-page` valid juga (component `Errors/*`) — dibaca
//! sebagai error, jangan sebagai "hasil kosong".
//!
//! Identitas: manga = slug (`native_id`), chapter = nomor desimal
//! (`chapter_number`, mis. "210" / "1.1"). `last_chapter` di daftar katalog
//! berupa objek chapter — ambil `chapter_number`, bukan dump dict-nya.
//!
//! Ground truth: D:/project/mangaku-cli/mangaku.py. Guard hasil QA
//! adversarial ikut ditiru: komponen `Errors/*` ditolak, slug balasan harus
//! cocok yang diminta, nomor chapter balasan harus cocok, image_path
//! dinormalisasi (absolut/relatif/protocol-relative/berspasi/non-http).
//!
//! Referensi: skills/integration/api-reverse-engineering/references/mangaku-api.md
use crate::model::*;
use crate::source::{classified, Source, SourceError, SourceResult};
use serde_json::Value;
use std::time::Duration;

const UA: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 \
                  (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

pub struct MangakuSource {
    client: reqwest::Client,
    base: String,
}

impl MangakuSource {
    pub fn new(client: reqwest::Client) -> Self {
        let base = std::env::var("MANGAKU_BASE")
            .unwrap_or_else(|_| "https://mangaku.lol".to_string());
        MangakuSource {
            client,
            base: base.trim_end_matches('/').to_string(),
        }
    }

    /// URL absolut dari path relatif (join satu titik, gapless separator).
    fn url(&self, path: &str) -> String {
        format!("{}/{}", self.base, path.trim_start_matches('/'))
    }

    /// GET satu halaman; retry eksponensial pada 429/5xx + error jaringan
    /// (identik mangaku.py: 2x backoff).
    async fn get_text(&self, url: &str) -> SourceResult<String> {
        let mut last: Option<anyhow::Error> = None;
        for attempt in 0..=2u32 {
            // ponytail: timeout ini sengaja lebih longgar dari
            // PER_SOURCE_TIMEOUT_SECS (keputusan aggregator), bukan pembatas
            // ganda — sesuaikan kalau angka di source.rs mau dijadikan batas
            // final di sini.
            let resp = self
                .client
                .get(url)
                .header("User-Agent", UA)
                .timeout(Duration::from_secs(30))
                .send()
                .await;
            let resp = match resp {
                Ok(r) => r,
                Err(e) => {
                    last = Some(e.into());
                    if attempt < 2 {
                        tokio::time::sleep(Duration::from_secs(1 << attempt)).await;
                    }
                    continue;
                }
            };
            let code = resp.status().as_u16();
            if !resp.status().is_success() && matches!(code, 429 | 500 | 502 | 503) && attempt < 2
            {
                last = Some(anyhow::anyhow!("HTTP {code} dari {url}"));
                drop(resp);
                tokio::time::sleep(Duration::from_secs(1 << attempt)).await;
                continue;
            }
            let resp = resp.error_for_status()?;
            return Ok(resp.text().await?);
        }
        Err(last.unwrap_or_else(|| anyhow::anyhow!("unreachable")))
    }

    /// Halaman Inertia -> `props` (objek). Menolak halaman error situs.
    async fn page_props(&self, url: &str) -> SourceResult<Value> {
        let raw = self.get_text(url).await?;
        let page = data_page(&raw)
            .ok_or_else(|| anyhow::anyhow!("data-page tidak ditemukan di {url} (struktur situs berubah?)"))?;
        let component = page.get("component").and_then(|c| c.as_str()).unwrap_or("");
        if component.starts_with("Errors") {
            // halaman 404/500/503 Inertia juga membawa data-page valid yang
            // isinya hampir kosong — jangan dibaca sebagai "hasil kosong"
            anyhow::bail!("halaman error situs ({component}) untuk {url}");
        }
        match page.get("props").and_then(|p| p.as_object()) {
            Some(props) => Ok(Value::Object(props.clone())),
            None => anyhow::bail!("data-page tak terduga dari {url}"),
        }
    }

    /// Katalog `/manga` dengan filter query; validasi bentuk paginator.
    /// `params` = pasangan (kunci, nilai) tambahan selain `page`.
    async fn catalogue(&self, params: &[(&str, String)]) -> SourceResult<Vec<Manga>> {
        let page = params
            .iter()
            .find(|(k, _)| *k == "page")
            .and_then(|(_, v)| v.parse::<u32>().ok())
            .unwrap_or(1)
            .max(1);
        let mut query = format!("page={page}");
        for (k, v) in params.iter().filter(|(k, _)| *k != "page") {
            query.push('&');
            query.push_str(k);
            query.push('=');
            query.push_str(&encode_query_value(v));
        }
        let props = self.page_props(&self.url(&format!("manga?{query}"))).await?;
        let page = props
            .get("mangas")
            .and_then(|m| m.as_object())
            .ok_or_else(|| anyhow::anyhow!("katalog tak terduga dari server (bukan paginator) dari {}", self.base))?;
        let data = page
            .get("data")
            .and_then(|d| d.as_array())
            .ok_or_else(|| anyhow::anyhow!("katalog tak terduga dari server (bukan paginator) dari {}", self.base))?;
        Ok(data.iter().filter_map(|it| self.manga_from(it)).collect())
    }

    /// Katalog + filter genre/status/pencarian (trait `list` tanpa status;
    /// status & pencarian tersedia lewat method ini).
    pub async fn list_filtered(
        &self,
        genre: Option<&str>,
        status: Option<&str>,
        search: Option<&str>,
        sort: Option<&str>,
        page: u32,
    ) -> SourceResult<Vec<Manga>> {
        let mut params: Vec<(&str, String)> = Vec::new();
        if let Some(g) = genre {
            params.push(("genre", g.to_string()));
        }
        if let Some(s) = status {
            params.push(("status", s.to_string()));
        }
        if let Some(q) = search {
            params.push(("search", q.to_string()));
        }
        if let Some(s) = sort {
            params.push(("sort", s.to_string()));
        }
        params.push(("page", page.max(1).to_string()));
        self.catalogue(&params).await
    }

    /// Satu item hasil katalog -> Manga (id = slug).
    fn manga_from(&self, v: &Value) -> Option<Manga> {
        let obj = v.as_object()?;
        let slug = str_of(obj.get("slug"))?;
        let title = str_of(obj.get("title")).unwrap_or_else(|| slug.clone());
        let mut m = Manga::new(SourceId::from("mangaku"), slug.clone(), &title);
        m.cover_url = str_of(obj.get("poster"));
        m.author = str_of(obj.get("author"));
        m.status = str_of(obj.get("status"));
        m.manga_type = str_of(obj.get("type"));
        m.rating = str_of(obj.get("rating"));
        // last_chapter bisa objek chapter (katalog) atau angka/teks
        m.last_chapter = match obj.get("last_chapter") {
            Some(Value::Object(o)) => num_of(o.get("chapter_number")),
            other => num_of(other),
        };
        m.url = Some(self.url(&format!("manga/{slug}")));
        Some(m)
    }
}

#[async_trait::async_trait]
impl Source for MangakuSource {
    fn id(&self) -> SourceId {
        SourceId::from("mangaku")
    }

    async fn popular(&self, page: u32) -> SourceResult<Vec<Manga>> {
        self.catalogue(&[("sort", "popular".to_string()), ("page", page.max(1).to_string())])
            .await
    }

    async fn latest(&self, page: u32) -> SourceResult<Vec<Manga>> {
        self.catalogue(&[("sort", "latest".to_string()), ("page", page.max(1).to_string())])
            .await
    }

    async fn search(&self, query: &str, page: u32) -> SourceResult<Vec<Manga>> {
        self.catalogue(&[("search", query.to_string()), ("page", page.max(1).to_string())])
            .await
    }

    /// Cari judul + filter genre: satu panggilan `list_filtered` (endpoint
    /// katalog yang SUDAH menerima search + genre bersamaan).
    async fn search_in_genre(
        &self,
        query: &str,
        page: u32,
        genre: Option<&str>,
    ) -> SourceResult<Vec<Manga>> {
        self.list_filtered(genre, None, Some(query), None, page).await
    }

    async fn list(&self, genre: Option<&str>, page: u32) -> SourceResult<Vec<Manga>> {
        self.list_filtered(genre, None, None, None, page).await
    }

    async fn genres(&self) -> SourceResult<Vec<(String, String)>> {
        let props = self.page_props(&self.url("manga?page=1")).await?;
        let list = props
            .get("genres")
            .and_then(|g| g.as_array())
            .ok_or_else(|| anyhow::anyhow!("genre list tak terduga dari server"))?;
        Ok(list
            .iter()
            .filter_map(|g| {
                let o = g.as_object()?;
                let slug = str_of(o.get("slug"))?;
                let name = str_of(o.get("name"))?;
                if !super::is_genre(&slug, &name) {
                    return None;
                }
                Some((slug, name))
            })
            .collect())
    }

    async fn series(&self, native_id: &str) -> SourceResult<SeriesDetail> {
        let slug = encode_segment(native_id);
        let props = self
            .page_props(&self.url(&format!("manga/{slug}")))
            .await?;
        let manga = props
            .get("manga")
            .ok_or_else(|| classified(SourceError::Missing, format!("manga '{native_id}' tidak ditemukan")))?;
        // verifikasi slug balasan cocok yang diminta — server bisa mengabaikan
        // slug dan membalas manga lain (atau field slug hilang)
        let slug_back = manga.get("slug").and_then(|s| s.as_str()).unwrap_or("");
        if slug_back != native_id {
            return Err(classified(
                SourceError::Missing,
                format!("manga '{native_id}' tidak ditemukan"),
            ));
        }
        let mut m = self
            .manga_from(manga)
            .ok_or_else(|| classified(SourceError::Missing, format!("manga '{native_id}' tidak ditemukan")))?;

        let mut chapters: Vec<Chapter> = manga
            .get("chapters")
            .and_then(|c| c.as_array())
            .map(|list| {
                list.iter()
                    .filter_map(|c| {
                        let o = c.as_object()?;
                        let number = num_of(o.get("chapter_number"))?;
                        let title = str_of(o.get("title"))
                            .unwrap_or_else(|| format!("Chapter {number}"));
                        let url = self.url(&format!(
                            "manga/{slug}/chapter/{}",
                            encode_segment(&number)
                        ));
                        Some(Chapter {
                            source: SourceId::from("mangaku"),
                            native_id: number.clone(),
                            title,
                            number,
                            // `created_at` (ISO8601) = tanggal rilis chapter.
                            // `updated_at` upstream sengaja TIDAK dipakai: nilainya
                            // timestamp re-scrape (tiap chapter terlihat "hari ini",
                            // terverifikasi live) jadi tak berguna buat recency.
                            updated_at: str_of(o.get("created_at"))
                                .as_deref()
                                .and_then(iso8601_to_millis),
                            url: Some(url),
                        })
                    })
                    .collect()
            })
            .unwrap_or_default();
        // terbaru dulu (chapter_number bisa desimal -> bandingkan sebagai f64)
        chapters.sort_by(|a, b| {
            f64_of(&b.number)
                .total_cmp(&f64_of(&a.number))
        });
        if let Some(first) = chapters.first() {
            m.last_chapter = Some(first.number.clone());
        }
        Ok(SeriesDetail { manga: m, chapters })
    }

    async fn chapter_pages(&self, m: &Manga, c: &Chapter) -> SourceResult<ChapterPages> {
        let slug = &m.native_id;
        let want: f64 = c
            .native_id
            .trim()
            .parse()
            .map_err(|_| classified(
                SourceError::Missing,
                format!("chapter {slug} #{} tidak ditemukan", c.native_id),
            ))?;
        let url = self.url(&format!(
            "manga/{}/chapter/{}",
            encode_segment(slug),
            encode_segment(&c.native_id)
        ));
        let props = self.page_props(&url).await?;
        let ch = props
            .get("chapter")
            .ok_or_else(|| classified(
                SourceError::Missing,
                format!("chapter {slug} #{} tidak ditemukan", c.native_id),
            ))?;
        // verifikasi nomor balasan cocok — server bisa balas chapter lain
        let got = num_of(ch.get("chapter_number"))
            .and_then(|s| s.trim().parse::<f64>().ok())
            .ok_or_else(|| classified(
                SourceError::Missing,
                format!("chapter {slug} #{} tidak ditemukan", c.native_id),
            ))?;
        if got != want {
            return Err(classified(
                SourceError::Missing,
                format!("chapter {slug} #{} tidak ditemukan", c.native_id),
            ));
        }
        let images = image_urls(ch, &self.base);
        if images.is_empty() {
            return Err(classified(
                SourceError::Empty,
                format!("chapter {slug} #{} tidak punya gambar", c.native_id),
            ));
        }
        Ok(ChapterPages {
            source: SourceId::from("mangaku"),
            title: m.title.clone(),
            number: c.number.clone(),
            images,
        })
    }
}

/// URL gambar chapter. Banner promosi situs DIBUANG: sumber menyertakan
/// `image2.komiku.to/komiku-promosi.webp` (order 0) sebagai "halaman pertama"
/// banyak chapter — itu iklan, bukan halaman komik (terverifikasi live:
/// `/manga/one-piece/chapter/1194`). Pencocokan pada path mentah supaya tak
/// bergantung pada hasil percent-encoding; `promo` sudah mencakup "promosi".
fn image_urls(ch: &Value, base: &str) -> Vec<String> {
    ch.get("images")
        .and_then(|i| i.as_array())
        .map(|list| {
            list.iter()
                .filter_map(|im| str_of(im.get("image_path")))
                .filter(|p| !p.to_ascii_lowercase().contains("promo"))
                .filter_map(|p| normalize_image_url(&p, base))
                .collect()
        })
        .unwrap_or_default()
}

/// ISO8601 -> epoch millis. Bentuk sumber (Laravel): `2026-09-26T01:00:22.000000Z`
/// — selalu UTC ("Z"), jadi offset lain ditolak supaya tak salah-tafsir jadi
/// UTC. Fraksi detik dibulatkan ke mili (3 digit pertama). Gagal parse -> None
/// (field `updated_at` memang best-effort).
/// ponytail: duplikat ringkas dari `shinigami::iso8601_to_millis` (fn privat di
/// adapter lain, luar scope lane ini) — pindah ke `model.rs` kalau nanti boleh
/// menyentuh adapter shinigami.
fn iso8601_to_millis(s: &str) -> Option<i64> {
    let s = s.trim();
    let b = s.as_bytes();
    // minimal "YYYY-MM-DDTHH:MM:SS"
    if b.len() < 19 || b[4] != b'-' || b[7] != b'-' || b[10] != b'T' || b[13] != b':' || b[16] != b':' {
        return None;
    }
    let num = |i: usize, j: usize| -> Option<i64> {
        let t = s.get(i..j)?;
        if !t.bytes().all(|c| c.is_ascii_digit()) {
            return None;
        }
        t.parse().ok()
    };
    let (y, mo, dy, hh, mm, ss) = (
        num(0, 4)?,
        num(5, 7)?,
        num(8, 10)?,
        num(11, 13)?,
        num(14, 16)?,
        num(17, 19)?,
    );
    if !(1..=12).contains(&mo) || !(1..=31).contains(&dy) || hh > 23 || mm > 59 || ss > 60 {
        return None;
    }
    // hari sejak 1970-01-01 (days_from_civil, Howard Hinnant) + jam/menit/detik
    let yy = if mo <= 2 { y - 1 } else { y };
    let era = (if yy >= 0 { yy } else { yy - 399 }) / 400;
    let yoe = yy - era * 400;
    let mp = (mo + 9) % 12;
    let doy = (153 * mp + 2) / 5 + dy - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let mut millis = (era * 146_097 + doe - 719_468) * 86_400_000
        + hh * 3_600_000
        + mm * 60_000
        + ss * 1000;
    // fraksi detik opsional; ambil 3 digit pertama sebagai mili
    let mut i = 19;
    if b.get(i) == Some(&b'.') {
        i += 1;
        let start = i;
        let mut frac: i64 = 0;
        let mut seen = 0;
        while i < b.len() && b[i].is_ascii_digit() {
            if seen < 3 {
                frac = frac * 10 + i64::from(b[i] - b'0');
                seen += 1;
            }
            i += 1;
        }
        if seen == 0 && i > start {
            return None;
        }
        millis += frac;
    }
    // sisanya harus "Z" (atau kosong) — offset lain tak didukung
    let tail = s.get(i..)?;
    if !(tail.is_empty() || tail.eq_ignore_ascii_case("z")) {
        return None;
    }
    Some(millis)
}

/// Ambil nilai `data-page="..."` dan decode jadi JSON Inertia (component +
/// props). Nilai atribut adalah JSON yang di-escape jadi HTML entity.
fn data_page(html: &str) -> Option<Value> {
    for (prefix, quote) in [("data-page=\"", '"'), ("data-page='", '\'')] {
        if let Some(start) = html.find(prefix) {
            let from = start + prefix.len();
            // atribut XML tidak boleh memuat kutip pembatas, jadi karakter
            // `"` pertama selalu penutup atribut
            let end = from + html[from..].find(quote)?;
            let decoded = unescape_entities(&html[from..end]);
            return serde_json::from_str(&decoded).ok();
        }
    }
    None
}

/// Decode HTML entity yang dipakai Inertia (`&quot; &#039; &amp; ...`) plus
/// bentuk desimal/hex. Satu pass, seperti html.unescape — `&amp;lt;` jadi
/// `&lt;`, bukan `<`.
fn unescape_entities(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut rest = s;
    while let Some(i) = rest.find('&') {
        out.push_str(&rest[..i]);
        let tail = &rest[i..];
        match entity_at(tail) {
            Some((replacement, len)) => {
                out.push_str(&replacement);
                rest = &tail[len..];
            }
            None => {
                out.push('&');
                rest = &tail[1..];
            }
        }
    }
    out.push_str(rest);
    out
}

/// `entity_at("&quot;x")` -> Some(("\"", 6)). None = bukan entity dikenal.
fn entity_at(s: &str) -> Option<(String, usize)> {
    let end = s.find(';')?;
    let body = &s[1..end];
    if body.is_empty() || body.len() > 32 {
        return None;
    }
    let ch = if let Some(hex) = body.strip_prefix("#x").or_else(|| body.strip_prefix("#X")) {
        u32::from_str_radix(hex, 16).ok().and_then(char::from_u32)?
    } else if let Some(dec) = body.strip_prefix('#') {
        dec.parse::<u32>().ok().and_then(char::from_u32)?
    } else {
        match body {
            "quot" => '"',
            "apos" | "39" => '\'',
            "amp" => '&',
            "lt" => '<',
            "gt" => '>',
            "nbsp" => '\u{a0}',
            // nama lain: keluarkan apa adanya
            _ => return None,
        }
    };
    Some((ch.to_string(), end + 1))
}

/// String field: trim; kosong dan "-" (placeholder situs) jadi None.
fn str_of(v: Option<&Value>) -> Option<String> {
    match v? {
        Value::String(s) => Some(s.trim().to_string()),
        Value::Number(n) => Some(n.to_string()),
        Value::Bool(b) => Some(b.to_string()),
        _ => None,
    }
    .filter(|s| !s.is_empty() && s != "-")
}

/// Field angka (boleh datang sebagai JSON number atau teks desimal).
/// 210.0 -> "210" (bukan "210.0"), 1.1 -> "1.1".
fn num_of(v: Option<&Value>) -> Option<String> {
    match v? {
        Value::Number(n) => fmt_num(n.as_f64()?),
        Value::String(s) => {
            let t = s.trim();
            if t.is_empty() || t == "-" {
                None
            } else {
                Some(t.to_string())
            }
        }
        _ => None,
    }
}

fn fmt_num(f: f64) -> Option<String> {
    if f.fract() == 0.0 && f.abs() < 1e15 {
        Some(format!("{}", f as i64))
    } else {
        Some(format!("{f}"))
    }
}

fn f64_of(s: &str) -> f64 {
    s.trim().parse().unwrap_or(0.0)
}

/// Percent-encode ala `urllib.parse.quote`: byte non-unreserved jadi %XX,
/// `keep` = karakter tambahan yang dipertahankan apa adanya.
fn encode_with(s: &str, space_plus: bool, keep: &str) -> String {
    let mut out = String::with_capacity(s.len() * 3);
    for &b in s.as_bytes() {
        if b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.' | b'~') || keep.as_bytes().contains(&b) {
            out.push(b as char);
        } else if b == b' ' {
            out.push_str(if space_plus { "+" } else { "%20" });
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}

/// Nilai query (urlencode: spasi -> `+`).
fn encode_query_value(s: &str) -> String {
    encode_with(s, true, "")
}

/// Path URL: `/` dipertahankan (quote safe='/'), spasi -> %20.
fn encode_path(s: &str) -> String {
    encode_with(s, false, "/")
}

/// Satu segmen path (slug/nomor chapter): `/` ikut di-escape.
fn encode_segment(s: &str) -> String {
    encode_with(s, false, "")
}

/// Normalisasi `image_path` jadi URL absolut yang siap dipakai reqwest:
/// absolut / relatif / protocol-relative / berspasi / non-ASCII di-quote,
/// skema non-http dilewati (None).
fn normalize_image_url(p: &str, base: &str) -> Option<String> {
    let p = p.trim();
    if p.is_empty() {
        return None;
    }
    let full = if p.starts_with("//") {
        // protocol-relative: tambahkan skema, TANPA membuang slash-nya
        format!("https:{p}")
    } else if p.contains("://") {
        p.to_string()
    } else {
        // Relatif? Hanya kalau tak memakai skema sendiri. "data:..." /
        // "mailto:..." tak punya "://" tapi tetap URI, bukan path — buang.
        let colon_at = p.find(':');
        let slash_at = p.find('/');
        if colon_at.is_some() && slash_at.is_none_or(|s| colon_at < Some(s)) {
            return None;
        }
        return Some(format!("{}/{}", base, encode_path(p.trim_start_matches('/'))));
    };
    let (scheme, rest) = full.split_once("://")?;
    if scheme != "http" && scheme != "https" {
        return None;
    }
    let (host, path_q) = match rest.split_once('/') {
        Some((h, p)) => (h, format!("/{p}")),
        None => (rest, String::new()),
    };
    let (path, query) = match path_q.split_once('?') {
        Some((pth, q)) => (pth, q),
        None => (path_q.as_str(), ""),
    };
    let mut out = format!("{scheme}://{host}{}", encode_path(path));
    if !query.is_empty() {
        out.push('?');
        out.push_str(&encode_with(query, false, "=&"));
    }
    Some(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn json_page(component: &str, props: serde_json::Value) -> String {
        // tiru Inertia: JSON props di-escape jadi HTML entity di dalam
        // atribut data-page
        let page = serde_json::json!({
            "component": component,
            "props": props,
            "url": "/manga",
            "version": "1",
        })
        .to_string()
        .replace('"', "&quot;")
        .replace('\'', "&#039;");
        format!("<html><body><div id=\"app\" data-page=\"{page}\"></div></body></html>")
    }

    const PAGINATOR: &str = r#"{
        "current_page": 1, "last_page": 322, "per_page": 24, "total": 7722,
        "data": [{
            "id": 2165, "title": "Batsu Harem",
            "slug": "batsu-harembatsu-harem", "status": "Ongoing",
            "type": "Manga", "rating": "10.0", "author": "-",
            "poster": "https://t.example/x.jpg?w=500",
            "last_chapter": {"id": 404866, "chapter_number": 210},
            "genres": [{"name": "Harem", "slug": "harem"}]
        }]
    }"#;

    #[test]
    fn promo_banner_dibuang_dari_images() {
        // Bentuk live: images[0] = banner promosi situs (image2/3.komiku.to)
        let ch: serde_json::Value = serde_json::json!({
            "chapter_number": 1194,
            "images": [
                {"image_path": "https://image2.komiku.to/komiku-promosi.webp", "order": 0},
                {"image_path": "https://image2.komiku.to/upload5/one-piece/1194/1.webp", "order": 1},
                {"image_path": "https://image3.komiku.to/upload5/one-piece/1194/2.webp", "order": 2}
            ]
        });
        let imgs = image_urls(&ch, "https://mangaku.lol");
        assert_eq!(imgs.len(), 2, "banner promosi harus dibuang: {imgs:?}");
        assert!(imgs[0].ends_with("1.webp"));
        assert!(imgs[1].ends_with("2.webp"));

        // nama lain dengan kata "promo" ikut dibuang (case-insensitive)
        let ch2: serde_json::Value = serde_json::json!({
            "images": [{"image_path": "https://cdn.test/PROMO-banner.png"},
                       {"image_path": "https://cdn.test/real/1.jpg"}]
        });
        assert_eq!(
            image_urls(&ch2, "https://mangaku.lol"),
            vec!["https://cdn.test/real/1.jpg".to_string()]
        );

        // tak ada images -> kosong (bukan panic)
        assert!(image_urls(&serde_json::json!({}), "https://mangaku.lol").is_empty());
    }

    #[test]
    fn iso8601_chapter_created_at() {
        // bentuk live: "2026-09-26T01:00:22.000000Z"
        assert_eq!(
            iso8601_to_millis("2026-09-26T01:00:22.000000Z"),
            Some(1_790_384_422_000)
        );
        assert_eq!(
            iso8601_to_millis("2026-03-30T05:31:47.000000Z"),
            Some(1_774_848_707_000)
        );
        // tanpa fraksi & tanpa Z
        assert_eq!(
            iso8601_to_millis("2026-09-26T01:00:22"),
            Some(1_790_384_422_000)
        );
        // fraksi lebih dari 3 digit -> potong ke mili
        assert_eq!(
            iso8601_to_millis("2026-09-26T01:00:22.123456Z"),
            Some(1_790_384_422_123)
        );
        // sampah / offset non-UTC -> None
        assert_eq!(iso8601_to_millis(""), None);
        assert_eq!(iso8601_to_millis("26 September 2026"), None);
        assert_eq!(iso8601_to_millis("2026-09-26T01:00:22+07:00"), None);
    }

    #[test]
    fn entity_decode_unescapes_once() {
        // &amp; harus jadi & lalu literal, bukan dirunut jadi <
        assert_eq!(unescape_entities("a&amp;lt;b"), "a&lt;b");
        assert_eq!(unescape_entities("&quot;x&quot;"), "\"x\"");
        assert_eq!(unescape_entities("a&#039;b"), "a'b");
        assert_eq!(unescape_entities("a&#x27;b"), "a'b");
        assert_eq!(unescape_entities("&bukan;"), "&bukan;");
    }

    #[test]
    fn data_page_parses_and_rejects_errors() {
        let props: serde_json::Value = serde_json::from_str(PAGINATOR).unwrap();
        let html = json_page("Manga/Index", serde_json::json!({ "mangas": props }));
        let page = data_page(&html).expect("data-page harus ter-parse");
        assert_eq!(
            page["component"].as_str(),
            Some("Manga/Index"),
            "komponen salah"
        );
        assert_eq!(page["props"]["mangas"]["total"].as_u64(), Some(7722));
        assert_eq!(
            page["props"]["mangas"]["data"][0]["title"].as_str(),
            Some("Batsu Harem")
        );
        assert!(
            data_page("<html>tanpa data-page</html>").is_none(),
            "HTML tanpa data-page harus None"
        );
    }

    #[test]
    fn num_of_treats_float_and_string() {
        // 210.0 -> "210"; 1.1 -> "1.1" (JSON number maupun string desimal)
        let n: serde_json::Value = serde_json::json!({"a": 210.0, "b": 1.1,
                                                     "c": "1.1", "d": "-", "e": ""});
        let o = n.as_object().unwrap();
        assert_eq!(num_of(o.get("a")).as_deref(), Some("210"));
        assert_eq!(num_of(o.get("b")).as_deref(), Some("1.1"));
        assert_eq!(num_of(o.get("c")).as_deref(), Some("1.1"));
        assert!(num_of(o.get("d")).is_none(), "placeholder \"-\" harus None");
        assert!(num_of(o.get("e")).is_none(), "string kosong harus None");
    }

    #[test]
    fn normalize_image_url_matches_reference() {
        let base = "https://mangaku.lol";
        let n = |p: &str| normalize_image_url(p, base);
        // spasi depan-belakang di-strip + path di-quote
        assert_eq!(n(" https://img.test/a b.jpg ").as_deref(),
                   Some("https://img.test/a%20b.jpg"));
        // non-ASCII
        assert_eq!(n("https://img.test/café.jpg").as_deref(),
                   Some("https://img.test/caf%C3%A9.jpg"));
        // protocol-relative -> https
        assert_eq!(n("//cdn.other/x.webp").as_deref(),
                   Some("https://cdn.other/x.webp"));
        // relatif dengan & tanpa leading slash -> absolut
        assert_eq!(n("/img/a b.jpg").as_deref(), Some(format!("{base}/img/a%20b.jpg").as_str()));
        assert_eq!(n("img/x.webp").as_deref(), Some(format!("{base}/img/x.webp").as_str()));
        // path asli host image2 punya / di path — TIDAK boleh jadi %2F
        assert_eq!(n("https://image2.komiku.to/komiku-promosi.webp").as_deref(),
                   Some("https://image2.komiku.to/komiku-promosi.webp"));
        // skema non-http dilewati; kosong -> None
        assert!(n("data:image/png;base64,AAAA").is_none());
        assert!(n("").is_none());
    }

    #[test]
    fn encode_helpers() {
        assert_eq!(encode_query_value("a b&c"), "a+b%26c");
        assert_eq!(encode_path("/a b/c.jpg"), "/a%20b/c.jpg");
        assert_eq!(encode_segment("a/b"), "a%2Fb");
    }

    #[test]
    fn entity_at_consumes_only_known_entity() {
        assert_eq!(entity_at("&quot;xyz").unwrap().1, 6);
        assert!(entity_at("&bukan;").is_none());
        assert!(entity_at("tanpa-semicolon").is_none());
    }
}
