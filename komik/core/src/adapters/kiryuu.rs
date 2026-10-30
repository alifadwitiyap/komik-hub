//! Kiryuu adapter (kiryuu.to) — WordPress theme NatsuId.
//!
//! Alur (tiru semantics dari kiryuu.py, sesuaikan domain live):
//!   nonce   : GET  /wp-admin/admin-ajax.php?type=search_form&action=get_nonce
//!   search  : POST /wp-admin/admin-ajax.php?action=advanced_search  (form) -> HTML slug
//!   detail  : GET  /wp-json/wp/v2/manga?slug[]=...&per_page=N&_embed  (cover + wp:term)
//!   series  : GET  /manga/{slug}/  -> anchor /manga/{slug}/chapter-{number}.{opaque}/
//!   chapter : GET  chapter URL (dari `series`) -> main..section > img ; path WAJIB %20
//!   genre   : GET  /wp-json/wp/v2/genre?per_page=100&orderby=count&order=desc
//! Manga id = slug; chapter native_id = number desimal ("1.1", "210").
//!
//! DNS POISONING: *.kiryuu.to DNS-block di jaringan ID (Telkomsel redirect). Adapter
//! resolve host via Cloudflare DoH (dns-json) lalu pin IP ke reqwest
//! (`resolve_to_addrs`) supaya bypass resolver sistem. Tanpa ini adapter mati di
//! jaringan user. DoH hanya menyentuh host base (v7.kiryuu.to); host gambar
//! (yuucdn/jsdelivr) tidak terkena block jadi tetap via resolver normal.
//!
//! DEVIASI (terverifikasi live):
//!  - `chapter_pages` memakai `chapter.url` (URL asli ber-suffix dari `series`),
//!    BUKAN rekonstruksi `/manga/{slug}/chapter/{number}`. Bentuk polos tanpa
//!    suffix terbukti 404 (mis. chapter-179.6 -> 404) dan /chapter/{number}/
//!    hanya balas halaman manga generic tanpa gambar chapter. Manga.native_id
//!    (slug) + chapter.native_id (number) tetap identitas; url dipakai sbg
//!    sumber URL yang valid.
//!  - Parser HTML ditulis tangan (std, tanpa crate `regex`) karena scope mengunci
//!    hanya 2 file blok ini + tidak boleh menyentuh Cargo.toml (lane paralel).
//!    ponytail: kalau nanti `regex`/scraper jadi dep bersama, ganti helper
//!    *find/parse* di bawah dengan regex yang sudah teruji dari kiryuu.py.
use crate::model::*;
use crate::source::{classified, Source, SourceError, SourceResult};
use serde_json::Value;
use std::collections::HashSet;
use std::net::{IpAddr, SocketAddr};
use std::time::Duration;
use tokio::sync::{OnceCell, RwLock};

