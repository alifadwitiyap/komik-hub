//! Komikindo (komikindo.ch) — WordPress theme ki-newgen, TANPA REST API.
//!
//! Semua data diambil dari HTML:
//!   listing/cari/genre : `div.animposx` (kartu manga)
//!   series             : `/komik/{slug}/` -> `div.spe` + `span.lchx`
//!   chapter            : `/{slug}-chapter-{n}/` -> `div.chapter-content > img`
//!
//! Catatan penting (terverifikasi live):
//!  - slug manga di daftar MEMPUNYAI prefix angka (`345461-overgeared`).
//!  - URL chapter memakai slug TANPA prefix (`overgeared-chapter-1/`).
//!  - WP REST API mati (`rest_no_route`), jadi genre diambil dari checkbox
//!    `name="genre[]"` di halaman `/daftar-manga/`.
//!  - reader asli hanya img yang URL-nya mengandung `/media/`; sisanya
//!    placeholder GIF `blogger.googleusercontent.com` (jangan dikirim ke UI).
//!  - parser HTML std (tanpa crate regex/scraper) mengikuti kiryuu.rs.
use crate::model::*;
use crate::source::{classified, Source, SourceError, SourceResult};
use serde_json::Value;
use std::collections::HashSet;
use std::net::{IpAddr, SocketAddr};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tokio::sync::{OnceCell, RwLock};