const UA: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 \
                  (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const DOH_ENDPOINT: &str = "https://cloudflare-dns.com/dns-query";

pub struct KiryuuSource {
    /// Client generik (dipakai untuk query DoH ke cloudflare; host lain resolve normal).
    shared: reqwest::Client,
    base: String,
    host: String,
    /// IP hasil DoH (cache per-sumber).
    ips: RwLock<Vec<IpAddr>>,
    /// Client ter-pin (resolve_to_addrs ke IP DoH) — dibangun sekali, lalu dipakai semua.
    pinned: OnceCell<reqwest::Client>,
    /// Nonce search (cache; di-refetch sekali kalau advanced_search balas kosong).
    nonce: RwLock<Option<String>>,
}

impl KiryuuSource {
    pub fn new(client: reqwest::Client) -> Self {
        let base = std::env::var("KIRYUU_BASE").unwrap_or_else(|_| "https://v7.kiryuu.to".into());
        let host = host_of(&base);
        KiryuuSource {
            shared: client,
            base: base.trim_end_matches('/').to_string(),
            host,
            ips: RwLock::new(Vec::new()),
            pinned: OnceCell::new(),
            nonce: RwLock::new(None),
        }
    }

    /// Client ter-pin DoH. Kalau DoH gagal, error bersih (tidak di-cache permanen —
    /// percobaan berikutnya resolve ulang).
    async fn http(&self) -> SourceResult<reqwest::Client> {
        self.pinned
            .get_or_try_init(|| async {
                let ips = self.resolve_ips().await?;
                // `SocketAddr::new` butuh 2 argumen, jadi closure di sini bukan
                // "redundant" — clippy menyarankan bentuk yang tidak valid di sini.
                #[allow(clippy::redundant_closure)]
                let addrs: Vec<SocketAddr> = ips.into_iter().map(|ip| SocketAddr::new(ip, 0)).collect();
                // reqwest 0.12: resolve_to_addrs(domain: &str, addrs: &[SocketAddr]).
                let dst = [format!("{}:443", self.host), format!("{}:80", self.host)];
                let mut b = reqwest::Client::builder().user_agent(UA);
                // Pin kedua port supaya aman kalau KIRYUU_BASE pakai http.
                for d in &dst {
                    b = b.resolve_to_addrs(d, &addrs);
                }
                b.build().map_err(Into::into)
            })
            .await
            .cloned()
    }

    /// Resolve host base via Cloudflare DoH -> A record. Cache hasil sukses.
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
            .map_err(|e| anyhow::anyhow!("DoH bukan JSON ({})", e))?;
        let mut ips = Vec::new();
        if let Some(ans) = v["Answer"].as_array() {
            for a in ans {
                if a["type"].as_u64() == Some(1) {
                    if let Some(d) = a["data"].as_str() {
                        if let Ok(ip) = d.parse::<IpAddr>() {
                            ips.push(ip);
                        }
                    }
                }
            }
        }
        if ips.is_empty() {
            anyhow::bail!("DoH tak kembalikan A record untuk {} (DNS poisoning + DoH gagal?)", self.host);
        }
        *self.ips.write().await = ips.clone();
        Ok(ips)
    }

    /// GET text dengan retry ringan (429/5xx + network), backoff eksponensial.
    async fn fetch_text(&self, url: &str) -> SourceResult<String> {
        let client = self.http().await?;
        let mut attempt = 0u32;
        loop {
            match client.get(url).send().await {
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

    async fn get_json(&self, url: &str) -> SourceResult<Value> {
        let client = self.http().await?;
        let resp = client
            .get(url)
            .send()
            .await
            .map_err(|e| anyhow::anyhow!("GET {} gagal: {}", url, e))?;
        if !resp.status().is_success() {
            anyhow::bail!("HTTP {} dari {}", resp.status().as_u16(), url);
        }
        let txt = resp
            .text()
            .await
            .map_err(|e| anyhow::anyhow!("baca {} gagal: {}", url, e))?;
        serde_json::from_str(&txt).map_err(|e| anyhow::anyhow!("{} bukan JSON: {}", url, e))
    }

    async fn get_nonce(&self) -> SourceResult<String> {
        if let Some(n) = self.nonce.read().await.clone() {
            return Ok(n);
        }
        let url = format!("{}/wp-admin/admin-ajax.php?type=search_form&action=get_nonce", self.base);
        let html = self.fetch_text(&url).await?;
        let n = find_nonce(&html).ok_or_else(|| {
            anyhow::anyhow!("search_nonce tidak ditemukan — struktur situs berubah?")
        })?;
        *self.nonce.write().await = Some(n.clone());
        Ok(n)
    }

    /// POST advanced_search -> slug manga (dedup, urut). Refetch nonce sekali bila kosong.
    async fn advanced_search(
        &self,
        page: u32,
        query: &str,
        orderby: &str,
        genre: Option<&str>,
    ) -> SourceResult<Vec<String>> {
        let genre_json = match genre {
            Some(g) => format!("[\"{}\"]", g.replace('"', "")),
            None => "[]".to_string(),
        };
        let page_str = page.to_string();
        let client = self.http().await?;
        let url = format!("{}/wp-admin/admin-ajax.php?action=advanced_search", self.base);
        let mut slugs_out: Vec<String> = Vec::new();
        for attempt in 0..2 {
            let nonce = self.get_nonce().await?;
            let form: Vec<(String, String)> = vec![
                ("nonce".into(), nonce),
                ("inclusion".into(), "OR".into()),
                ("exclusion".into(), "OR".into()),
                ("page".into(), page_str.clone()),
                ("genre".into(), genre_json.clone()),
                ("genre_exclude".into(), "[]".into()),
                ("author".into(), "[]".into()),
                ("artist".into(), "[]".into()),
                ("project".into(), "0".into()),
                ("type".into(), "[]".into()),
                ("status".into(), "[]".into()),
                ("order".into(), "desc".into()),
                ("orderby".into(), orderby.into()),
                ("query".into(), query.into()),
            ];
            let resp = client
                .post(&url)
                .form(&form)
                .send()
                .await
                .map_err(|e| anyhow::anyhow!("advanced_search gagal: {}", e))?;
            let html = resp
                .text()
                .await
                .map_err(|e| anyhow::anyhow!("baca advanced_search gagal: {}", e))?;
            slugs_out = extract_manga_slugs(&html);
            if !slugs_out.is_empty() {
                return Ok(slugs_out);
            }
            if attempt == 0 {
                // Nonce mungkin kedaluwarsa — refetch lalu coba sekali lagi.
                *self.nonce.write().await = None;
            }
        }
        Ok(slugs_out)
    }

    /// wp-json detail untuk sekumpulan slug, kembalikan manga sesuai urutan slug.
    async fn mangas_from_slugs(&self, slugs: &[String]) -> SourceResult<Vec<Manga>> {
        if slugs.is_empty() {
            return Ok(Vec::new());
        }
        let mut url = format!("{}/wp-json/wp/v2/manga?", self.base);
        for s in slugs {
            url.push_str("slug[]=");
            url.push_str(&query_encode(s));
            url.push('&');
        }
        url.push_str(&format!("per_page={}&_embed", slugs.len() + 1));
        let v = self.get_json(&url).await?;
        let arr = v
            .as_array()
            .ok_or_else(|| anyhow::anyhow!("respons wp-json bukan list manga (struktur berubah?)"))?;
        let mut map = std::collections::HashMap::new();
        for item in arr {
            if let Some(slug) = item["slug"].as_str() {
                map.insert(slug.to_string(), item);
            }
        }
        let mut out = Vec::new();
        for s in slugs {
            if let Some(item) = map.get(s) {
                out.push(self.map_manga(item));
            }
        }
        Ok(out)
    }

    async fn manga_by_slug(&self, slug: &str) -> SourceResult<Manga> {
        let list = self.mangas_from_slugs(&[slug.to_string()]).await?;
        // wp-json bisa mengabaikan slug[] dan balas manga lain — tolak kalau slug tak match.
        list.into_iter()
            .next()
            .ok_or_else(|| classified(SourceError::Missing, format!("manga '{slug}' tidak ditemukan")))
    }

    fn map_manga(&self, v: &Value) -> Manga {
        let slug = v["slug"].as_str().unwrap_or("").to_string();
        let title = strip_html(v["title"]["rendered"].as_str().unwrap_or(""));
        let mut m = Manga::new(SourceId::from("kiryuu"), slug.clone(), &title);
        if let Some(u) = v["_embedded"]["wp:featuredmedia"]
            .as_array()
            .and_then(|a| a.first())
            .and_then(|x| x["source_url"].as_str())
        {
            m.cover_url = Some(u.to_string());
        }
        let author = term_names(v, "series-author").join(", ");
        let status = term_names(v, "status").join(", ");
        let typ = term_names(v, "type").join(", ");
        m.author = (!author.is_empty()).then_some(author);
        m.status = (!status.is_empty()).then_some(status);
        m.manga_type = (!typ.is_empty()).then_some(typ);
        m.rating = normalize_score(meta_str(v, "score"));
        m.url = Some(
            v["link"]
                .as_str()
                .map(str::to_string)
                .unwrap_or_else(|| format!("{}/manga/{}/", self.base, slug)),
        );
        m
    }

    async fn search_page(
        &self,
        page: u32,
        query: &str,
        orderby: &str,
        genre: Option<&str>,
    ) -> SourceResult<Vec<Manga>> {
        let slugs = self.advanced_search(page, query, orderby, genre).await?;
        self.mangas_from_slugs(&slugs).await
    }

    /// Parse chapter list dari HTML halaman /manga/{slug}/ (anchor chapter-...).
    /// Hasil SELALU terbaru-dulu: halaman menaruh link "mulai dari chapter 1"
    /// di DEPAN daftar desc (terverifikasi live: urutan API
    /// `['1','214','213',...,'2']`), jadi tanpa sort prev/next salah — chapter 1
    /// dapat tombol "Chapter terbaru" tanpa next, ch214 nawari next ke ch1.
    fn parse_chapters(&self, html: &str) -> Vec<Chapter> {
        let mut seen = HashSet::new();
        let mut out = Vec::new();
        for href in href_values(html) {
            if let Some(cpos) = href.find("/chapter") {
                let after = &href[cpos + "/chapter".len()..];
                let seg = if let Some(s) = after.strip_prefix('-') {
                    s
                } else if let Some(s) = after.strip_prefix('/') {
                    s
                } else {
                    continue;
                };
                let seg = seg.trim_end_matches('/');
                let seg = seg.split(['#', '?']).next().unwrap_or(seg);
                if seg.is_empty() {
                    continue;
                }
                let number = strip_opaque_suffix(seg);
                if number.is_empty() || !seen.insert(number.clone()) {
                    continue;
                }
                out.push(Chapter {
                    source: self.id(),
                    native_id: number.clone(),
                    title: format!("Chapter {}", number),
                    number,
                    updated_at: None,
                    url: Some(href),
                });
            }
        }
        // terbaru dulu: numerik desc, jatuh ke string desc (pola sama seperti
        // sort SeriesUnified di web — Number() lalu localeCompare).
        out.sort_by(|a, b| {
            let (na, nb) = (chapter_f64(&a.number), chapter_f64(&b.number));
            if na.is_finite() && nb.is_finite() && na != nb {
                nb.total_cmp(&na)
            } else {
                b.number.cmp(&a.number)
            }
        });
        out
    }
}

#[async_trait::async_trait]
impl Source for KiryuuSource {
    fn id(&self) -> SourceId {
        SourceId::from("kiryuu")
    }

    async fn popular(&self, page: u32) -> SourceResult<Vec<Manga>> {
        self.search_page(page, "", "popular", None).await
    }

    async fn latest(&self, page: u32) -> SourceResult<Vec<Manga>> {
        self.search_page(page, "", "updated", None).await
    }

    async fn search(&self, query: &str, page: u32) -> SourceResult<Vec<Manga>> {
        self.search_page(page, query, "popular", None).await
    }

    /// Cari judul + filter genre: `search_page` SUDAH punya parameter genre
    /// (DT: kiryuu butuh SLUG, mis. "action" — sama seperti `list()`).
    async fn search_in_genre(
        &self,
        query: &str,
        page: u32,
        genre: Option<&str>,
    ) -> SourceResult<Vec<Manga>> {
        self.search_page(page, query, "popular", genre).await
    }

    async fn list(&self, genre: Option<&str>, page: u32) -> SourceResult<Vec<Manga>> {
        // genre = SLUG (mis. "action"); beda dari shinigami yang terima query bebas.
        self.search_page(page, "", "popular", genre).await
    }

    async fn genres(&self) -> SourceResult<Vec<(String, String)>> {
        let url = format!(
            "{}/wp-json/wp/v2/genre?per_page=100&page=1&orderby=count&order=desc",
            self.base
        );
        let v = self.get_json(&url).await?;
        let arr = v
            .as_array()
            .ok_or_else(|| anyhow::anyhow!("respons bukan list genre"))?;
        Ok(arr
            .iter()
            .filter_map(|it| {
                let slug = it["slug"].as_str()?;
                let name = it["name"].as_str().unwrap_or(slug);
                if !super::is_genre(slug, name) {
                    return None;
                }
                Some((slug.to_string(), name.to_string()))
            })
            .collect())
    }

    async fn series(&self, native_id: &str) -> SourceResult<SeriesDetail> {
        // wp-json (metadata) dan halaman manga (daftar chapter) tidak saling
        // bergantung — keduanya hanya butuh slug. Diukur: sekuensial 1.95 s,
        // paralel 1.20 s (hemat 0.75 s, hotspot terbesar dari 4 sumber).
        let url = format!("{}/manga/{}/", self.base, native_id);
        let (manga, html) = tokio::try_join!(self.manga_by_slug(native_id), self.fetch_text(&url))?;
        let chapters = self.parse_chapters(&html);
        Ok(SeriesDetail { manga, chapters })
    }

    async fn chapter_pages(&self, manga: &Manga, chapter: &Chapter) -> SourceResult<ChapterPages> {
        // Pakai chapter.url (URL asli ber-suffix, satu-satunya yang valid).
        // Fallback ke bentuk polos hanya jika url tak di-set — terbukti kurang andal.
        let url = chapter
            .url
            .clone()
            .unwrap_or_else(|| format!("{}/manga/{}/chapter-{}/", self.base, manga.native_id, chapter.native_id));
        let html = self.fetch_text(&url).await?;
        let images = extract_images(&html, &url);
        if images.is_empty() {
            anyhow::bail!("chapter {} tak punya gambar (selector berubah? url={})", chapter.number, url);
        }
        Ok(ChapterPages {
            source: self.id(),
            title: chapter.title.clone(),
            number: chapter.number.clone(),
            images,
        })
    }
}

// ---------------------------------------------------------------------------
// Parser HTML (std, tanpa regex). Semua potongan hanya di delimiter ASCII
// (<main, </main>, <section, </section>, <img, '>', href=, src=) sehingga aman
// untuk UTF-8.
// ---------------------------------------------------------------------------

/// Host dari base URL ("https://v7.kiryuu.to" -> "v7.kiryuu.to").
fn host_of(base: &str) -> String {
    let after = base.split_once("://").map(|(_, h)| h).unwrap_or(base);
    after.split(['/', ':']).next().unwrap_or(after).to_string()
}

/// Semua nilai atribut href=... (kutip tunggal/ganda).
fn href_values(html: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut rest = html;
    while let Some(i) = rest.find("href=") {
        rest = &rest[i + "href=".len()..];
        match rest.chars().next() {
            Some(q @ '"') | Some(q @ '\'') => {
                let body = &rest[q.len_utf8()..];
                if let Some(end) = body.find(q) {
                    // trim: situs kadang emits href=" https://..." (spasi di dalam kutip).
                    out.push(body[..end].trim().to_string());
                    rest = &body[end..];
                } else {
                    break;
                }
            }
            _ => {}
        }
    }
    out
}

/// Slug manga unik dari HTML advanced_search (href .../manga/{slug}/").
fn extract_manga_slugs(html: &str) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for h in href_values(html) {
        if let Some(pos) = h.find("/manga/") {
            let rest = &h[pos + "/manga/".len()..];
            let seg = rest.split('/').next().unwrap_or("");
            // hanya link manga langsung (satu segmen; buang link chapter dsb)
            if !seg.is_empty() && rest.trim_end_matches('/') == seg && !out.iter().any(|s| s == seg) {
                out.push(seg.to_string());
            }
        }
    }
    out
}

/// value nonce dari HTML get_nonce: name=...search_nonce... value='...' / "...".
fn find_nonce(html: &str) -> Option<String> {
    let idx = html.find("search_nonce")?;
    let tail = &html[idx..];
    let vpos = tail.find("value=")?;
    let after = &tail[vpos + "value=".len()..];
    let q = after.chars().next()?;
    if q != '"' && q != '\'' {
        return None;
    }
    let body = &after[q.len_utf8()..];
    let end = body.find(q)?;
    Some(body[..end].to_string())
}

/// Nama-nama term untuk satu taxonomy dari _embedded."wp:term".
fn term_names(v: &Value, taxonomy: &str) -> Vec<String> {
    let mut out = Vec::new();
    if let Some(groups) = v["_embedded"]["wp:term"].as_array() {
        for grp in groups {
            if let Some(items) = grp.as_array() {
                if items.first().and_then(|t| t["taxonomy"].as_str()) == Some(taxonomy) {
                    out = items
                        .iter()
                        .filter_map(|t| t["name"].as_str().map(str::to_string))
                        .collect();
                    break;
                }
            }
        }
    }
    out
}

/// Nilai metadata.meta.{key} sebagai string (str atau angka).
fn meta_str(v: &Value, key: &str) -> Option<String> {
    let m = &v["metadata"]["meta"][key];
    if let Some(s) = m.as_str() {
        return Some(s.to_string());
    }
    if let Some(n) = m.as_i64() {
        return Some(n.to_string());
    }
    if let Some(n) = m.as_u64() {
        return Some(n.to_string());
    }
    if let Some(f) = m.as_f64() {
        return Some(f.to_string());
    }
    None
}

/// Nomor chapter -> f64 untuk sorting. Terima desimal titik MAUPUN koma
/// ("179,6" yang muncul di sebagian entri) dan buang spasi. Non-numerik -> NaN
/// supaya pemanggil jatuh ke perbandingan string.
fn chapter_f64(s: &str) -> f64 {
    let t = s.trim().replace(',', ".");
    t.parse().unwrap_or(f64::NAN)
}

/// Skor kiryuu -> skala 0-10, maksimal 1 desimal (konsisten dengan komiku
/// "8.5", shinigami "9.4", mangaku "10.0"). Sumber memang sudah 0-10 — sampling
/// 3775 entri `metadata.meta.score` live (2026-10-15) hanya menghasilkan 0.0..
/// 9.75, tak ada yang >10 — jadi yang perlu dibetulkan format & sampahnya:
/// desimal 2 ("8.45"), koma desimal ("8,4", "7,00"), dan string bukan angka
/// ("?"/"t"/judul) yang selama ini tampil apa adanya sebagai "★ ?".
/// Skor 0 / di luar 0..=10 / non-numerik -> None (rating memang best-effort;
/// "0" = belum ada rating di situs ini). DENGAN sengaja tak "bagi 10 kalau
/// lebih dari 10" — di skala situs (bestRating 10) nilai di atas 10 lebih mungkin sampah
/// daripada skor 0-100, dan menyembunyikannya lebih aman daripada menampilkan
/// angka karang.
fn normalize_score(raw: Option<String>) -> Option<String> {
    let raw = raw?;
    let t = raw.trim().replace(',', ".");
    if t.is_empty() {
        return None;
    }
    let v: f64 = t.parse().ok()?;
    if !v.is_finite() || v <= 0.0 || v > 10.0 {
        return None;
    }
    // 7.00 -> "7"; 8.45 -> "8.5"; 10 -> "10"
    let rounded = (v * 10.0).round() / 10.0;
    if rounded.fract() == 0.0 {
        Some(format!("{}", rounded as i64))
    } else {
        Some(format!("{rounded:.1}"))
    }
}

/// "179.6.425255" -> "179.6" ; "179.337987" -> "179" (buang suffix opak angka di akhir).
fn strip_opaque_suffix(seg: &str) -> String {
    if let Some(dot) = seg.rfind('.') {
        let (head, tail) = seg.split_at(dot);
        let tail = &tail[1..];
        if !head.is_empty() && !tail.is_empty() && tail.bytes().all(|b| b.is_ascii_digit()) {
            return head.to_string();
        }
    }
    seg.to_string()
}

/// URL gambar reader dari halaman chapter: <main> ... <section> > <img src|data-src>.
/// Fallback: semua <img> di main kecuali logo. Path di-%20-encode (spasi umum di sini).
fn extract_images(html: &str, base_url: &str) -> Vec<String> {
    let block = match html.find("<main") {
        Some(i) => {
            let rest = &html[i..];
            match rest.find("</main>") {
                Some(j) => &rest[..j],
                None => rest,
            }
        }
        None => html,
    };
    let mut imgs = Vec::new();
    // section > img
    let mut idx = 0;
    while let Some(si) = block[idx..].find("<section") {
        let start = idx + si;
        let Some(gt) = block[start..].find('>') else { break };
        let content_start = start + gt + 1;
        match block[content_start..].find("</section>") {
            Some(rel) => {
                collect_imgs(&block[content_start..content_start + rel], base_url, &mut imgs);
                idx = content_start + rel + "</section>".len();
            }
            None => {
                collect_imgs(&block[content_start..], base_url, &mut imgs);
                break;
            }
        }
    }
    if imgs.is_empty() {
        collect_imgs(block, base_url, &mut imgs);
    }
    imgs
}

fn collect_imgs(chunk: &str, base_url: &str, out: &mut Vec<String>) {
    let mut idx = 0;
    while let Some(ti) = chunk[idx..].find("<img") {
        let start = idx + ti;
        let gt = chunk[start..].find('>').map(|g| start + g + 1).unwrap_or(chunk.len());
        let tag = &chunk[start..gt.min(chunk.len())];
        // pilih data-src dulu (lazy-load) lalu src; ambil satu per <img>.
        let raw = attr_value(tag, "data-src").or_else(|| attr_value(tag, "src"));
        if let Some(u) = raw {
            let low = u.to_ascii_lowercase();
            if !(low.contains("custom-logo") || low.ends_with("logo") || low.contains("/logo")) {
                let full = encode_and_join(base_url, &u);
                if !out.contains(&full) {
                    out.push(full);
                }
            }
        }
        idx = gt.max(idx + 1).min(chunk.len());
    }
}

/// Nilai atribut tunggal (mis. "src") dari satu tag.
fn attr_value(tag: &str, attr: &str) -> Option<String> {
    let needle = format!("{}=", attr);
    let mut rest = tag;
    while let Some(i) = rest.find(&needle) {
        // pastikan bukan substring dari atribut lain (mis. data-src saat cari src)
        let before_ok = i == 0 || !rest[..i].chars().next_back().map(|c| c.is_alphanumeric() || c == '-' || c == '_').unwrap_or(false);
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
                // atribut tanpa kutip: sampai whitespace/> 
                let end = body_until_ws(rest);
                return Some(rest[..end].to_string());
            }
        }
    }
    None
}