const UA: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 \
                  (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const ID: &str = "komikindo";
const DOH_ENDPOINT: &str = "https://cloudflare-dns.com/dns-query";
const DOH_TIMEOUT: Duration = Duration::from_secs(6);
const PINNED_CONNECT_TIMEOUT: Duration = Duration::from_secs(5);
const PINNED_REQUEST_TIMEOUT: Duration = Duration::from_secs(20);

pub struct KomikindoSource {
    /// Dipakai untuk query DoH (host cloudflare-dns.com tidak terkena block).
    shared: reqwest::Client,
    base: String,
    host: String,
    /// IP hasil DoH, di-cache sampai proses restart (sama seperti kiryuu.rs).
    ips: RwLock<Vec<IpAddr>>,
    /// Client dengan `resolve_to_addrs` ke IP DoH — dibangun sekali.
    pinned: OnceCell<reqwest::Client>,
}

impl KomikindoSource {
    pub fn new(client: reqwest::Client) -> Self {
        let base =
            std::env::var("KOMIKINDO_BASE").unwrap_or_else(|_| "https://komikindo.ch".into());
        let host = host_of(&base);
        KomikindoSource {
            shared: client,
            base: base.trim_end_matches('/').to_string(),
            host,
            ips: RwLock::new(Vec::new()),
            pinned: OnceCell::new(),
        }
    }

    /// Resolve host base via Cloudflare DoH lalu pin ke IP asli. Router lokal
    /// melakukan DNS poisoning `komikindo.ch` → `blocking.asus.hns.tm` (cert
    /// salah / halaman 404), jadi resolver sistem tidak bisa dipakai.
    async fn resolve_ips(&self) -> SourceResult<Vec<IpAddr>> {
        let cached = self.ips.read().await.clone();
        if !cached.is_empty() {
            return Ok(cached);
        }
        let url = format!("{}?name={}&type=A", DOH_ENDPOINT, self.host);
        let resp = self
            .shared
            .get(&url)
            .header("accept", "application/dns-json")
            .timeout(DOH_TIMEOUT)
            .send()
            .await
            .map_err(|e| anyhow::anyhow!("DoH request gagal untuk {}: {}", self.host, e))?;
        let status = resp.status();
        let body = resp.text().await.unwrap_or_default();
        if !status.is_success() {
            anyhow::bail!(
                "DoH balas {} untuk {}: {}",
                status,
                self.host,
                body.chars().take(120).collect::<String>()
            );
        }
        let v: Value = serde_json::from_str(&body)
            .map_err(|e| anyhow::anyhow!("DoH bukan JSON ({}): {}", e, body.chars().take(120).collect::<String>()))?;
        // Tolak jawaban DoH yang sudah terpollusi (IP block page router).
        // `IpAddr::is_global` masih unstable di rustc 1.99, jadi pakai pemeriksaan
        // eksplisit: satu saja alamat special-use tidak boleh masuk kandidat.
        let mut ips = Vec::new();
        if let Some(ans) = v["Answer"].as_array() {
            for a in ans {
                if a["type"].as_u64() == Some(1) {
                    if let Some(d) = a["data"].as_str() {
                        if let Ok(ip) = d.parse::<IpAddr>() {
                            if is_public_doh_ip(ip) {
                                ips.push(ip);
                            }
                        }
                    }
                }
            }
        }
        if ips.is_empty() {
            anyhow::bail!(
                "DoH tak kembalikan A record publik untuk {} (DNS poisoning + DoH gagal?)",
                self.host
            );
        }
        *self.ips.write().await = ips.clone();
        Ok(ips)
    }

    async fn http(&self) -> SourceResult<reqwest::Client> {
        self.pinned
            .get_or_try_init(|| async {
                // reqwest mewarisi HTTPS_PROXY dari environment; 127.0.0.1:37837
                // ikut menebus TLS ke host block page. Matikan proxy hanya untuk
                // client yang dipin — DoH tetap memakai `shared`.
                #[allow(clippy::redundant_closure)]
                let addrs: Vec<SocketAddr> = self
                    .resolve_ips()
                    .await?
                    .into_iter()
                    .map(|ip| SocketAddr::new(ip, 0))
                    .collect();
                let mut b = reqwest::Client::builder()
                    .user_agent(UA)
                    .no_proxy()
                    .connect_timeout(PINNED_CONNECT_TIMEOUT)
                    .timeout(PINNED_REQUEST_TIMEOUT);
                for d in [format!("{}:443", self.host), format!("{}:80", self.host)] {
                    b = b.resolve_to_addrs(&d, &addrs);
                }
                b.build().map_err(Into::into)
            })
            .await
            .cloned()
    }

    async fn fetch_with(&self, client: &reqwest::Client, url: &str) -> SourceResult<String> {
        let mut attempt = 0u32;
        loop {
            match client.get(url).header("user-agent", UA).send().await {
                Ok(r) => {
                    let sc = r.status().as_u16();
                    if (sc == 429 || sc >= 500) && attempt < 2 {
                        attempt += 1;
                        tokio::time::sleep(Duration::from_millis((1u64 << attempt) * 150)).await;
                        continue;
                    }
                    if !r.status().is_success() {
                        anyhow::bail!("HTTP {} dari {}", sc, url);
                    }
                    return r
                        .text()
                        .await
                        .map_err(|e| anyhow::anyhow!("baca body {} gagal: {}", url, e));
                }
                Err(_) if attempt < 2 => {
                    attempt += 1;
                    tokio::time::sleep(Duration::from_millis(250)).await;
                }
                Err(e) => anyhow::bail!("network error {}: {}", url, e),
            }
        }
    }

    /// Utamakan client yang dipin ke IP DoH (anti DNS poisoning router).
    /// Kalau jaringan masih mem-blok TLS langsung ke IP Cloudflare, jatuh ke
    /// client bawaan yang memakai proxy/DNS sistem — ini yang dipakai Kiryuu
    /// dan akan langsung sehat begitu user pindah jaringan bersih.
    async fn fetch_text(&self, url: &str) -> SourceResult<String> {
        let pinned_err = match self.http().await {
            Ok(client) => match self.fetch_with(&client, url).await {
                Ok(body) => return Ok(body),
                Err(e) => e.to_string(),
            },
            Err(e) => e.to_string(),
        };
        match self.fetch_with(&self.shared, url).await {
            Ok(body) => Ok(body),
            Err(shared) => anyhow::bail!("DoH-pin gagal: {}; fallback gagal: {}", pinned_err, shared),
        }
    }

    fn url(&self, path: &str) -> String {
        if path.starts_with("http://") || path.starts_with("https://") {
            path.to_string()
        } else if path.starts_with('/') {
            format!("{}{}", self.base, path)
        } else {
            format!("{}/{}", self.base, path)
        }
    }

    /// Halaman kartu manga (`/?s=`, `/komik-terbaru/`, `/daftar-manga/`).
    async fn listing(&self, path: &str) -> SourceResult<Vec<Manga>> {
        let html = self.fetch_text(&self.url(path)).await?;
        Ok(parse_items(&html, &self.base))
    }

    /// Satu halaman series + daftar chapter (satu request, keduanya ada di HTML).
    async fn fetch_series(&self, native_id: &str) -> SourceResult<SeriesDetail> {
        let url = self.url(&format!("/komik/{}/", encode_path(native_id)));
        let html = self.fetch_text(&url).await?;
        if html.contains("<title>Page not found") || html.contains("BacaKomik") {
            return Err(classified(
                SourceError::Missing,
                format!("komikindo:{} tidak ditemukan", native_id),
            ));
        }
        Ok(parse_series(&html, native_id, &url))
    }
}

#[async_trait::async_trait]
impl Source for KomikindoSource {
    fn id(&self) -> SourceId {
        SourceId::from(ID)
    }

    async fn popular(&self, page: u32) -> SourceResult<Vec<Manga>> {
        self.listing(&format!("/komik-terbaru/page/{}/", page.max(1))).await
    }

    async fn latest(&self, page: u32) -> SourceResult<Vec<Manga>> {
        self.listing(&format!("/komik-terbaru/page/{}/", page.max(1))).await
    }

    async fn search(&self, query: &str, page: u32) -> SourceResult<Vec<Manga>> {
        let path = format!("/?s={}&page={}", query_encode(query), page.max(1));
        self.listing(&path).await
    }

    async fn search_in_genre(
        &self,
        query: &str,
        page: u32,
        genre: Option<&str>,
    ) -> SourceResult<Vec<Manga>> {
        let Some(g) = genre else { return self.search(query, page).await };
        let path = format!(
            "/?s={}&genre%5B%5D={}&page={}",
            query_encode(query),
            query_encode(g),
            page.max(1)
        );
        self.listing(&path).await
    }

    async fn list(&self, genre: Option<&str>, page: u32) -> SourceResult<Vec<Manga>> {
        let p = page.max(1);
        let path = match genre {
            Some(g) if !g.is_empty() => format!(
                "/daftar-manga/page/{}/?genre%5B%5D={}",
                p,
                query_encode(g)
            ),
            _ => format!("/daftar-manga/page/{}/", p),
        };
        self.listing(&path).await
    }

    async fn genres(&self) -> SourceResult<Vec<(String, String)>> {
        let html = self.fetch_text(&self.url("/daftar-manga/")).await?;
        Ok(parse_genres(&html))
    }

    async fn series(&self, native_id: &str) -> SourceResult<SeriesDetail> {
        self.fetch_series(native_id).await
    }

    async fn chapter_pages(&self, manga: &Manga, chapter: &Chapter) -> SourceResult<ChapterPages> {
        let url = chapter
            .url
            .clone()
            .ok_or_else(|| classified(SourceError::Missing, "chapter tanpa URL"))?;
        let html = self.fetch_text(&url).await?;
        let images = parse_reader_images(&html, &self.base);
        if images.is_empty() {
            return Err(classified(
                SourceError::Empty,
                format!("{} chapter {} tanpa gambar reader", manga.title, chapter.number),
            ));
        }
        Ok(ChapterPages {
            source: SourceId::from(ID),
            title: chapter.title.clone(),
            number: chapter.number.clone(),
            images,
        })
    }
}

/// Host tanpa skema/port, dipakai untuk query DoH dan `resolve_to_addrs`.
fn host_of(base: &str) -> String {
    let after = base.split_once("://").map(|(_, h)| h).unwrap_or(base);
    after.split(['/', ':']).next().unwrap_or(after).to_string()
}

/// Satu alamat A/AAAA DoH boleh dipin hanya bila benar-benar publik.
/// `IpAddr::is_global` masih unstable pada toolchain repo (rustc 1.99),
/// jadi special-use address ditolak eksplisit satu per satu.
fn is_public_doh_ip(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => {
            let o = v4.octets();
            !v4.is_unspecified()
                && !v4.is_loopback()
                && !v4.is_private()
                && !v4.is_link_local()
                && !v4.is_multicast()
                && !v4.is_broadcast()
                && !(o[0] == 100 && (0x40..=0x7f).contains(&o[1])) // 100.64.0.0/10 CGNAT
                && !(o[0] >= 240) // 240.0.0.0/4 reserved
        }
        IpAddr::V6(v6) => {
            let s = v6.segments();
            !v6.is_unspecified()
                && !v6.is_loopback()
                && !v6.is_multicast()
                && !(s[0] & 0xfe00 == 0xfc00) // fc00::/7 unique local
                // fe80::/10 link local
                && !(s[0] & 0xffc0 == 0xfe80)
                // ::ffff:0:0/96 IPv4-mapped: evaluasi alamat IPv4-nya
                && !(s[0] == 0
                    && s[1] == 0
                    && s[2] == 0
                    && s[3] == 0
                    && s[4] == 0
                    && s[5] == 0xffff
                    && !is_public_doh_ip(IpAddr::V4(std::net::Ipv4Addr::from([
                        (s[6] >> 8) as u8,
                        s[6] as u8,
                        (s[7] >> 8) as u8,
                        s[7] as u8,
                    ]))))
        }
    }
}

/// `<div class="animposx">` kartu di listing/cari/genre.
fn parse_items(html: &str, base: &str) -> Vec<Manga> {
    let mut out = Vec::new();
    let mut seen = HashSet::new();
    for chunk in sections(html, "class=\"animposx\"") {
        let Some(slug) = manga_slug(chunk) else { continue };
        if !seen.insert(slug.clone()) {
            continue;
        }
        let title = tag_at(chunk, "h3", 0)
            .and_then(|(_, inner, _)| tag_at(inner, "a", 0))
            .map(|(_, inner, _)| strip_html(inner))
            .filter(|s| !s.is_empty())
            .or_else(|| {
                tag_at(chunk, "a", 0)
                    .and_then(|(raw, _, _)| attr_value(raw, "title"))
                    .map(|t| t.strip_prefix("Komik ").unwrap_or(&t).trim().to_string())
            })
            .unwrap_or_else(|| slug.clone());
        let mut m = Manga::new(SourceId::from(ID), slug.clone(), &title);
        m.url = Some(format!("{}/komik/{}/", base, encode_path(&slug)));
        m.cover_url = tag_at(chunk, "img", 0)
            .and_then(|(raw, _, _)| attr_value(raw, "src"))
            .map(|s| encode_and_join(base, &s));
        m.manga_type = class_token(chunk, "typeflag").map(|s| {
            // "Manhwa" -> "Manhwa"; dipakai UI sebagai tipe.
            s.to_string()
        });
        for r in sections(chunk, "class=\"rating\"") {
            if let Some((_, inner, _)) = tag_at(r, "i", 0) {
                m.rating = normalize_score(inner.trim());
                break;
            }
        }
        for l in sections(chunk, "class=\"lsch\"") {
            if let Some((raw, _, _)) = tag_at(l, "a", 0) {
                if let Some(href) = attr_value(raw, "href") {
                    m.last_chapter = chapter_from_url(&href);
                }
            }
        }
        for d in sections(chunk, "class=\"datech\"") {
            // sections() mulai di tengah tag (class="datech") — ambil teks
            // antara '>' penutup tag dan '<' berikutnya.
            let start = d.find('>').map(|i| i + 1).unwrap_or(0);
            let end = d[start..].find('<').map(|i| start + i).unwrap_or(d.len());
            let txt = strip_html(&d[start..end]);
            m.updated_at = parse_relative_date(&txt);
            if m.updated_at.is_some() {
                break;
            }
        }
        out.push(m);
    }
    out
}