fn body_until_ws(s: &str) -> usize {
    s.find(|c: char| c.is_whitespace() || c == '>').unwrap_or(s.len())
}

/// Gabung relatif ke absolut + percent-encode path (spasi dll).
fn encode_and_join(base_url: &str, u: &str) -> String {
    encode_url(&join_url(base_url, u))
}

fn join_url(base: &str, u: &str) -> String {
    if u.starts_with("http://") || u.starts_with("https://") {
        return u.to_string();
    }
    let origin = url_origin(base);
    if let Some(rest) = u.strip_prefix("//") {
        let scheme = base.split_once("://").map(|(s, _)| s).unwrap_or("https");
        return format!("{}://{}", scheme, rest);
    }
    if u.starts_with('/') {
        // u sudah membawa leading slash; origin tanpa trailing slash.
        return format!("{}{}", origin, u);
    }
    let dir = base.rsplit_once('/').map(|(d, _)| d).unwrap_or(base);
    format!("{}/{}", dir, u)
}

fn url_origin(base: &str) -> String {
    if let Some(k) = base.find("://") {
        let after = &base[k + 3..];
        return match after.find('/') {
            Some(s) => base[..k + 3 + s].to_string(),
            None => base.to_string(),
        };
    }
    base.to_string()
}

/// Percent-encode path (aman: unreserved + '/' + '%'); query dibiarkan
/// (query sendiri tak mengandung spasi pada endpoint yang dipakai).
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
                    if b.is_ascii_alphanumeric() || matches!(b, b'-'|b'.'|b'_'|b'~'|b'='|b'&'|b'%'|b'/') {
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

/// Encode nilai query (unreserved; sisanya %XX). Untuk slug[].
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

/// Buang tag HTML + decode sedikit entitas umum.
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
    let t = out.trim();
    let t = t
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
        .replace("&nbsp;", " ");
    t.trim().to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn nonce_both_quotes() {
        assert_eq!(
            find_nonce("<input name='search_nonce' value='abc123'>").as_deref(),
            Some("abc123")
        );
        assert_eq!(
            find_nonce("<input name=\"search_nonce\" value=\"zz9\">").as_deref(),
            Some("zz9")
        );
        assert_eq!(find_nonce("no nonce here"), None);
    }

    #[test]
    fn slugs_dedup_and_skip_chapter_links() {
        let html = r#"<a href="https://v7.kiryuu.to/manga/solo-leveling/"></a>
                      <a href="https://v7.kiryuu.to/manga/solo-leveling/"></a>
                      <a href="https://v7.kiryuu.to/manga/solo-leveling/chapter-1.2/"></a>
                      <a href='https://v7.kiryuu.to/manga/nano-machine/'></a>"#;
        assert_eq!(extract_manga_slugs(html), vec!["solo-leveling", "nano-machine"]);
    }

    #[test]
    fn opaque_suffix_stripped() {
        assert_eq!(strip_opaque_suffix("179.6.425255"), "179.6");
        assert_eq!(strip_opaque_suffix("179.337987"), "179");
        assert_eq!(strip_opaque_suffix("210"), "210");
        assert_eq!(strip_opaque_suffix("1.1.9999"), "1.1");
    }

    #[test]
    fn chapter_order_desc() {
        // halaman nyata taruh link "chapter 1" (tombol mulai) DI DEPAN daftar
        // desc: ['1','214','213',...,'2'] — tanpa sort, ch1 jadi chapter
        // terbaru dan prev/next rusak. Harus jadi desc dengan '1' di akhir.
        // URL asli selalu ber-suffix opak ("chapter-210.5.425255"), jadi fixture
        // memakai bentuk yang sama; angka opak itu memang dibuang parser.
        let html = r#"<a href="https://v7.kiryuu.to/manga/solo-necromancer/chapter-1/">1</a>
                      <a href="https://v7.kiryuu.to/manga/solo-necromancer/chapter-214.981273/">214</a>
                      <a href="https://v7.kiryuu.to/manga/solo-necromancer/chapter-213.425255/">213</a>
                      <a href="https://v7.kiryuu.to/manga/solo-necromancer/chapter-210.5.119876/">210.5</a>
                      <a href="https://v7.kiryuu.to/manga/solo-necromancer/chapter-2.45.771234/">2.45</a>
                      <a href="https://v7.kiryuu.to/manga/solo-necromancer/chapter-2.337987/">2</a>
                      <a href="https://v7.kiryuu.to/manga/solo-necromancer/chapter-1.9999/">1</a>"#;
        let src = KiryuuSource::new(reqwest::Client::new());
        let nums: Vec<String> = src.parse_chapters(html).into_iter().map(|c| c.number).collect();
        assert_eq!(
            nums,
            vec!["214", "213", "210.5", "2.45", "2", "1"],
            "chapter harus terbaru-dulu dan '1' di akhir"
        );
        assert_eq!(nums.last().map(String::as_str), Some("1"));
    }

    #[test]
    fn chapter_order_desc_non_numeric_fallback() {
        // nomor non-numerik tetap urut string desc (bukan lagi urutan HTML)
        let html = r#"<a href="/manga/x/chapter-alpha.9/">a</a>
                      <a href="/manga/x/chapter-gamma.9/">g</a>
                      <a href="/manga/x/chapter-beta.9/">b</a>"#;
        let src = KiryuuSource::new(reqwest::Client::new());
        let nums: Vec<String> = src.parse_chapters(html).into_iter().map(|c| c.number).collect();
        assert_eq!(nums, vec!["gamma", "beta", "alpha"]);
    }

    #[test]
    fn score_normalisasi_0_10() {
        let sc = |s: Option<&str>| normalize_score(s.map(str::to_string));
        // basis: data langganan 0-10 numerik, dibulatkan maksimal 1 desimal
        assert_eq!(sc(Some("8")).as_deref(), Some("8"));
        assert_eq!(sc(Some("8.0")).as_deref(), Some("8"));
        assert_eq!(sc(Some("9.75")).as_deref(), Some("9.8"));
        assert_eq!(sc(Some("8.23")).as_deref(), Some("8.2"));
        assert_eq!(sc(Some("7.45")).as_deref(), Some("7.5"));
        assert_eq!(sc(Some("10")).as_deref(), Some("10"));
        // koma sebagai desimal + trailing zero
        assert_eq!(sc(Some("8,4")).as_deref(), Some("8.4"));
        assert_eq!(sc(Some("7,00")).as_deref(), Some("7"));
        // sampah / kosong / di luar 0..=10 -> None (jangan render sebagai skor)
        assert_eq!(sc(Some("t")), None);
        assert_eq!(sc(Some("?")), None);
        assert_eq!(sc(Some("Baka Deka Imōto ga Yatte Kuru!")), None);
        assert_eq!(sc(Some("7..00")), None);
        assert_eq!(sc(Some("")), None);
        assert_eq!(sc(Some("0")), None);
        assert_eq!(sc(Some("11")), None);
        assert_eq!(sc(None), None);
    }

    #[test]
    fn map_manga_score_normal() {
        // metadata.meta.score "8.45" -> rating "8.5"; tanpa/rusak -> None
        let v = serde_json::json!({
            "slug": "solo-necromancer",
            "title": {"rendered": "Solo Necromancer"},
            "metadata": {"meta": {"score": "8.45"}}
        });
        let src = KiryuuSource::new(reqwest::Client::new());
        let m = src.map_manga(&v);
        assert_eq!(m.rating.as_deref(), Some("8.5"));
        let v2 = serde_json::json!({"slug": "x", "title": {"rendered": "X"},
                                    "metadata": {"meta": {"score": "?"}}});
        assert_eq!(src.map_manga(&v2).rating, None);
        let v3 = serde_json::json!({"slug": "y", "title": {"rendered": "Y"}});
        assert_eq!(src.map_manga(&v3).rating, None);
    }

    #[test]
    fn image_extraction_encodes_spaces() {
        let html = r#"<main><div><section><img data-src="https://v2.yuucdn.net/wp-content/uploads/S/Solo Leveling/Chapter 179/000.jpg"><img src="https://v2.yuucdn.net/x/y z.png"></section></div></main>"#;
        let imgs = extract_images(html, "https://v7.kiryuu.to/manga/solo-leveling/chapter-179/");
        assert_eq!(imgs.len(), 2);
        assert!(imgs[0].contains("Solo%20Leveling") && imgs[0].contains("Chapter%20179"));
        assert!(imgs[1].contains("y%20z.png"));
    }

    #[test]
    fn image_extraction_drops_logo() {
        let html = r#"<main><section><img src="https://v7.kiryuu.to/wp-content/uploads/logo.png"><img data-src="/uploads/a b.jpg"></section></main>"#;
        let imgs = extract_images(html, "https://v7.kiryuu.to/manga/x/chapter-1.5.9/");
        assert_eq!(imgs, vec!["https://v7.kiryuu.to/uploads/a%20b.jpg".to_string()]);
    }
}