fn manga_slug(chunk: &str) -> Option<String> {
    let i = chunk.find("/komik/")?;
    let rest = &chunk[i + 7..];
    let end = rest.find('/')?;
    let slug = &rest[..end];
    if slug.is_empty() || slug.contains('?') || slug.contains('#') {
        return None;
    }
    Some(slug.to_string())
}

fn parse_genres(html: &str) -> Vec<(String, String)> {
    let mut out = Vec::new();
    let mut seen = HashSet::new();
    let mut pos = 0usize;
    while let Some(r) = html.get(pos..).and_then(|s| s.find("name=\"genre[]\"")) {
        let start = pos + r;
        let end = html[start..]
            .find('>')
            .map(|x| start + x + 1)
            .unwrap_or(start);
        let tag = &html[start..end];
        let Some(slug) = attr_value(tag, "value") else {
            pos = end;
            continue;
        };
        // Label ada di <label for="genre-{slug}"> ... </label>, setelah input.
        let label = html.get(end..).and_then(|rest| {
            let needle = format!("for=\"genre-{}\"", slug);
            let k = rest.find(&needle)?;
            let gt = rest[k..].find('>')? + k + 1;
            let close = rest[gt..].find("</label>")? + gt;
            Some(strip_html(&rest[gt..close]))
        });
        pos = end;
        if slug.is_empty() || !seen.insert(slug.clone()) {
            continue;
        }
        out.push((slug.clone(), label.filter(|s| !s.is_empty()).unwrap_or(slug)));
    }
    out
}

fn parse_series(html: &str, native_id: &str, url: &str) -> SeriesDetail {
    let title = tag_at(html, "h1", 0)
        .map(|(_, inner, _)| strip_html(inner))
        .map(|s| {
            // h1 situs ber-prefix "Komik" dan bisa mengandung newline/spasi
            // internal: "Komik\n Black Killer Whale Baby" -> "Black Killer Whale Baby".
            let s = s.split_whitespace().collect::<Vec<_>>().join(" ");
            s.strip_prefix("Komik")
                .map(|s| s.trim_start())
                .unwrap_or(&s)
                .to_string()
        })
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| native_id.to_string());
    let mut m = Manga::new(SourceId::from(ID), native_id.to_string(), &title);
    m.url = Some(url.to_string());

    // Metadata di <div class="spe"><span><b>Label:</b>nilai</span>...
    if let Some(block) = sections(html, "class=\"spe\"").into_iter().next() {
        let mut from = 0usize;
        while let Some((_, span, end)) = tag_at(block, "span", from) {
            from = end.max(from + 1);
            let Some((_, label, l_end)) = tag_at(span, "b", 0) else { continue };
            let label = label.trim().trim_end_matches(':').trim().to_lowercase();
            let value = strip_html(&span[l_end..]);
            if value.is_empty() {
                continue;
            }
            match label.as_str() {
                "status" => m.status = Some(value),
                "pengarang" => m.author = Some(value),
                "jenis komik" => m.manga_type = Some(value),
                _ => {}
            }
        }
    }
    // Rating: <i itemprop="ratingValue">8.58</i>
    if let Some(k) = html.find("itemprop=\"ratingValue\"") {
        if let Some((raw, _, _)) = tag_at(html, "i", k.saturating_sub(8)) {
            if raw.contains("ratingValue") {
                m.rating = normalize_score(&strip_html(
                    html[k + "itemprop=\"ratingValue\"".len()..]
                        .split('<')
                        .next()
                        .unwrap_or(""),
                ));
            }
        }
    }
    m.cover_url = html
        .match_indices("itemprop=\"image\"")
        .take(5)
        .find_map(|(k, _)| tag_at(html, "img", k.saturating_sub(250)))
        .and_then(|(raw, _, _)| {
            if raw.contains("itemprop=\"image\"") {
                attr_value(raw, "src")
            } else {
                None
            }
        })
        .map(|s| encode_and_join(&self_origin(url), &s));

    let chapters = parse_chapters(html, url);
    m.last_chapter = chapters.first().map(|c| c.number.clone());
    SeriesDetail { manga: m, chapters }
}

fn parse_chapters(html: &str, base_url: &str) -> Vec<Chapter> {
    let mut out = Vec::new();
    let mut seen = HashSet::new();
    for chunk in sections(html, "class=\"lchx\"") {
        let Some((raw, _, _)) = tag_at(chunk, "a", 0) else { continue };
        let Some(href) = attr_value(raw, "href") else { continue };
        if !href.contains("-chapter-") {
            continue;
        }
        let url = encode_and_join(base_url, &href);
        if !seen.insert(url.clone()) {
            continue;
        }
        let number = tag_at(chunk, "chapter", 0)
            .map(|(_, inner, _)| strip_html(inner))
            .filter(|s| !s.is_empty())
            .or_else(|| chapter_from_url(&href))
            .unwrap_or_default();
        if number.is_empty() {
            continue;
        }
        let title = format!("Chapter {}", number);
        let mut updated = None;
        if let Some(dt) = sections(chunk, "class=\"dt\"").first() {
            updated = tag_at(dt, "a", 0)
                .map(|(_, inner, _)| strip_html(inner))
                .or_else(|| Some(strip_html(dt)))
                .and_then(|s| parse_relative_date(&s));
        }
        out.push(Chapter {
            source: SourceId::from(ID),
            native_id: number.clone(),
            title,
            number,
            updated_at: updated,
            url: Some(url),
        });
    }
    out.sort_by(|a, b| {
        chapter_f64(&b.number)
            .partial_cmp(&chapter_f64(&a.number))
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    out
}

fn parse_reader_images(html: &str, base: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut seen = HashSet::new();
    if let Some(block) = sections(html, "class=\"chapter-content\"").into_iter().next() {
        let mut from = 0usize;
        while let Some((raw, _, end)) = tag_at(block, "img", from) {
            from = end.max(from + 1);
            let Some(src) = attr_value(raw, "src").or_else(|| attr_value(raw, "data-src")) else {
                continue;
            };
            // Hanya gambar reader asli (/media/...); placeholder blogger dibuang.
            if !src.contains("/media/") {
                continue;
            }
            let u = encode_and_join(base, &src);
            if seen.insert(u.clone()) {
                out.push(u);
            }
        }
    }
    out
}

// ---------- util HTML/string std ----------

/// Potong `html` tiap kali `marker` muncul (inklusif) sampai marker berikutnya.
fn sections<'a>(html: &'a str, marker: &str) -> Vec<&'a str> {
    let mut out = Vec::new();
    let mut pos = 0usize;
    while let Some(r) = html.get(pos..).and_then(|s| s.find(marker)) {
        let start = pos + r;
        let after = start + marker.len();
        pos = html
            .get(after..)
            .and_then(|s| s.find(marker))
            .map(|r2| after + r2)
            .unwrap_or(html.len());
        out.push(&html[start..pos]);
    }
    out
}

/// (tag pembuka, isi, index setelah tag penutup) untuk `<{tag} ...>isi</{tag}>`.
fn tag_at<'a>(html: &'a str, tag: &str, from: usize) -> Option<(&'a str, &'a str, usize)> {
    let needle = format!("<{}", tag);
    let close = format!("</{}>", tag);
    let mut pos = from;
    loop {
        let rel = html.get(pos..)?.find(&needle)?;
        let start = pos + rel;
        let after = start + needle.len();
        let boundary = html
            .as_bytes()
            .get(after)
            .is_none_or(|b| b.is_ascii_whitespace() || *b == b'>');
        if boundary {
            let gt = after + html.get(after..)?.find('>')?;
            let raw = &html[start..=gt];
            if let Some(cr) = html.get(gt + 1..)?.find(&close) {
                let inner_start = gt + 1;
                let inner_end = inner_start + cr;
                return Some((raw, &html[inner_start..inner_end], inner_end + close.len()));
            }
            return Some((raw, "", gt + 1)); // tag void (<img>)
        }
        pos = after;
    }
}

fn attr_value(tag: &str, attr: &str) -> Option<String> {
    let needle = format!("{}=", attr);
    let mut rest = tag;
    while let Some(i) = rest.find(&needle) {
        let before_ok = i == 0
            || !rest[..i]
                .chars()
                .next_back()
                .map(|c| c.is_alphanumeric() || c == '-' || c == '_')
                .unwrap_or(false);
        rest = &rest[i + needle.len()..];
        if !before_ok {
            continue;
        }
        match rest.chars().next() {
            Some(q @ '"') | Some(q @ '\'') => {
                let body = &rest[q.len_utf8()..];
                let end = body.find(q)?;
                return Some(body[..end].to_string());
            }
            _ => {
                let end = rest.find(|c: char| c.is_whitespace() || c == '>').unwrap_or(rest.len());
                return Some(rest[..end].to_string());
            }
        }
    }
    None
}

fn class_token(html: &str, class: &str) -> Option<String> {
    let needle = format!("class=\"{} ", class);
    let i = html.find(&needle)?;
    let rest = &html[i + needle.len()..];
    let end = rest.find('"')?;
    rest[..end].split_whitespace().next().map(str::to_string)
}

fn chapter_from_url(url: &str) -> Option<String> {
    let i = url.find("-chapter-")?;
    let rest = &url[i + 9..];
    let end = rest.find('/').unwrap_or(rest.len());
    let raw = &rest[..end];
    if raw.is_empty() || !raw.bytes().all(|b| b.is_ascii_digit() || b == b'-') {
        return None;
    }
    // URL desimal memakai strip: `120-5` == chapter 120.5.
    Some(raw.replace('-', "."))
}

fn chapter_f64(s: &str) -> f64 {
    s.trim().replace(',', ".").parse().unwrap_or(f64::NAN)
}

fn normalize_score(raw: &str) -> Option<String> {
    let v: f64 = raw.trim().replace(',', ".").parse().ok()?;
    if !(0.0..=10.0).contains(&v) || v == 0.0 {
        return None;
    }
    let rounded = (v * 10.0).round() / 10.0;
    let s = format!("{rounded}");
    Some(s.strip_suffix(".0").unwrap_or(&s).to_string())
}

/// Tanggal relatif Bahasa Indonesia dari halaman listing.
fn parse_relative_date(s: &str) -> Option<i64> {
    let t = s.trim().to_lowercase();
    if t.is_empty() {
        return None;
    }
    let now = SystemTime::now().duration_since(UNIX_EPOCH).ok()?.as_millis() as i64;
    if t.contains("baru saja") || t.contains("beberapa detik") {
        return Some(now);
    }
    let n: i64 = t
        .split_whitespace()
        .find_map(|w| w.parse().ok())?;
    let mult: i64 = if t.contains("detik") {
        1_000
    } else if t.contains("menit") {
        60_000
    } else if t.contains("jam") {
        3_600_000
    } else if t.contains("hari") {
        86_400_000
    } else if t.contains("minggu") {
        604_800_000
    } else if t.contains("bulan") {
        2_592_000_000
    } else if t.contains("tahun") {
        31_536_000_000
    } else {
        return None;
    };
    Some(now - n.saturating_mul(mult))
}

fn self_origin(url: &str) -> String {
    if let Some(k) = url.find("://") {
        let after = &url[k + 3..];
        return match after.find('/') {
            Some(s) => url[..k + 3 + s].to_string(),
            None => url.to_string(),
        };
    }
    url.to_string()
}

fn encode_and_join(base: &str, u: &str) -> String {
    encode_url(&join_url(base, u))
}

fn join_url(base: &str, u: &str) -> String {
    if u.starts_with("http://") || u.starts_with("https://") {
        return u.to_string();
    }
    if let Some(rest) = u.strip_prefix("//") {
        let scheme = base.split_once("://").map(|(s, _)| s).unwrap_or("https");
        return format!("{}://{}", scheme, rest);
    }
    if u.starts_with('/') {
        return format!("{}{}", self_origin(base), u);
    }
    format!("{}/{}", base.trim_end_matches('/'), u)
}

fn encode_url(u: &str) -> String {
    if let Some(k) = u.find("://") {
        let scheme_host = &u[..k];
        let rest = &u[k + 3..];
        let (auth, tail) = match rest.find('/') {
            Some(s) => (&rest[..s], &rest[s..]),
            None => (rest, ""),
        };
        let (path, query) = match tail.find('?') {
            Some(q) => (&tail[..q], &tail[q + 1..]),
            None => (tail, ""),
        };
        if query.is_empty() {
            format!("{}://{}{}", scheme_host, auth, encode_path(path))
        } else {
            let q = query
                .bytes()
                .map(|b| {
                    if b.is_ascii_alphanumeric()
                        || matches!(b, b'-'|b'.'|b'_'|b'~'|b'='|b'&'|b'%'|b'/')
                    {
                        (b as char).to_string()
                    } else {
                        format!("%{:02X}", b)
                    }
                })
                .collect::<String>();
            format!("{}://{}{}?{}", scheme_host, auth, encode_path(path), q)
        }
    } else {
        encode_path(u)
    }
}

fn encode_path(p: &str) -> String {
    let mut s = String::with_capacity(p.len());
    for &b in p.as_bytes() {
        if b.is_ascii_alphanumeric() || matches!(b, b'-'|b'.'|b'_'|b'~'|b'/'|b'%') {
            s.push(b as char);
        } else {
            s.push_str(&format!("%{:02X}", b));
        }
    }
    s
}

fn query_encode(s: &str) -> String {
    let mut out = String::new();
    for &b in s.as_bytes() {
        if b.is_ascii_alphanumeric() || matches!(b, b'-'|b'.'|b'_'|b'~') {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{:02X}", b));
        }
    }
    out
}

fn strip_html(s: &str) -> String {
    let mut out = String::new();
    let mut in_tag = false;
    for ch in s.chars() {
        match ch {
            '<' => in_tag = true,
            '>' => in_tag = false,
            _ if !in_tag => out.push(ch),
            _ => {}
        }
    }
    out.trim()
        .replace("&amp;", "&")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&#39;", "'")
        .replace("&quot;", "\"")
        .replace("&#8217;", "'")
        .replace("&#8216;", "'")
        .replace("&#8220;", "\"")
        .replace("&#8221;", "\"")
        .replace("&hellip;", "…")
        .replace("&nbsp;", " ")
        .trim()
        .to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn doh_ip_filter_menolak_semua_alamat_special_use() {
        let public = ["172.67.189.191", "104.21.49.106", "2606:4700:3030::6815:312a"];
        for s in public {
            assert!(is_public_doh_ip(s.parse().unwrap()), "{s} harus diterima");
        }
        let private = [
            "0.0.0.0",
            "127.0.0.1",
            "10.0.0.1",
            "192.168.1.1",
            "169.254.169.254",
            "100.64.0.1",
            "224.0.0.1",
            "240.0.0.1",
            "255.255.255.255",
            "::",
            "::1",
            "fd00::1",
            "fe80::1",
            "ff02::1",
            "::ffff:169.254.169.254",
            "::ffff:127.0.0.1",
        ];
        for s in private {
            assert!(!is_public_doh_ip(s.parse().unwrap()), "{s} harus ditolak");
        }
    }

    #[test]
    fn item_listing_dari_kartu_animposx() {
        let html = r#"
        <div class="animposx">
          <a href="https://komikindo.ch/komik/345461-overgeared/" title="Komik Overgeared">
            <div class="limit"><span class="typeflag Manhwa"></span>
              <img src="https://komikindo.ch/wp-content/uploads/2020/12/Komik-Overgeared-236x319.jpg" /></div>
          </a>
          <div class="bigors"><div class="tt"><h3>
            <a href="https://komikindo.ch/komik/345461-overgeared/" title="Komik Overgeared"> Overgeared </a>
          </h3></div></div>
          <div class="adds"><div class="rating"><i>8.58</i></div>
            <div class="lsch"><a href="https://komikindo.ch/overgeared-chapter-120-5/">Ch. 120.5</a>
            <span class="datech">2 hari yang lalu</span></div>
          </div>
        </div>"#;
        let items = parse_items(html, "https://komikindo.ch");
        assert_eq!(items.len(), 1);
        let m = &items[0];
        assert_eq!(m.native_id, "345461-overgeared");
        assert_eq!(m.title, "Overgeared");
        assert_eq!(m.rating.as_deref(), Some("8.6"));
        assert_eq!(m.manga_type.as_deref(), Some("Manhwa"));
        assert_eq!(m.last_chapter.as_deref(), Some("120.5"));
        assert!(m.updated_at.is_some());
        assert!(m.cover_url.as_ref().unwrap().contains("wp-content/uploads"));
    }

    #[test]
    fn genre_dari_checkbox_daftar_manga() {
        let html = r#"
        <li><input type="checkbox" id="genre-action" name="genre[]"
                    value="action" > <label for="genre-action" class="checkboxx">Action</label></li>
        <li><input type="checkbox" id="genre-adult" name="genre[]"
                    value="adult" > <label for="genre-adult" class="checkboxx">Adult</label></li>"#;
        assert_eq!(
            parse_genres(html),
            vec![("action".into(), "Action".into()), ("adult".into(), "Adult".into())]
        );
    }

    #[test]
    fn series_metadata_dan_chapter_terbaru_dulu() {
        let html = r#"
        <h1 class="entry-title" itemprop="name">Komik
              Black Killer Whale Baby            </h1>
        <div class="spe">
          <span><b>Status:</b>Berjalan</span>
          <span><b>Pengarang:</b>Moon Sihyun</span>
          <span><b>Jenis Komik:</b><a href="/manhwa/">Manhwa</a></span>
        </div>
        <div class="clearfix archiveanime-rating"><i itemprop="ratingValue">8.58</i></div>
        <li><span class="lchx"><a href="https://komikindo.ch/black-killer-whale-baby-chapter-131/">Chapter <chapter>131</chapter></a></span>
            <span class="dt"><a href='#'>7 bulan yang lalu</a></span></li>
        <li><span class="lchx"><a href="https://komikindo.ch/black-killer-whale-baby-chapter-120-5/">Chapter <chapter>120.5</chapter></a></span>
            <span class="dt"><a href='#'>1 tahun yang lalu</a></span></li>"#;
        let s = parse_series(html, "250907-black-killer-whale-baby", "https://komikindo.ch/komik/250907-black-killer-whale-baby/");
        assert_eq!(s.manga.title, "Black Killer Whale Baby");
        assert_eq!(s.manga.status.as_deref(), Some("Berjalan"));
        assert_eq!(s.manga.author.as_deref(), Some("Moon Sihyun"));
        assert_eq!(s.manga.manga_type.as_deref(), Some("Manhwa"));
        assert_eq!(s.manga.rating.as_deref(), Some("8.6"));
        assert_eq!(s.manga.last_chapter.as_deref(), Some("131"));
        assert_eq!(s.chapters.len(), 2);
        assert_eq!(s.chapters[0].number, "131");
        assert!(s.chapters[0].updated_at.is_some(), "chapter 131 updated_at harus terisi");
        assert_eq!(s.chapters[1].native_id, "120.5");
    }

    #[test]
    fn reader_buang_placeholder_blogger() {
        let html = r#"<div class="chapter-content">
          <img src="https://blogger.googleusercontent.com/img/b/R29/x.gif" />
          <img src="https://bukansiapasiapa.lol/media/42/chapter-131/abc_001.webp?mi_revision=1&amp;mi_delivery=1" />
          <img src="https://amatipolanyatirudesainnya.lol/media/42/chapter-131/abc_002.webp" />
        </div>"#;
        let imgs = parse_reader_images(html, "https://komikindo.ch");
        assert_eq!(imgs.len(), 2);
        assert!(imgs[0].contains("/media/42/chapter-131/abc_001.webp"));
        assert!(imgs[0].contains("mi_delivery=1"));
        assert!(imgs[1].contains("/media/42/chapter-131/abc_002.webp"));
    }

    #[test]
    fn skor_normalisasi() {
        assert_eq!(normalize_score("8.58").as_deref(), Some("8.6"));
        assert_eq!(normalize_score("7").as_deref(), Some("7"));
        assert_eq!(normalize_score("11"), None);
        assert_eq!(normalize_score("0"), None);
    }
}
