//! Aggregator: fan-out ke 4 sumber secara paralel, dedup exact-normalized-title,
//! rank recency global, laporan partial failure, dan fallback chain
//! series/read. Tidak bicara HTTP langsung — hanya lewat trait `Source`.
//!
//! Aturan (dari plan `unified-komik-cli.md`):
//! - popular/latest/search/list: fan-out paralel (timeout per sumber
//!   `PER_SOURCE_TIMEOUT_SECS`), dedup by `title_key`, pemenang = entri dengan
//!   `updated_at` terbaru, tiebreak `SOURCE_PRIORITY`
//!   (komiku > mangaku > shinigami > kiryuu). Output di-rank recency desc,
//!   `None` di bawah. Sumber yang gagal dikumpulkan di `failures`; hasil sukses
//!   tetap dikembalikan. Hasil yang ada kegagalan TIDAK di-cache.
//! - series/read: BUKAN fan-out. Handle `sumber:id` (atau judul) menentukan
//!   sumber primary; kalau gagal, coba sumber lain menurut prioritas sampai
//!   satu berhasil. Kalau pindah sumber, chapter di-resolve by number.
//! - Cache: tier memory (default) + tier disk CLI; dimatikan oleh
//!   `Aggregator::without_cache()` (`--no-cache`).
use crate::cache::Cache;
use crate::model::*;
use crate::source::{Source, SourceError, SourceResult, PER_SOURCE_TIMEOUT_SECS};
use crate::union::cmp_chapter_number;
use serde::{Deserialize, Deserializer, Serialize, Serializer};
use std::collections::{HashMap, HashSet};
use std::sync::Arc;
use std::time::Duration;

// -------------------------------------------------------------------- serde
// model.rs sengaja tipis (tanpa serde) dan di luar scope lane ini, jadi impl
// Serialize/Deserialize dipasang di sini lewat pola `remote`.
#[derive(Serialize, Deserialize)]
#[serde(remote = "Manga")]
struct MangaDef {
    source: SourceId,
    native_id: String,
    title: String,
    title_key: String,
    cover_url: Option<String>,
    author: Option<String>,
    status: Option<String>,
    manga_type: Option<String>,
    rating: Option<String>,
    last_chapter: Option<String>,
    updated_at: Option<i64>,
    url: Option<String>,
}

#[derive(Serialize, Deserialize)]
#[serde(remote = "Chapter")]
struct ChapterDef {
    source: SourceId,
    native_id: String,
    title: String,
    number: String,
    updated_at: Option<i64>,
    url: Option<String>,
}

impl Serialize for Manga {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        MangaDef::serialize(self, s)
    }
}
impl<'de> Deserialize<'de> for Manga {
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        MangaDef::deserialize(d)
    }
}

impl Serialize for Chapter {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        ChapterDef::serialize(self, s)
    }
}
impl<'de> Deserialize<'de> for Chapter {
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        ChapterDef::deserialize(d)
    }
}
impl Serialize for SeriesDetail {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        use serde::ser::SerializeStruct;
        let mut st = s.serialize_struct("SeriesDetail", 2)?;
        st.serialize_field("manga", &self.manga)?;
        st.serialize_field("chapters", &self.chapters)?;
        st.end()
    }
}

impl<'de> Deserialize<'de> for SeriesDetail {
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        #[derive(Deserialize)]
        struct Raw {
            manga: Manga,
            chapters: Vec<Chapter>,
        }
        let raw = Raw::deserialize(d)?;
        Ok(SeriesDetail {
            manga: raw.manga,
            chapters: raw.chapters,
        })
    }
}

impl Serialize for ChapterPages {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        use serde::ser::SerializeStruct;
        let mut st = s.serialize_struct("ChapterPages", 4)?;
        st.serialize_field("source", &self.source)?;
        st.serialize_field("title", &self.title)?;
        st.serialize_field("number", &self.number)?;
        st.serialize_field("images", &self.images)?;
        st.end()
    }
}

impl<'de> Deserialize<'de> for ChapterPages {
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        #[derive(Deserialize)]
        struct Raw {
            source: SourceId,
            title: String,
            number: String,
            images: Vec<String>,
        }
        let raw = Raw::deserialize(d)?;
        Ok(ChapterPages {
            source: raw.source,
            title: raw.title,
            number: raw.number,
            images: raw.images,
        })
    }
}

// ------------------------------------------------------------------- Merged

/// Hasil merge lintas sumber + catatan sumber yang gagal.
#[derive(Debug, Clone)]
pub struct Merged<T> {
    pub items: Vec<T>,
    /// (sumber, pesan error) untuk sumber yang error / timeout.
    pub failures: Vec<(SourceId, String)>,
    pub sources_total: usize,
    pub sources_ok: usize,
    /// True kalau hasil dilayani dari cache (memory atau disk).
    pub from_cache: bool,
}

impl<T> Merged<T> {
    /// Semua sumber gagal — beda dari "hasil kosong".
    pub fn all_failed(&self) -> bool {
        self.sources_total > 0 && self.sources_ok == 0
    }

    /// Baris peringatan stderr: "⚠ n/m sumber gagal: a: err; b: err".
    pub fn warning(&self) -> Option<String> {
        if self.failures.is_empty() {
            return None;
        }
        Some(format!(
            "⚠ {}/{} sumber gagal: {}",
            self.failures.len(),
            self.sources_total,
            self.failures
                .iter()
                .map(|(s, e)| format!("{}: {e}", s.as_str()))
                .collect::<Vec<_>>()
                .join("; ")
        ))
    }

    pub fn truncate(mut self, limit: u32) -> Self {
        if limit > 0 {
            self.items.truncate(limit as usize);
        }
        self
    }
}

/// Detail series (+ status cache).
#[derive(Debug, Clone)]
pub struct SeriesOutcome {
    pub detail: SeriesDetail,
    pub from_cache: bool,
}

/// Gambar chapter (+ status cache).
#[derive(Debug, Clone)]
pub struct ReadOutcome {
    pub pages: ChapterPages,
    pub from_cache: bool,
}

/// Series + daftar chapter hasil UNION lintas sumber.
///
/// Sumber primary = sumber yang handle-nya (atau fallback `series_resolve_pref`).
/// Sumber lain diisi dari `collect_series_across_sources` (judul sama).
/// Union pakai `merge_chapter_lists`; primary DILETAKKAN lebih dulu supaya
/// chapter miliknya menang dedup.
///
/// `failed` = sumber yang gagal saat pengumpulan (partial failure tolerated).
#[derive(Debug, Clone)]
pub struct MergedSeries {
    pub manga: Manga,
    pub chapters: Vec<crate::union::MergedChapter>,
    pub failed: Vec<(SourceId, String)>,
    /// True kalau detail primary dilayani dari cache aggregator.
    pub from_cache: bool,
    /// Sumber representatif = sumber yang punya chapter numerik utama terbesar
    /// (tie-break `SOURCE_PRIORITY`). None kalau tak ada chapter numerik.
    pub representative_source: Option<SourceId>,
}

/// Referensi chapter tetangga untuk navigasi reader. Membawa sumber + handle
/// manga di sumber itu, supaya client bisa lanjut baca lintas sumber tanpa
/// perlu tahu sumber asal: kirim balik `handle` + `number` ke
/// [`Aggregator::read_chapter_any`].
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ChapterRef {
    /// Nomor tampilan mentah (mis. "179.6" / "extra") — kirim balik apa adanya.
    pub number: String,
    /// Sumber yang melayani chapter ini (bukan sumber primary).
    pub source: SourceId,
    /// Handle manga di sumber itu: "{source}:{native_id}".
    pub handle: String,
}

/// Hasil [`Aggregator::read_chapter_any`]: gambar + navigasi + jejak pindah
/// sumber.
///
/// `prev`/`next` SELALU berasal dari daftar chapter sumber yang benar-benar
/// melayani (bukan sumber primary). Daftar chapter terbaru-dulu (kontrak
/// trait `Source`), jadi `prev` = lebih tua (index+1) dan `next` = lebih baru
/// (index-1) — konvensi sama dengan endpoint chapter server yang sudah ada.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ReadOutcomeX {
    pub pages: ChapterPages,
    /// Nomor lebih kecil / lebih tua; `None` kalau sudah di tepi bawah.
    pub prev: Option<ChapterRef>,
    /// Nomor lebih besar / lebih baru; `None` kalau sudah di tepi atas.
    pub next: Option<ChapterRef>,
    /// Sumber primary yang diminta, kalau gambar dilayani sumber lain.
    pub switched_from: Option<SourceId>,
    /// Catatan 1 baris untuk UI (badge + catatan kecil); `None` kalau tidak pindah.
    pub note: Option<String>,
    /// `title_key` SERIES pemilik chapter (bukan judul chapter). Diisi dari
    /// `manga` yang SUDAH dimuat saat resolve — supaya pemanggil tidak perlu
    /// `series_resolve` terpisah hanya untuk metadata ini (itu satu round-trip
    /// upstream penuh di jalur panas baca chapter).
    #[serde(default)]
    pub series_title_key: Option<String>,
    /// Judul series pemilik chapter (untuk breadcrumb reader). Sumber sama
    /// seperti `series_title_key`.
    #[serde(default)]
    pub series_title: Option<String>,
}

/// Minimum chapter yang dimuat per sumber saat membaca: `read_chapter_any`
/// menaikkan `limit` ke angka ini supaya tetangga prev/next tidak terpotong
/// (adapter memang mengunduh daftar penuh, jadi ini hanya memotong di memori).
const READ_CHAPTERS_MIN: u32 = 50;

/// Hasil mencoba memuat series dari SATU sumber.
enum SeriesLoad {
    /// (manga, detail) — sumber terakses dan punya series-nya.
    Ok(Manga, SeriesDetail),
    /// Sumber terakses dan menyatakan "tidak ada" (resolve miss / 404).
    Miss,
    /// Sumber tidak bisa diakses (jaringan/429/timeout/parse).
    Inaccessible(SourceError),
}

/// Alasan sumber primary tidak melayani chapter — hanya untuk menyusun
/// catatan pindah sumber (`note`), BUKAN klasifikasi kegagalan.
enum PrimaryMiss {
    /// Primary terakses tapi chapter/series-nya tidak ada.
    Missing,
    /// Primary melayani tapi gambarnya kosong.
    Empty,
    /// Primary tidak bisa diakses.
    Inaccessible(SourceError),
}

/// Baris genre union: slug, nama tampil, daftar sumber yang punya.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct GenreRow {
    pub slug: String,
    pub name: String,
    pub sources: Vec<String>,
}

/// Alias tipe client HTTP. Dipakai CLI untuk menamai tipe tanpa menambahkan
/// `reqwest` sebagai dependency langsung `cli` (Cargo.toml cli sengaja lean —
/// core yang pegang HTTP).
pub type HttpClient = reqwest::Client;

/// Client default untuk adapter + unduhan gambar CLI (UA eksplisit).
pub fn http_client() -> HttpClient {
    reqwest::Client::builder()
        .user_agent("komik-cli/0.1")
        .build()
        .unwrap_or_else(|_| reqwest::Client::new())
}

// --------------------------------------------------------------- Aggregator

pub struct Aggregator {
    pub sources: Vec<Arc<dyn Source>>,
    cache: Option<Cache>,
    timeout: Duration,
}

impl Aggregator {
    pub fn new(sources: Vec<Arc<dyn Source>>) -> Self {
        Aggregator {
            sources,
            cache: Some(Cache::memory(crate::cache::DEFAULT_TTL)),
            timeout: Duration::from_secs(PER_SOURCE_TIMEOUT_SECS),
        }
    }

    pub fn with_cache(sources: Vec<Arc<dyn Source>>, cache: Cache) -> Self {
        Aggregator {
            sources,
            cache: Some(cache),
            timeout: Duration::from_secs(PER_SOURCE_TIMEOUT_SECS),
        }
    }

    /// Matikan caching (`--no-cache`).
    pub fn without_cache(mut self) -> Self {
        self.cache = None;
        self
    }

    pub fn with_timeout(mut self, timeout: Duration) -> Self {
        self.timeout = timeout;
        self
    }

    pub fn cache(&self) -> Option<&Cache> {
        self.cache.as_ref()
    }

    /// Sumber yang dipakai; `--source` mempersempit ke satu sumber.
    pub fn filtered(&self, source: Option<&str>) -> Vec<Arc<dyn Source>> {
        match source {
            None => self.sources.clone(),
            Some(s) => self
                .sources
                .iter()
                .filter(|src| src.id().as_str() == s)
                .cloned()
                .collect(),
        }
    }

    pub fn known_sources(&self) -> Vec<String> {
        self.sources.iter().map(|s| s.id().to_string()).collect()
    }

    // ---------------------------------------------------------- merged list

    pub async fn popular(&self, page: u32, limit: u32, source: Option<&str>) -> Merged<Manga> {
        self.merged(&format!("popular:{page}"), false, source, move |src| async move {
            src.popular(page).await
        })
        .await
        .truncate(limit)
    }

    pub async fn latest(&self, page: u32, limit: u32, source: Option<&str>) -> Merged<Manga> {
        let key = format!("latest:{page}");
        let full_key = self.cache_key("list", source, &format!("ceil:{key}"));

        let sources = self.filtered(source);
        let total = sources.len();
        if let Some(cache) = &self.cache {
            if let Some(hit) = cache.fresh_json::<Vec<Manga>>(&full_key) {
                return Merged {
                    items: hit,
                    failures: vec![],
                    sources_total: total,
                    sources_ok: total,
                    from_cache: true,
                };
            }
        }

        let mut items: Vec<Manga> = Vec::new();
        let mut failures = Vec::new();
        let mut ok = 0usize;
        for res in self
            .join_sources(sources, move |src| async move { src.latest(page).await })
            .await
        {
            match res {
                Ok((_, v)) => {
                    ok += 1;
                    items.extend(v);
                }
                Err(f) => failures.push(f),
            }
        }

        let resolved = self.resolve_latest_feed(items).await;
        let merged = Merged {
            items: resolved,
            failures,
            sources_total: total,
            sources_ok: ok,
            from_cache: false,
        };
        if merged.failures.is_empty() {
            self.cache_put(&full_key, &merged.items);
        }
        merged.truncate(limit)
    }

    /// Rekalkulasi feed ceiling (`latest`) + resolusi tie: saat beberapa sumber
    /// mengiklankan chapter tertinggi yang SAMA, validasi ke daftar chapter
    /// asli tiap kandidat dan pilih sumber yang BENERAN punya chapter itu
    /// (bukan asal prioritas). Gagal/tak ada yang mengonfirmasi -> fallback
    /// prioritas.
    async fn resolve_latest_feed(&self, items: Vec<Manga>) -> Vec<Manga> {
        let mut order: Vec<String> = Vec::new();
        let mut by_key: HashMap<String, Vec<Manga>> = HashMap::new();
        for m in items {
            let k = m.rank_canonical_key();
            if !by_key.contains_key(&k) {
                order.push(k.clone());
            }
            by_key.entry(k).or_default().push(m);
        }

        let mut out = Vec::with_capacity(order.len());
        for k in order {
            let group = by_key.remove(&k).unwrap();
            out.push(self.pick_ceiling_winner_validated(group).await);
        }
        out.sort_by(|a, b| rank_cmp(a, b));
        out
    }

    /// `pick_ceiling_winner` + validasi tie (lihat [`resolve_latest_feed`]).
    /// Hasil validasi tie di-memoize per (kunci kanonik series, nomor ceiling)
    /// supaya grup tie yang berulang tidak re-fetch series resolve.
    async fn pick_ceiling_winner_validated(&self, group: Vec<Manga>) -> Manga {
        let numeric: Vec<usize> = group
            .iter()
            .enumerate()
            .filter(|(_, x)| x.rank_last_chapter().map(is_numeric_chapter).unwrap_or(false))
            .map(|(i, _)| i)
            .collect();

        let winner_idx = if numeric.is_empty() {
            group
                .iter()
                .enumerate()
                .reduce(|acc, cur| {
                    if rank_cmp(acc.1, cur.1) == std::cmp::Ordering::Less {
                        acc
                    } else {
                        cur
                    }
                })
                .map(|(i, _)| i)
                .unwrap_or(0)
        } else {
            let max_idx = numeric.iter().copied().reduce(|best, cur| {
                let lb = group[best].rank_last_chapter().unwrap();
                let lc = group[cur].rank_last_chapter().unwrap();
                match cmp_chapter_number(lb, lc) {
                    std::cmp::Ordering::Greater => best,
                    std::cmp::Ordering::Less => cur,
                    std::cmp::Ordering::Equal => best,
                }
            }).unwrap();
            let max_num = group[max_idx].rank_last_chapter().unwrap().to_string();

            let tied: Vec<usize> = numeric.iter().copied().filter(|&i| {
                chapter_number_key(group[i].rank_last_chapter().unwrap()) == chapter_number_key(&max_num)
            }).collect();

            if tied.len() <= 1 {
                tied[0]
            } else {
                let cache_key = (title_canonical_key(&group[0].title), max_num.clone());
                // Cek memoize dulu: kalau pernah diputuskan, jangan re-fetch.
                let cached_handle = {
                    let g = tie_validation_cache().lock().unwrap();
                    g.get(&cache_key).cloned()
                };
                if let Some(h) = cached_handle {
                    if let Some(i) = tied.iter().copied().find(|&i| group[i].handle() == h) {
                        i
                    } else {
                        tied.into_iter().reduce(|best, cur| {
                            let pb = source_priority(group[best].rank_source());
                            let pc = source_priority(group[cur].rank_source());
                            if pb <= pc { best } else { cur }
                        }).unwrap()
                    }
                } else {
                    let mut chosen: Option<usize> = None;
                    for &i in &tied {
                        let handle = group[i].handle();
                        if let Ok(outcome) = self.series_resolve(&handle, 2000, None).await {
                            if outcome.detail.chapters.iter().any(|c| {
                                chapter_number_key(&c.number) == chapter_number_key(&max_num)
                            }) {
                                chosen = Some(i);
                                break;
                            }
                        }
                    }
                    let winner_idx = chosen.unwrap_or_else(|| {
                        tied.into_iter().reduce(|best, cur| {
                            let pb = source_priority(group[best].rank_source());
                            let pc = source_priority(group[cur].rank_source());
                            if pb <= pc { best } else { cur }
                        }).unwrap()
                    });
                    tie_validation_cache().lock().unwrap().insert(cache_key, group[winner_idx].handle());
                    winner_idx
                }
            }
        };

        let mut winner = group[winner_idx].clone();
        for (i, other) in group.iter().enumerate() {
            if i != winner_idx {
                winner.merge_from(other);
            }
        }
        winner
    }

    pub async fn search(
        &self,
        query: &str,
        page: u32,
        limit: u32,
        source: Option<&str>,
    ) -> Merged<Manga> {
        let q = query.to_string();
        let merged = self
            .merged(&format!("search:{page}:{q}"), false, source, move |src| {
                let q = q.clone();
                async move { src.search(&q, page).await }
            })
            .await;
        let mut items = merged.items;
        // Ceiling: kartu search menunjuk sumber dengan episode TERBESAR —
        // `last_chapter` tiap kartu = max numerik lintas sumber sekunci kanonik.
        apply_ceiling_last_chapter(&mut items);
        Merged { items: rank_by_query(items, query), ..merged }.truncate(limit)
    }

    /// Seperti [`Aggregator::search`], tapi `genre` diteruskan ke SETIAP
    /// adapter lewat [`Source::search_in_genre`] supaya filternya menyaring
    /// sungguhan (bukan cuma penanda ketersediaan). Adapter yang upstream-nya
    /// tidak mendukung memakai default trait (genre diabaikan → hasil lebih
    /// luas); itu batas jujur yang didokumentasikan di trait.
    ///
    /// Kunci cache TERPISAH dari `search` karena isinya berbeda.
    pub async fn search_in_genre(
        &self,
        query: &str,
        genre: &str,
        page: u32,
        limit: u32,
        source: Option<&str>,
    ) -> Merged<Manga> {
        let q = query.to_string();
        let g = genre.to_string();
        let merged = self
            .merged(
                &format!("search-genre:{page}:{q}:{g}"),
                false,
                source,
                move |src| {
                    let q = q.clone();
                    let g = g.clone();
                    async move { src.search_in_genre(&q, page, Some(&g)).await }
                },
            )
            .await;
        // Rank relevansi kueri sama seperti `search` (deterministik, cache aman).
        let mut items = merged.items;
        apply_ceiling_last_chapter(&mut items);
        Merged { items: rank_by_query(items, query), ..merged }.truncate(limit)
    }

    /// Katalog + filter genre (slug/nama diteruskan ke sumber apa adanya).
    pub async fn list(
        &self,
        genre: Option<&str>,
        page: u32,
        limit: u32,
        source: Option<&str>,
    ) -> Merged<Manga> {
        let g = genre.map(|s| s.to_string());
        self.merged(
            &format!("list:{page}:{}", genre.unwrap_or("*")),
            false,
            source,
            move |src| {
                let g = g.clone();
                async move { src.list(g.as_deref(), page).await }
            },
        )
        .await
        .truncate(limit)
    }

    /// Union genre semua sumber: (slug, nama, [sumber]).
    pub async fn genres(&self, source: Option<&str>) -> Merged<GenreRow> {
        let sources = self.filtered(source);
        let total = sources.len();
        let key = self.cache_key("genres", source, "");
        if let Some(cache) = &self.cache {
            if let Some(hit) = cache.fresh_json::<Vec<GenreRow>>(&key) {
                return Merged {
                    items: hit,
                    failures: vec![],
                    sources_total: total,
                    sources_ok: total,
                    from_cache: true,
                };
            }
        }

        let mut rows: Vec<GenreRow> = Vec::new();
        let mut failures = Vec::new();
        let mut ok = 0usize;
        for res in self
            .join_sources(sources, |src| async move { src.genres().await })
            .await
        {
            match res {
                Ok((src, list)) => {
                    ok += 1;
                    let sid = src.id().to_string();
                    for (slug, name) in list {
                        match rows.iter_mut().find(|r| r.slug.eq_ignore_ascii_case(&slug)) {
                            Some(r) => {
                                if r.name.is_empty() && !name.is_empty() {
                                    r.name = name;
                                }
                                r.sources.push(sid.clone());
                            }
                            None => rows.push(GenreRow {
                                slug,
                                name,
                                sources: vec![sid.clone()],
                            }),
                        }
                    }
                }
                Err(f) => failures.push(f),
            }
        }
        for r in &mut rows {
            r.sources = unique_sources(&r.sources);
        }

        let merged = Merged {
            items: rows,
            failures,
            sources_total: total,
            sources_ok: ok,
            from_cache: false,
        };
        if merged.failures.is_empty() {
            self.cache_put(&key, &merged.items);
        }
        merged
    }

    /// Fan-out generik: paralel + timeout per sumber + dedup + rank + cache.
    async fn merged<T, F, Fut>(
        &self,
        key: &str,
        ceiling_dedup: bool,
        source: Option<&str>,
        call: F,
    ) -> Merged<T>
    where
        T: Rankable + Serialize + for<'de> Deserialize<'de> + Clone + Send + 'static,
        F: Fn(Arc<dyn Source>) -> Fut + Clone + Send + Sync + 'static,
        Fut: std::future::Future<Output = SourceResult<Vec<T>>> + Send + 'static,
    {
        let sources = self.filtered(source);
        let total = sources.len();
        let list_key = if ceiling_dedup {
            format!("ceil:{key}")
        } else {
            key.to_string()
        };
        let full_key = self.cache_key("list", source, &list_key);
        if let Some(cache) = &self.cache {
            if let Some(hit) = cache.fresh_json::<Vec<T>>(&full_key) {
                return Merged {
                    items: hit,
                    failures: vec![],
                    sources_total: total,
                    sources_ok: total,
                    from_cache: true,
                };
            }
        }

        let mut items: Vec<T> = Vec::new();
        let mut failures = Vec::new();
        let mut ok = 0usize;
        for res in self.join_sources(sources, call).await {
            match res {
                Ok((_, v)) => {
                    ok += 1;
                    items.extend(v);
                }
                Err(f) => failures.push(f),
            }
        }

        let merged = Merged {
            items: if ceiling_dedup {
                dedup_rank_ceiling(items)
            } else {
                dedup_rank(items)
            },
            failures,
            sources_total: total,
            sources_ok: ok,
            from_cache: false,
        };
        if merged.failures.is_empty() {
            self.cache_put(&full_key, &merged.items);
        }
        merged
    }

    // -------------------------------------------------------- series/read

    /// Detail series dari `sumber:native-id` ATAU judul polos.
    pub async fn series_resolve(
        &self,
        id: &str,
        limit: u32,
        source: Option<&str>,
    ) -> anyhow::Result<SeriesOutcome> {
        self.series_resolve_pref(id, limit, source, None).await
    }

    /// Sama seperti [`Aggregator::series_resolve`], tapi `last_source` —
    /// sumber TERAKHIR yang dibaca client — dicoba LEBIH DULU, sebelum
    /// sumber dari handle dan sebelum urutan `SOURCE_PRIORITY` (sticky
    /// source, keputusan Q4/8: halaman series kirim sumber-terakhir-dibaca).
    ///
    /// Efek: kalau client terakhir membaca dari `kiryuu`, buka lagi series
    /// yang judulnya identik TIDAK melempar balik ke `komiku` hanya karena
    /// prioritas. Kalau `last_source` kosong / tak dikenal / gagal, perilaku
    /// identik `series_resolve` (fallback normal). Sticky tetap patuh filter
    /// `--source`; sumber dari handle tidak (perilaku fase 1 lama).
    pub async fn series_resolve_pref(
        &self,
        id: &str,
        limit: u32,
        source: Option<&str>,
        last_source: Option<&str>,
    ) -> anyhow::Result<SeriesOutcome> {
        let (sid, native) = parse_handle(id);
        let key = self.cache_key(
            "series",
            source,
            &match last_source {
                Some(l) => format!("{id}:{native}:last={l}"),
                None => format!("{id}:{native}"),
            },
        );
        if let Some(cache) = &self.cache {
            if let Some(hit) = cache.fresh_json::<SeriesDetail>(&key) {
                return Ok(SeriesOutcome { detail: hit, from_cache: true });
            }
        }

        // Urutan percobaan: sticky -> handle eksplisit -> sisa menurut prioritas.
        let mut order: Vec<Arc<dyn Source>> = Vec::new();
        if let Some(last) = last_source {
            if let Some(src) = self
                .filtered(source)
                .into_iter()
                .find(|s| s.id().as_str() == last)
            {
                push_unique(&mut order, src);
            }
        }
        if let Some(primary_id) = sid.clone() {
            if let Some(src) = self.sources.iter().find(|s| s.id() == primary_id) {
                push_unique(&mut order, src.clone());
            }
        }
        for src in self.filtered(source) {
            push_unique(&mut order, src);
        }

        // Judul asli untuk resolve lintas-sumber: muat series dari sumber
        // handle dulu (sekali). Slug/id handle ("solo-leveling", "1308")
        // BUKAN judul — mencari sebagai judul sering meleset, sehingga sticky
        // tak jatuh ke sumber yang diminta. Detail primary dipakai ulang saat
        // loop sampai ke sumber handle supaya tak dobel request.
        //
        // FAILOVER: kalau primary mati total, judul tidak didapat dari sana.
        // Pakai judul yang PERNAH diingat untuk handle ini (remember_title);
        // tanpa itu, resolve-by-title memakai native_id ("1160") yang tidak
        // pernah cocok di sumber lain.
        let mut primary_detail: Option<(Manga, SeriesDetail)> = None;
        // FAILOVER: judul yang pernah diingat untuk handle ini (kalau ada),
        // dipakai kalau primary mati dan judul tidak didapat dari sana.
        let remembered_title = self.recall_title(id).map(|(t, _)| t);
        if sid.is_some() && order.len() > 1 {
            if let Some(primary_src) =
                self.sources.iter().find(|s| Some(&s.id()) == sid.as_ref())
            {
                if let SeriesLoad::Ok(manga, detail) =
                    self.load_series(primary_src, &native, limit as usize).await
                {
                    // Simpan mapping handle -> judul PERMANEN (TTL panjang).
                    //
                    // Kenapa: saat sumber primary MATI TOTAL (bukan sekadar
                    // chapter hilang), judul series tidak diketahui — handle
                    // hanya berisi native_id ("komiku:1160"), dan kode sendiri
                    // mencatat "slug/id BUKAN judul". Akibatnya failover ke
                    // sumber lain mustahil: resolve-by-title memakai "1160"
                    // yang tidak pernah cocok.
                    //
                    // Dengan menyimpan judul saat pertama kali berhasil
                    // dibuka, kunjungan berikutnya tetap bisa failover walau
                    // primary mati.
                    self.remember_title(id, &manga.title, &manga.title_key);
                    primary_detail = Some((manga, detail));
                }
            }
        }
        // Kumpulkan kegagalan SEMUA sumber, bukan hanya yang terakhir.
        // Versi lama menyimpan `last_err` saja sehingga kegagalan sumber
        // pertama (mis. komiku timeout TLS) tertimpa oleh "kiryuu: tidak ada"
        // dan pesan akhirnya menuduh sumber yang salah.
        let mut errs: Vec<String> = Vec::new();
        for src in &order {
            // Sumber dari handle: `series(native_id)` langsung. Selain itu
            // (sticky / prioritas): resolve judul dulu, pola fase 2 lama.
            let loaded = if sid.as_ref() == Some(&src.id()) {
                match primary_detail.take() {
                    Some(pair) => SeriesLoad::Ok(pair.0, pair.1),
                    None => self.load_series(src, &native, limit as usize).await,
                }
            } else {
                // FAILOVER: kalau primary mati, `primary_detail` kosong dan
                // judul tidak tersedia. Pakai judul yang diingat (kalau ada)
                // demi bisa resolve di sumber lain.
                let title = remembered_title
                    .clone()
                    .or_else(|| primary_detail.as_ref().map(|(m, _)| m.title.clone()))
                    .unwrap_or_else(|| native.clone());
                self.load_series_by_title(src, &title, limit as usize).await
            };
            match loaded {
                SeriesLoad::Ok(_, mut detail) => {
                    detail.chapters.truncate(limit as usize);
                    self.cache_put(&key, &detail);
                    return Ok(SeriesOutcome { detail, from_cache: false });
                }
                SeriesLoad::Miss => errs.push(format!("{}: tidak ada", src.id())),
                SeriesLoad::Inaccessible(k) => errs.push(format!("{}: {k}", src.id())),
            }
        }

        anyhow::bail!(
            "gagal ambil series {id}{}",
            if errs.is_empty() {
                String::new()
            } else {
                format!(" ({})", errs.join("; "))
            }
        )
    }

    /// Series + daftar chapter hasil UNION lintas sumber.
    ///
    /// Primary = [`Aggregator::series_resolve_pref`] (sticky source + fallback
    /// dipertahankan apa adanya). Sumber lain diambil lewat
    /// [`Aggregator::collect_series_across_sources`] dengan judul manga
    /// primary (exact `title_key`); primary TIDAK diminta ulang.
    ///
    /// Union pakai [`crate::union::merge_chapter_lists`] dengan daftar primary
    /// di urutan PERTAMA, jadi chapter primary menang dedup ("09" == "9").
    /// Episode eksklusif sumber lain tetap ikut.
    ///
    /// Kegagalan sumber lain ditoleransi: sumbernya masuk `failed`, chapter
    /// primary tetap dikembalikan.
    pub async fn series_merged(
        &self,
        id: &str,
        limit: u32,
        source: Option<&str>,
        last_source: Option<&str>,
    ) -> anyhow::Result<MergedSeries> {
        let outcome = self.series_resolve_pref(id, limit, source, last_source).await?;
        let detail = outcome.detail;
        let manga = detail.manga.clone();

        // Primary = sumber pelayan; handle kanonik "sumber:native_id".
        let primary = crate::union::SourceChapterList {
            source: manga.source.clone(),
            handle: manga.handle(),
            chapters: detail.chapters,
        };

        // Sumber lain: judul sama (exact `title_key`); primary dilewati.
        let (others, failed) = self
            .collect_series_across_sources(&manga.title, Some(&manga.source), limit)
            .await;

        let mut lists = Vec::with_capacity(others.len() + 1);
        lists.push(primary);
        lists.extend(others);

        let representative_source = crate::union::pick_representative_source(&lists);
        let merged_chapters = crate::union::merge_chapter_lists(&lists);

        // Ceiling: metadata seri menunjuk sumber dengan episode TERBESAR —
        // `last_chapter` = chapter numerik terbesar lintas sumber (bukan
        // advertised primary). Cover/judul sama seri, tak perlu repoint source.
        let mut manga = manga;
        if let Some(hi) = merged_chapters
            .iter()
            .map(|c| c.number.as_str())
            .max_by(|a, b| crate::union::cmp_chapter_number(a, b))
        {
            manga.last_chapter = Some(hi.to_string());
        }

        Ok(MergedSeries {
            manga,
            chapters: merged_chapters,
            failed,
            from_cache: outcome.from_cache,
            representative_source,
        })
    }

    /// Fallback chain untuk series yang manganya sudah diketahui.
    pub async fn series_with_fallback(
        &self,
        manga: &Manga,
        limit: u32,
        source: Option<&str>,
    ) -> anyhow::Result<SeriesOutcome> {
        let mut last_err: Option<String> = None;
        for src in self.fallback_order(Some(manga.source.clone()), source) {
            match tokio::time::timeout(self.timeout, src.series(&manga.native_id)).await {
                Ok(Ok(mut detail)) => {
                    detail.chapters.truncate(limit as usize);
                    return Ok(SeriesOutcome { detail, from_cache: false });
                }
                Ok(Err(e)) => last_err = Some(format!("{e:#}")),
                Err(_) => last_err = Some(format!("timeout {}s", self.timeout.as_secs())),
            }
        }
        for src in self.filtered(source) {
            if let Ok(Ok(Some(m))) = tokio::time::timeout(self.timeout, src.resolve(&manga.title)).await
            {
                if let Ok(Ok(mut detail)) =
                    tokio::time::timeout(self.timeout, src.series(&m.native_id)).await
                {
                    detail.chapters.truncate(limit as usize);
                    return Ok(SeriesOutcome { detail, from_cache: false });
                }
            }
        }
        anyhow::bail!(
            "gagal ambil series {}{}",
            manga.handle(),
            last_err.map(|e| format!(" ({e})")).unwrap_or_default()
        )
    }

    /// Gambar chapter: sumber primary dulu, lalu fallback chain. Kalau pindah
    /// sumber, chapter di-cari ulang by number dari series sumber baru.
    pub async fn chapter_pages_with_fallback(
        &self,
        manga: &Manga,
        chapter: &Chapter,
        source: Option<&str>,
    ) -> anyhow::Result<ReadOutcome> {
        let mut last_err: Option<String> = None;
        for src in self.fallback_order(Some(manga.source.clone()), source) {
            match tokio::time::timeout(self.timeout, src.chapter_pages(manga, chapter)).await {
                Ok(Ok(pages)) if !pages.images.is_empty() => {
                    return Ok(ReadOutcome { pages, from_cache: false })
                }
                Ok(Ok(_)) => last_err = Some("daftar gambar kosong".into()),
                Ok(Err(e)) => last_err = Some(format!("{e:#}")),
                Err(_) => last_err = Some(format!("timeout {}s", self.timeout.as_secs())),
            }
        }
        for src in self.filtered(source) {
            if let Ok(Ok(Some(m))) = tokio::time::timeout(self.timeout, src.resolve(&manga.title)).await
            {
                if let Ok(Ok(detail)) =
                    tokio::time::timeout(self.timeout, src.series(&m.native_id)).await
                {
                    if let Some(ch) = chapter_by_number(&detail, &chapter.number) {
                        if let Ok(Ok(pages)) =
                            tokio::time::timeout(self.timeout, src.chapter_pages(&m, &ch)).await
                        {
                            if !pages.images.is_empty() {
                                return Ok(ReadOutcome { pages, from_cache: false });
                            }
                        }
                    }
                }
            }
        }
        anyhow::bail!(
            "gagal ambil halaman chapter {}{}",
            chapter.number,
            last_err.map(|e| format!(" ({e})")).unwrap_or_default()
        )
    }

    /// Baca chapter LINTAS SUMBER dengan fallback transparan — resolver tunggal
    /// untuk reader, maraton, dan lanjut-baca (keputusan 6).
    ///
    /// Alur:
    /// 1. Resolve series: `sumber:id` dari handle = primary; kalau `id` judul
    ///    polos, urut `SOURCE_PRIORITY`.
    /// 2. Cari chapter di primary pakai kunci kanonik STRING
    ///    ([`chapter_number_key`]: "179.60" == "179.6", "extra" != "7").
    ///    KETEMU -> `chapter_pages` -> selesai, `switched_from: None`.
    /// 3. TIDAK ketemu (atau gambarnya kosong — keputusan 1) -> sumber lain
    ///    urut prioritas: resolve by JUDUL (exact `title_key`), ambil series,
    ///    cari chapter. Pertama yang punya menang; `switched_from` + `note`
    ///    diisi, dan `prev`/`next` mengikuti sumber PELAYAN itu.
    /// 4. Semua request sumber dibungkus timeout [`PER_SOURCE_TIMEOUT_SECS`].
    ///
    /// Kegagalan (A4): kalau semua sumber TIDAK BISA DIAKSES, pesannya
    /// "gagal memuat chapter ... (semua sumber gagal diakses)" — BUKAN
    /// "tidak ditemukan". "Tidak ditemukan" hanya kalau semua sumber
    /// terakses dan benar-benar tidak punya chapter-nya.
    ///
    /// `limit` = batas chapter yang dimuat per sumber (dinaikkan minimum
    /// [`READ_CHAPTERS_MIN`] supaya tetangga prev/next tidak terpotong).
    pub async fn read_chapter_any(
        &self,
        id: &str,
        number: &str,
        source: Option<&str>,
        limit: u32,
    ) -> anyhow::Result<ReadOutcomeX> {
        let want = chapter_number_key(number);
        let cap = limit.max(READ_CHAPTERS_MIN) as usize;
        let (handle_sid, native) = parse_handle(id);
        // Cache hasil baca: daftar gambar chapter itu immutable sekali terbit,
        // jadi pembacaan ulang (termasuk navigasi next/prev yang berulang)
        // tidak perlu fetch ulang. TTL DEFAULT_TTL (10 menit).
        let read_key = format!("chapter-read:{id}:{want}");
        if let Some(cache) = &self.cache {
            if let Some(hit) = cache.fresh_json::<ReadOutcomeX>(&read_key) {
                return Ok(hit);
            }
        }

        let candidates = self.fallback_order(handle_sid.clone(), source);
        if candidates.is_empty() {
            anyhow::bail!(
                "tidak ada sumber yang cocok untuk {id}{}",
                source
                    .map(|s| format!(" (filter --source {s})"))
                    .unwrap_or_default()
            );
        }
        // Primary efektif = sumber pertama yang benar-benar dicoba (kalau
        // `--source` mempersempit daftar, sumber dari handle belum tentu ada).
        let primary = candidates[0].id();

        // Judul untuk resolve lintas sumber: dari series pertama yang kebetulan
        // termuat; kalau primary tak bisa diakses, native id dipakai sebagai
        // tebakan judul (slug) — sama seperti fase 2 `series_resolve`.
        //
        // FAILOVER: kalau primary mati, judul tidak didapat dari sana. Pakai
        // judul yang PERNAH diingat (remember_title) supaya resolve-by-title
        // di sumber lain memakai judul asli, bukan native_id ("1160").
        let mut title_hint: Option<String> = self.recall_title(id).map(|(t, _)| t);
        let mut primary_miss: Option<PrimaryMiss> = None;
        // Sumber yang gagal DIAKSES (bukan "tidak ada") — untuk pesan akhir.
        let mut inaccessible: Vec<(SourceId, SourceError)> = Vec::new();

        for (idx, src) in candidates.iter().enumerate() {
            let sid = src.id();
            // Penanda negatif masih segar -> lewati sumber ini tanpa request.
            if self.neg_hit(&self.neg_chapter_key(id, &sid, &want))
                || self.neg_hit(&self.neg_series_key(id, &sid))
            {
                if idx == 0 {
                    primary_miss = Some(PrimaryMiss::Missing);
                }
                continue;
            }

            let title = title_hint.clone().unwrap_or_else(|| native.clone());
            let loaded = if handle_sid.as_ref() == Some(&sid) {
                self.load_series(src, &native, cap).await
            } else {
                self.load_series_by_title(src, &title, cap).await
            };
            let (manga, detail) = match loaded {
                SeriesLoad::Ok(manga, detail) => (manga, detail),
                SeriesLoad::Miss => {
                    if idx == 0 {
                        primary_miss = Some(PrimaryMiss::Missing);
                    }
                    continue;
                }
                SeriesLoad::Inaccessible(kind) => {
                    inaccessible.push((sid, kind.clone()));
                    if idx == 0 {
                        primary_miss = Some(PrimaryMiss::Inaccessible(kind));
                    }
                    continue;
                }
            };
            if title_hint.is_none() {
                title_hint = Some(manga.title.clone());
            }

            // Series kosong: penanda negatif pendek, lanjut sumber berikutnya.
            if detail.chapters.is_empty() {
                self.neg_put(&self.neg_series_key(id, &sid));
                if idx == 0 {
                    primary_miss = Some(PrimaryMiss::Missing);
                }
                continue;
            }
            let Some(pos) = chapter_index_by_key(&detail, number) else {
                // Sumber TERAKSES dan chapter memang tidak ada — kesimpulan
                // pasti, boleh di-cache sebentar (A5).
                self.neg_put(&self.neg_chapter_key(id, &sid, &want));
                if idx == 0 {
                    primary_miss = Some(PrimaryMiss::Missing);
                }
                continue;
            };
            let chapter = detail.chapters[pos].clone();

            match tokio::time::timeout(self.timeout, src.chapter_pages(&manga, &chapter)).await {
                Ok(Ok(pages)) if !pages.images.is_empty() => {
                    let (mut prev, mut next) = neighbor_refs(&detail, pos);
                    // Tepi sumber pelayan -> cari tetangga di sumber lain yang
                    // punya series dengan judul sama. Sumber pelayan tetap
                    // menang selama punya tetangga (regresi).
                    //
                    // Syarat:
                    // - Pemanggil TIDAK mempersempit sumber (`--source`):
                    //   dengan filter, navigasi harus tetap di sumber yang
                    //   diminta.
                    // - Daftar chapter sumber pelayan punya konteks urutan
                    //   (>1 chapter). Daftar 1 chapter = sumber tak memberi
                    //   tahu itu tepi atas atau tepi bawah, jadi tak ada
                    //   tebakan tetangga lintas sumber.
                    if (prev.is_none() || next.is_none())
                        && source.is_none()
                        && detail.chapters.len() > 1
                    {
                        let (lists, _failed) = self
                            .collect_series_across_sources(
                                &manga.title,
                                Some(&sid),
                                CROSS_SOURCE_CHAPTER_LIMIT,
                            )
                            .await;
                        let (cross_prev, cross_next) =
                            pick_cross_source_neighbors(&lists, &chapter.number);
                        if next.is_none() {
                            next = cross_next;
                        }
                        // `prev` hanya boleh lintas sumber kalau daftar
                        // sumber pelayan TIDAK terpotong: `cap` memotong dari
                        // yang paling tua (daftar terbaru-dulu), jadi tepi
                        // bawah bisa jadi artefak pemotongan — sumber pelayan
                        // mungkin punya chapter lebih tua yang kita buang.
                        // Tanpa guard, prev bisa melompati chapter yang
                        // sebenarnya milik sumber pelayan.
                        if prev.is_none() && detail.chapters.len() < cap {
                            prev = cross_prev;
                        }
                    }
                    let switched_from = (sid != primary).then(|| primary.clone());
                    let note = switched_from.as_ref().map(|p| match &primary_miss {
                        Some(PrimaryMiss::Empty) => {
                            format!("chapter {number} tanpa gambar di {p} — dibaca dari {sid}")
                        }
                        Some(PrimaryMiss::Inaccessible(kind)) => format!(
                            "chapter {number} dibaca dari {sid} — {p} gagal diakses ({kind})"
                        ),
                        Some(PrimaryMiss::Missing) | None => {
                            format!("chapter {number} tidak ada di {p} — dibaca dari {sid}")
                        }
                    });
                    let outcome = ReadOutcomeX {
                        pages,
                        prev,
                        next,
                        switched_from,
                        note,
                        series_title_key: Some(manga.title_key.clone()),
                        series_title: Some(manga.title.clone()),
                    };
                    self.cache_put(&read_key, &outcome);
                    return Ok(outcome);
                }
                // Gambar kosong = trigger pindah sumber (keputusan 1);
                // TIDAK di-cache sebagai "tidak ada" (bukan kesimpulan pasti).
                Ok(Ok(_)) => {
                    if idx == 0 {
                        primary_miss = Some(PrimaryMiss::Empty);
                    }
                }
                Ok(Err(e)) => {
                    let kind = SourceError::from(e);
                    if kind.is_inaccessible() {
                        inaccessible.push((sid.clone(), kind.clone()));
                        if idx == 0 {
                            primary_miss = Some(PrimaryMiss::Inaccessible(kind));
                        }
                    } else if idx == 0 {
                        primary_miss = Some(PrimaryMiss::Missing);
                    }
                }
                Err(_) => {
                    inaccessible.push((sid, SourceError::Timeout));
                    if idx == 0 {
                        primary_miss = Some(PrimaryMiss::Inaccessible(SourceError::Timeout));
                    }
                }
            }
        }

        // A4: jangan klaim "tidak ditemukan" kalau ada sumber yang cuma tidak
        // bisa diakses.
        if inaccessible.is_empty() {
            anyhow::bail!("chapter {number} tidak ditemukan di sumber mana pun untuk {id}")
        }
        let detail = inaccessible
            .iter()
            .map(|(s, k)| format!("{}={k}", s.as_str()))
            .collect::<Vec<_>>()
            .join("; ");
        anyhow::bail!(
            "gagal memuat chapter {number} untuk {id} (semua sumber gagal diakses): {detail}"
        )
    }

    // ------------------------------------------------------- resolver helper

    /// Series dari satu sumber lewat native id langsung (dipakai handle /
    /// sticky). Kegagalan diklasifikasi lewat [`SourceError`].
    async fn load_series(
        &self,
        src: &Arc<dyn Source>,
        native: &str,
        cap: usize,
    ) -> SeriesLoad {
        match tokio::time::timeout(self.timeout, src.series(native)).await {
            Ok(Ok(mut detail)) => {
                detail.chapters.truncate(cap);
                SeriesLoad::Ok(detail.manga.clone(), detail)
            }
            Ok(Err(e)) => match SourceError::from(e) {
                k if k.is_conclusive() => SeriesLoad::Miss,
                k => SeriesLoad::Inaccessible(k),
            },
            Err(_) => SeriesLoad::Inaccessible(SourceError::Timeout),
        }
    }

    /// Series dari satu sumber via resolve JUDUL (exact `title_key`) — pola
    /// yang sama dengan fase 2 `series_resolve` / `series_with_fallback`.
    async fn load_series_by_title(&self, src: &Arc<dyn Source>, title: &str, cap: usize) -> SeriesLoad {
        // Varian judul: user sering menempel slug URL ("solo-leveling") padahal
        // search beberapa sumber (kiryuu/wp) hanya cocok dengan bentuk berspasi
        // ("solo leveling"). Coba as-is dulu, lalu varian hyphen->spasi.
        let mut candidates = vec![title.to_string()];
        let spaced = title.replace('-', " ");
        if spaced != title {
            candidates.push(spaced);
        }
        let mut last_load: Option<SeriesLoad> = None;
        for cand in candidates {
            let m = match tokio::time::timeout(self.timeout, src.resolve(&cand)).await {
                Ok(Ok(Some(m))) => m,
                Ok(Ok(None)) => {
                    last_load = Some(SeriesLoad::Miss);
                    continue;
                }
                Ok(Err(e)) => {
                    let k = SourceError::from(e);
                    if !k.is_conclusive() {
                        return SeriesLoad::Inaccessible(k);
                    }
                    last_load = Some(SeriesLoad::Miss);
                    continue;
                }
                Err(_) => return SeriesLoad::Inaccessible(SourceError::Timeout),
            };
            return self.load_series(src, &m.native_id, cap).await;
        }
        last_load.unwrap_or(SeriesLoad::Miss)
    }

    /// Kunci penanda negatif: "chapter `want` tidak ada di sumber `sid`
    /// untuk id yang diminta". Sengaja memakai id yang diminta (bukan handle
    /// hasil resolve) supaya panggilan berikutnya bisa melewati sumber ini
    /// tanpa fetch series.
    fn neg_chapter_key(&self, id: &str, sid: &SourceId, want: &str) -> String {
        format!("neg-chapter:{id}:{}:{want}", sid.as_str())
    }

    fn neg_series_key(&self, id: &str, sid: &SourceId) -> String {
        format!("neg-series:{id}:{}", sid.as_str())
    }

    fn neg_hit(&self, key: &str) -> bool {
        self.cache
            .as_ref()
            .is_some_and(|c| c.fresh(key).is_some())
    }

    /// Tulis penanda negatif TTL PENDEK (`cache::NEGATIVE_TTL`). Hanya untuk
    /// kesimpulan pasti dari sumber yang berhasil diakses.
    fn neg_put(&self, key: &str) {
        if let Some(cache) = &self.cache {
            if let Err(e) = cache.set_negative(key, serde_json::json!(true)) {
                eprintln!("⚠ cache negatif gagal ditulis ({key}): {e}");
            }
        }
    }

    // --------------------------------------------------------------- helper

    /// Jalankan satu operasi trait di semua sumber secara paralel, tiap sumber
    /// dengan timeout sendiri. Ok = (sumber, hasil); Err = (sumber, pesan).
    async fn join_sources<T, F, Fut>(
        &self,
        sources: Vec<Arc<dyn Source>>,
        call: F,
    ) -> Vec<Result<(Arc<dyn Source>, T), (SourceId, String)>>
    where
        T: Send + 'static,
        F: Fn(Arc<dyn Source>) -> Fut + Clone + Send + Sync + 'static,
        Fut: std::future::Future<Output = SourceResult<T>> + Send + 'static,
    {
        let timeout = self.timeout;
        let mut set = tokio::task::JoinSet::new();
        for src in sources {
            let call = call.clone();
            set.spawn(async move {
                let id = src.id();
                let fut = call(src.clone());
                match tokio::time::timeout(timeout, fut).await {
                    Ok(Ok(v)) => Ok((src, v)),
                    Ok(Err(e)) => Err((id, format!("{e:#}"))),
                    Err(_) => Err((id, format!("timeout {}s", timeout.as_secs()))),
                }
            });
        }
        let mut out = Vec::new();
        while let Some(joined) = set.join_next().await {
            match joined {
                Ok(r) => out.push(r),
                Err(e) => out.push(Err((SourceId::from("?"), format!("task gagal: {e}")))),
            }
        }
        out
    }

    /// Versi `join_sources` untuk item yang BUKAN `Arc<dyn Source>` — dipakai
    /// tahap 2 pengumpulan union, di mana tiap item sudah membawa
    /// `(sumber, native_id)`. Closure mengembalikan
    /// `Result<T, (SourceId, String)>` supaya sumber yang gagal tetap bisa
    /// dilaporkan (tidak seperti `join_sources` yang error-nya anyhow).
    async fn join_items<T, I, F, Fut>(
        &self,
        items: Vec<I>,
        call: F,
    ) -> Vec<Result<(I, T), (SourceId, String)>>
    where
        I: Clone + Send + 'static,
        T: Send + 'static,
        F: Fn(I) -> Fut + Clone + Send + Sync + 'static,
        Fut: std::future::Future<Output = Result<T, (SourceId, String)>> + Send + 'static,
    {
        let timeout = self.timeout;
        let mut set = tokio::task::JoinSet::new();
        for item in items {
            let call = call.clone();
            set.spawn(async move {
                let fut = call(item.clone());
                match tokio::time::timeout(timeout, fut).await {
                    Ok(Ok(v)) => Ok((item, v)),
                    Ok(Err(e)) => Err(e),
                    Err(_) => Err((SourceId::from("?"), format!("timeout {}s", timeout.as_secs()))),
                }
            });
        }
        let mut out = Vec::new();
        while let Some(joined) = set.join_next().await {
            match joined {
                Ok(r) => out.push(r),
                Err(e) => out.push(Err((SourceId::from("?"), format!("task gagal: {e}")))),
            }
        }
        out
    }

    /// Urutan fallback: sumber primary dulu, sisanya menurut SOURCE_PRIORITY.
    fn fallback_order(&self, primary: Option<SourceId>, source: Option<&str>) -> Vec<Arc<dyn Source>> {
        let mut all = self.filtered(source);
        all.sort_by_key(|s| {
            let sid = s.id();
            let is_primary = primary.as_ref() == Some(&sid);
            (!is_primary, source_priority(&sid))
        });
        all
    }

    /// Tulis cache; kegagalan (disk penuh / read-only) dilaporkan, bukan
    /// ditelan diam-diam.
    fn cache_put(&self, key: &str, value: &impl Serialize) {
        if let Some(cache) = &self.cache {
            if let Err(e) = cache.set_json(key, value) {
                eprintln!("⚠ cache gagal ditulis ({key}): {e}");
            }
        }
    }

    fn cache_key(&self, op: &str, source: Option<&str>, arg: &str) -> String {
        format!("{}:{}:{}", op, source.unwrap_or("*"), arg)
    }

    /// Ingat judul series untuk sebuah handle (TTL panjang: 30 hari).
    ///
    /// Dipakai untuk FAILOVER saat sumber primary mati total: tanpa judul,
    /// handle `komiku:1160` tidak bisa dicari di sumber lain (native_id bukan
    /// judul). Disimpan dengan TTL 30 hari (judul series praktis tidak berubah,
    /// dan failover tetap bertahan jauh setelah TTL data biasa 10 menit).
    fn remember_title(&self, handle: &str, title: &str, title_key: &str) {
        let key = format!("title-of:{handle}");
        if let Some(cache) = &self.cache {
            if let Ok(v) = serde_json::to_value((title.to_string(), title_key.to_string())) {
                let _ = cache.set_expiring_in(
                    &key,
                    std::time::Duration::from_secs(30 * 24 * 60 * 60),
                    v,
                );
            }
        }
    }

    /// Ambil judul series yang pernah diingat untuk handle ini.
    fn recall_title(&self, handle: &str) -> Option<(String, String)> {
        let key = format!("title-of:{handle}");
        self.cache
            .as_ref()
            .and_then(|c| c.fresh_json::<(String, String)>(&key))
    }

    /// Kumpulkan daftar chapter dari SEMUA sumber yang punya series dengan judul
    /// sama (exact `title_key`), paralel, timeout per sumber.
    ///
    /// - Sumber yang gagal/timeout DILEWATI (partial failure tolerated) dan
    ///   dikembalikan di `failed` sebagai (SourceId, pesan).
    /// - Sumber tidak boleh yang sama dengan `skip_source` (sumber pelayan).
    /// - `title` = judul series yang sudah dimuat (bukan handle).
    /// - Kunci cache: "series-union:{title_key}".
    ///
    /// Cache disimpan PER SUMBER (peta id sumber -> (handle, daftar chapter))
    /// supaya kunci tetap "series-union:{title_key}" apa pun `skip_source` yang
    /// dipakai: sumber yang belum ada di cache tetap diambil saat panggilan
    /// ini, dan sumber pelayan cukup dibuang dari keluaran.
    pub async fn collect_series_across_sources(
        &self,
        title: &str,
        skip_source: Option<&SourceId>,
        limit: u32,
    ) -> (
        Vec<crate::union::SourceChapterList>,
        Vec<(SourceId, String)>,
    ) {
        let tkey = crate::model::title_key(title);
        let cache_key = format!("series-union:{tkey}");

        // Cache: id sumber -> (handle series, daftar chapter).
        let mut by_source: std::collections::BTreeMap<String, (String, Vec<Chapter>)> =
            std::collections::BTreeMap::new();
        if let Some(cache) = &self.cache {
            if let Some(hit) = cache
                .fresh_json::<std::collections::BTreeMap<String, (String, Vec<Chapter>)>>(&cache_key)
            {
                by_source = hit;
            }
        }

        // Target: semua sumber yang dikenal, kecuali sumber pelayan
        // (`skip_source`) dan yang sudah ada di cache.
        let skip_id = skip_source.cloned();
        let targets: Vec<Arc<dyn Source>> = self
            .sources
            .iter()
            .filter(|s| Some(&s.id()) != skip_id.as_ref())
            .filter(|s| !by_source.contains_key(s.id().as_str()))
            .cloned()
            .collect();

        let mut failed: Vec<(SourceId, String)> = Vec::new();
        if !targets.is_empty() {
            // DUA TAHAP, bukan resolve->series berurutan per sumber.
            //
            // Sebelumnya tiap sumber melakukan `resolve` lalu `series` secara
            // SEBERANG, jadi latensi = max(resolve_i + series_i) — dengan
            // komiku (resolve 2.3s + series 1.0s) totalnya didominasi
            // sumber TERLAMBAT. Sekarang: tahap 1 semua `resolve` paralel,
            // tahap 2 semua `series` paralel → latensi =
            // max(resolve_i) + max(series_i).
            //
            // Resolve WAJIB exact `title_key` (anti-false-positive): manga
            // "Tower Of God: Side Story" tidak boleh tercemar manga
            // "Tower Of God" hanya karena judulnya mirip.
            let t = title.to_string();
            let call_resolve = move |src: Arc<dyn Source>| {
                let t = t.clone();
                async move {
                    // Varian judul: user sering menempel slug URL ("solo-leveling")
                    // padahal sumber hanya cocok dengan bentuk berspasi
                    // ("solo leveling") — pola yang sama dengan
                    // `load_series_by_title`.
                    let mut candidates = vec![t.clone()];
                    let spaced = t.replace('-', " ");
                    if spaced != t {
                        candidates.push(spaced);
                    }
                    for cand in candidates {
                        // Resolve by exact `title_key` (default trait `resolve`).
                        match src.resolve(&cand).await {
                            Ok(Some(m)) => return Ok(Some(m.native_id)),
                            // Sumber terakses tapi judulnya tidak ada -> coba
                            // varian berikutnya.
                            Ok(None) => continue,
                            Err(e) => {
                                if SourceError::from(&e).is_conclusive() {
                                    continue;
                                }
                                return Err(e);
                            }
                        }
                    }
                    // Sumber tidak punya series dengan judul itu.
                    Ok(None)
                }
            };

            // Tahap 1: resolve semua sumber paralel.
            let mut resolved: Vec<(Arc<dyn Source>, String)> = Vec::new();
            for res in self.join_sources(targets, call_resolve).await {
                match res {
                    Ok((src, Some(native_id))) => {
                        resolved.push((src, native_id));
                    }
                    // Sumber tidak punya series itu -> dilewati (bukan failed).
                    Ok((_, None)) => {}
                    Err((sid, msg)) => failed.push((sid, msg)),
                }
            }

            // Tahap 2: series semua sumber yang ter-resolve, paralel.
            if !resolved.is_empty() {
                let call_series = move |(src, native_id): (Arc<dyn Source>, String)| {
                    let src2 = src.clone();
                    async move {
                        match src.series(&native_id).await {
                            Ok(detail) => {
                                // Handle series di sumber itu: "sumber:native-id".
                                let handle = format!("{}:{}", src.id().as_str(), native_id);
                                Ok((src2, Some((handle, detail.chapters))))
                            }
                            Err(e) => {
                                if SourceError::from(&e).is_conclusive() {
                                    Ok((src2, None))
                                } else {
                                    Err((src.id(), e.to_string()))
                                }
                            }
                        }
                    }
                };
                for res in self.join_items(resolved, call_series).await {
                    match res {
                        Ok((_, (src, Some((handle, chapters))))) => {
                            by_source.insert(src.id().as_str().to_string(), (handle, chapters));
                        }
                        // Sumber tak punya series -> dilewati (bukan failed).
                        Ok((_, (_, None))) => {}
                        Err((sid, msg)) => failed.push((sid, msg)),
                    }
                }
            }
            // Cache ditulis walau sebagian sumber gagal: entri per sumber
            // tetap aman (sumber yang gagal akan diambil lagi di panggilan
            // berikutnya).
            self.cache_put(&cache_key, &by_source);
        }

        // Keluaran: semua sumber yang punya series, sumber pelayan dibuang.
        let mut out: Vec<crate::union::SourceChapterList> = by_source
            .into_iter()
            .filter(|(sid, _)| Some(sid.as_str()) != skip_id.as_ref().map(|s| s.as_str()))
            .map(|(sid, (handle, chapters))| crate::union::SourceChapterList {
                source: SourceId::from(sid.as_str()),
                handle,
                chapters,
            })
            .collect();
        out.sort_by_key(|l| (source_priority(&l.source), l.source.as_str().to_string()));
        for l in &mut out {
            if limit > 0 {
                l.chapters.truncate(limit as usize);
            }
        }
        (out, failed)
    }
}

// -------------------------------------------------------------- dedup/rank

/// Trait kecil supaya `merged<T>` bisa dedup + rank tanpa menyalin logika per
/// tipe: judul, recency, dan identitas sumber sudah cukup.
pub trait Rankable: Sized {
    fn rank_title_key(&self) -> &str;
    /// Kunci grup untuk dedup ceiling. Default = title_key eksak; Manga
    /// override ke kunci kanonik supaya judul seri yang sama tapi beda tata
    /// kata lintas sumber bisa bergabung.
    fn rank_canonical_key(&self) -> String {
        self.rank_title_key().to_string()
    }
    fn rank_updated_at(&self) -> Option<i64>;
    fn rank_source(&self) -> &SourceId;
    /// Nomor chapter terbaru (string mentah; None kalau tidak tersedia).
    fn rank_last_chapter(&self) -> Option<&str>;
    /// Lengkapi field yang kosong dari duplikat (cover, author, ...).
    fn merge_from(&mut self, other: &Self);
}

impl Rankable for Manga {
    fn rank_title_key(&self) -> &str {
        &self.title_key
    }
    fn rank_updated_at(&self) -> Option<i64> {
        self.updated_at
    }
    fn rank_source(&self) -> &SourceId {
        &self.source
    }
    fn rank_canonical_key(&self) -> String {
        title_canonical_key(&self.title)
    }
    fn rank_last_chapter(&self) -> Option<&str> {
        self.last_chapter.as_deref()
    }
    fn merge_from(&mut self, other: &Self) {
        macro_rules! fill {
            ($f:ident) => {
                if self.$f.is_none() {
                    self.$f = other.$f.clone();
                }
            };
        }
        fill!(cover_url);
        fill!(author);
        fill!(status);
        fill!(manga_type);
        fill!(rating);
        fill!(last_chapter);
        fill!(url);
        if self.updated_at.is_none() {
            self.updated_at = other.updated_at;
        }
    }
}

/// Dedup by title_key (pemenang = recency terbaru, tiebreak prioritas sumber),
/// output di-rank recency desc (None paling bawah).
pub fn dedup_rank<T: Rankable + Clone>(items: Vec<T>) -> Vec<T> {
    let mut order: Vec<String> = Vec::new();
    let mut by_key: HashMap<String, T> = HashMap::new();

    for item in items {
        let key = item.rank_title_key().to_string();
        match by_key.get_mut(&key) {
            None => {
                order.push(key.clone());
                by_key.insert(key, item);
            }
            Some(existing) => {
                if rank_cmp(&item, existing) == std::cmp::Ordering::Less {
                    let mut item = item;
                    item.merge_from(existing);
                    *existing = item;
                } else {
                    existing.merge_from(&item);
                }
            }
        }
    }

    let mut out: Vec<T> = order.into_iter().filter_map(|k| by_key.remove(&k)).collect();
    out.sort_by(|a, b| rank_cmp(a, b));
    out
}

/// Dedup by title_key dengan aturan CEILING lintas sumber (feed "Update terbaru"):
/// dalam satu group judul, pemenang = entri dengan `last_chapter` numerik
/// TERTINGGI (tiebreak `SOURCE_PRIORITY`); entri di bawah ceiling TIDAK ikut
/// tampil. Kalau tidak ada entri yang numerik di group itu, fallback ke
/// recency/prioritas (perilaku `dedup_rank` lama). Output tetap di-rank recency
/// desc.
pub fn dedup_rank_ceiling<T: Rankable + Clone>(items: Vec<T>) -> Vec<T> {
    let mut order: Vec<String> = Vec::new();
    let mut by_key: HashMap<String, Vec<T>> = HashMap::new();
    for item in items {
        let key = item.rank_canonical_key();
        if !by_key.contains_key(&key) {
            order.push(key.clone());
        }
        by_key.entry(key).or_default().push(item);
    }

    let mut out = Vec::with_capacity(order.len());
    for key in order {
        let group = by_key.remove(&key).unwrap();
        out.push(pick_ceiling_winner(group));
    }
    out.sort_by(|a, b| rank_cmp(a, b));
    out
}

/// Pilih pemenang satu group judul untuk dedup ceiling.
fn pick_ceiling_winner<T: Rankable + Clone>(group: Vec<T>) -> T {
    // Indeks yang punya last_chapter numerik.
    let numeric: Vec<usize> = group
        .iter()
        .enumerate()
        .filter(|(_, x)| x.rank_last_chapter().map(is_numeric_chapter).unwrap_or(false))
        .map(|(i, _)| i)
        .collect();

    let winner_idx = if numeric.is_empty() {
        // Fallback: recency/prioritas (perilaku `dedup_rank` lama).
        group
            .iter()
            .enumerate()
            .reduce(|acc, cur| {
                if rank_cmp(acc.1, cur.1) == std::cmp::Ordering::Less {
                    acc
                } else {
                    cur
                }
            })
            .map(|(i, _)| i)
            .unwrap_or(0)
    } else {
        numeric
            .into_iter()
            .reduce(|best, cur| {
                let lb = group[best].rank_last_chapter().unwrap();
                let lc = group[cur].rank_last_chapter().unwrap();
                match cmp_chapter_number(lb, lc) {
                    std::cmp::Ordering::Greater => best,
                    std::cmp::Ordering::Less => cur,
                    std::cmp::Ordering::Equal => {
                        // Tie: prioritas sumber lebih tinggi (indeks kecil) menang.
                        let pb = source_priority(group[best].rank_source());
                        let pc = source_priority(group[cur].rank_source());
                        if pb <= pc { best } else { cur }
                    }
                }
            })
            .unwrap()
    };

    let mut winner = group[winner_idx].clone();
    for (i, other) in group.iter().enumerate() {
        if i != winner_idx {
            winner.merge_from(other);
        }
    }
    winner
}

/// Memoize keputusan validasi tie per (kunci kanonik series, nomor ceiling).
/// Nilai = handle pemenang. Grup tie yang berulang (mis. di lintas halaman)
/// tidak perlu re-fetch series resolve.
fn tie_validation_cache() -> &'static std::sync::Mutex<HashMap<(String, String), String>> {
    use std::sync::OnceLock;
    static CACHE: OnceLock<std::sync::Mutex<HashMap<(String, String), String>>> = OnceLock::new();
    CACHE.get_or_init(|| std::sync::Mutex::new(HashMap::new()))
}

fn rank_cmp<T: Rankable>(a: &T, b: &T) -> std::cmp::Ordering {
    match (a.rank_updated_at(), b.rank_updated_at()) {
        (Some(x), Some(y)) if x != y => return y.cmp(&x),
        (Some(_), None) => return std::cmp::Ordering::Less,
        (None, Some(_)) => return std::cmp::Ordering::Greater,
        _ => {}
    }
    source_priority(a.rank_source()).cmp(&source_priority(b.rank_source()))
}

fn source_priority(s: &SourceId) -> usize {
    SOURCE_PRIORITY
        .iter()
        .position(|p| *p == s.as_str())
        .unwrap_or(usize::MAX)
}

/// Tier relevansi sebuah judul terhadap kueri (lebih kecil = lebih relevan).
/// Dipakai [`rank_by_query`] sebagai kunci utama yang lebih penting dari
/// recency. Prefix & semua-token cocok STABIL (satu representan angka), jadi
/// dipakai `Ord`; tiebreak dalam tier partial ada di `match_count`.
#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Debug)]
enum MatchTier {
    /// Judul_key identik persis dengan kueri.
    Exact,
    /// title_key diawali kueri.
    Prefix,
    /// Semua token kueri muncul di judul.
    AllTokens,
    /// Hanya sebagian token yang cocok (tier berbeda hanya untuk pengelompokan;
    /// urutan dalam grup ini = jumlah token cocok desc).
    Partial,
    /// Tidak ada token kueri yang cocok (paling bawah).
    NoMatch,
}

/// Tier + jumlah token kueri yang cocok di `title_key` (sudah lowercase dari
/// model). Item tanpa satu pun token tetap keluar (NoMatch) supaya set hasil
/// tidak menyusut. `query_key` = token kueri yang sudah di-join spasi.
fn match_tier(title_key: &str, tokens: &[String], query_key: &str) -> (MatchTier, usize) {
    if title_key.is_empty() {
        return (MatchTier::NoMatch, 0);
    }
    if title_key == query_key {
        return (MatchTier::Exact, tokens.len());
    }
    if title_key.starts_with(query_key) {
        return (MatchTier::Prefix, tokens.len());
    }
    let matched = tokens
        .iter()
        .filter(|t| title_key.contains(t.as_str()))
        .count();
    if matched == tokens.len() {
        (MatchTier::AllTokens, matched)
    } else if matched > 0 {
        (MatchTier::Partial, matched)
    } else {
        (MatchTier::NoMatch, 0)
    }
}

/// Rank ulang hasil merge menurut relevansi KUERI (bukan recency).
///
/// Urutan (frozen; semua pembanding di atas `title_key` lowercase):
/// 1. `title_key == query` (setelah normalisasi token), 2. prefix,
/// 3. semua token kueri ada di judul, 4. sebagian token — jumlah token cocok
/// desc, 5. recency desc (`None` di bawah), 6. `SOURCE_PRIORITY`.
/// Setiap angka kunci berada di tuple terpisah, jadi `AllTokens` memang selalu
/// mengalahkan `Partial` berapa pun jumlah kecocokannya.
///
/// Input diasumsikan SUDAH dedup ([`dedup_rank`]); tidak ada item yang dibuang
/// atau digandakan di sini — hanya diurut ulang (jumlah tetap). Kueri kosong
/// (atau hanya spasi) = no-op, urutan input dikembalikan apa adanya.
///
/// TIDAK mengurangi/merusak `dedup_rank`: dipakai hanya oleh
/// [`Aggregator::search`]; `popular`/`latest`/`list` tetap pakai
/// `dedup_rank` (recency).
/// Ceiling untuk kartu: set `last_chapter` tiap item = max numerik lintas
/// sumber yang sekunci kanonik. Tidak mengubah jumlah/urutan item; hanya
/// menaikkan "chapter terbaru" yang ditampilkan ke sumber dengan episode terbesar.
fn apply_ceiling_last_chapter(items: &mut [Manga]) {
    use std::cmp::Ordering;
    let mut best: HashMap<String, Option<String>> = HashMap::new();
    for m in items.iter() {
        let k = m.rank_canonical_key();
        if let Some(lc) = m.rank_last_chapter() {
            let e = best.entry(k).or_default();
            let better = match e.as_deref() {
                None => true,
                Some(cur) => cmp_chapter_number(lc, cur) == Ordering::Greater,
            };
            if better {
                *e = Some(lc.to_string());
            }
        }
    }
    for m in items.iter_mut() {
        if let Some(v) = best.get(&m.rank_canonical_key()) {
            m.last_chapter = v.clone();
        }
    }
}

pub fn rank_by_query<T: Rankable>(items: Vec<T>, query: &str) -> Vec<T> {
    // Token kueri lowercase, tanpa duplikat ("solo  solo" -> 1 token).
    let mut seen = HashSet::new();
    let tokens: Vec<String> = query
        .to_lowercase()
        .split_whitespace()
        .filter(|t| seen.insert(t.to_string()))
        .map(|t| t.to_string())
        .collect();
    if tokens.is_empty() {
        return items;
    }
    let query_key = tokens.join(" ");
    let mut out: Vec<T> = items;
    out.sort_by(|a, b| {
        let (ta, ma) = match_tier(&a.rank_title_key().to_lowercase(), &tokens, &query_key);
        let (tb, mb) = match_tier(&b.rank_title_key().to_lowercase(), &tokens, &query_key);
        // 1-4: tier lebih dulu; dalam tier Partial, jumlah token cocok desc.
        ta.cmp(&tb)
            .then_with(|| mb.cmp(&ma))
            // 5-6: recency desc (None di bawah), tiebreak SOURCE_PRIORITY —
            // komparator sama persis dengan `dedup_rank` supaya urutannya
            // total (tidak bergantung urutan input).
            .then_with(|| rank_cmp(a, b))
    });
    out
}

fn unique_sources(list: &[String]) -> Vec<String> {
    let mut seen = HashSet::new();
    list.iter()
        .filter(|s| !s.is_empty() && seen.insert(s.as_str()))
        .cloned()
        .collect()
}

/// Cari chapter by kunci kanonik STRING (lihat
/// [`crate::model::chapter_number_key`]): "179.60" == "179.6", "007" == "7",
/// "extra" TIDAK == "7". Bukan f64 — f64 tidak bisa jadi kunci persis dan
/// mempertaruhkan label non-desimal.
pub fn chapter_by_number(detail: &SeriesDetail, number: &str) -> Option<Chapter> {
    chapter_index_by_key(detail, number).map(|i| detail.chapters[i].clone())
}

/// Posisi chapter di daftar menurut kunci kanonik. Dipakai `read_chapter_any`
/// untuk menghitung tetangga prev/next dari daftar yang sama.
pub fn chapter_index_by_key(detail: &SeriesDetail, number: &str) -> Option<usize> {
    let want = chapter_number_key(number);
    detail
        .chapters
        .iter()
        .position(|c| chapter_number_key(&c.number) == want)
}

/// Batas chapter per sumber saat mencari tetangga LINTAS sumber.
///
/// 0 = tanpa pemotongan: daftar chapter sumber lain dipakai utuh supaya
/// kandidat terdekat (mis. "233" dari "232") tak terpotong.
const CROSS_SOURCE_CHAPTER_LIMIT: u32 = 0;

/// prev/next dari daftar chapter sumber yang MELAYAN. Daftar chapter
/// terbaru-dulu (kontrak trait `Source`), jadi `prev` = lebih tua (index+1)
/// dan `next` = lebih baru (index-1) — konvensi sama dengan endpoint chapter
/// server yang sudah ada. Chapter di tepi dapat `None`.
fn neighbor_refs(detail: &SeriesDetail, pos: usize) -> (Option<ChapterRef>, Option<ChapterRef>) {
    let handle = detail.manga.handle();
    let mk = |c: &Chapter| ChapterRef {
        number: c.number.clone(),
        source: c.source.clone(),
        handle: handle.clone(),
    };
    let next = pos
        .checked_sub(1)
        .and_then(|i| detail.chapters.get(i))
        .map(|c| mk(c));
    let prev = detail.chapters.get(pos + 1).map(|c| mk(c));
    (prev, next)
}

/// Kandidat tetangga LINTAS SUMBER untuk chapter `current`.
///
/// Dipakai hanya saat sumber yang melayani sudah di TEPI (tidak punya
/// `next` / tidak punya `prev`). Sumber lain searched =
/// [`Aggregator::collect_series_across_sources`] (judul sama, sumber pelayan
/// dilewati).
///
/// - `next` = nomor LEBIH BESAR dari `current`, yang terkecil (suksesor
///   terdekat).
/// - `prev` = nomor LEBIH KECIL dari `current`, yang terbesar.
///
/// Perbandingan memakai [`crate::union::cmp_chapter_number`] (numerik-aware,
/// identitas string `chapter_number_key`) — bukan f64. Label non-numerik
/// ("extra", "prologue") kalah dari kandidat numerik, jadi `prev` memilih
/// "extra" hanya kalau tak ada kandidat numerik yang lebih kecil.
///
/// Kandidat dengan nomor sama di beberapa sumber: yang pertama (urutan
/// prioritas sumber) menang.
fn pick_cross_source_neighbors(
    lists: &[crate::union::SourceChapterList],
    current: &str,
) -> (Option<ChapterRef>, Option<ChapterRef>) {
    let mut next: Option<ChapterRef> = None;
    let mut prev: Option<ChapterRef> = None;
    for list in lists {
        for ch in &list.chapters {
            let mk = || ChapterRef {
                number: ch.number.clone(),
                source: list.source.clone(),
                handle: list.handle.clone(),
            };
            match crate::union::cmp_chapter_number(&ch.number, current) {
                // Nomor lebih besar -> kandidat `next`: ambil yang terkecil.
                std::cmp::Ordering::Greater => {
                    let better = match &next {
                        None => true,
                        Some(n) => {
                            crate::union::cmp_chapter_number(&ch.number, &n.number)
                                == std::cmp::Ordering::Less
                        }
                    };
                    if better {
                        next = Some(mk());
                    }
                }
                // Nomor lebih kecil -> kandidat `prev`: ambil yang terbesar.
                std::cmp::Ordering::Less => {
                    let better = match &prev {
                        None => true,
                        Some(p) => {
                            crate::union::cmp_chapter_number(&ch.number, &p.number)
                                == std::cmp::Ordering::Greater
                        }
                    };
                    if better {
                        prev = Some(mk());
                    }
                }
                // Nomor sama -> chapter itu sendiri, bukan tetangga.
                std::cmp::Ordering::Equal => {}
            }
        }
    }
    (prev, next)
}

/// Tambah sumber ke daftar urutan kalau belum ada (dedup by SourceId).
fn push_unique(list: &mut Vec<Arc<dyn Source>>, src: Arc<dyn Source>) {
    if !list.iter().any(|s| s.id() == src.id()) {
        list.push(src);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::Manga;

    /// Manga sintetis: `updated_at` = None, `native_id` = tag identitas.
    fn m(src: &str, tag: &str, title: &str) -> Manga {
        let mut m = Manga::new(SourceId::from(src), tag, title);
        m.manga_type = Some("Manga".into());
        m
    }

    /// Urutan native_id hasil rank (setiap fixture punya native_id unik).
    fn ids(items: &[Manga]) -> Vec<&str> {
        items.iter().map(|m| m.native_id.as_str()).collect()
    }

    /// 1. Exact match mengalahkan non-match yang LEBIH BARU.
    #[test]
    fn exact_mengalahkan_non_match_yang_lebih_baru() {
        let exact = {
            let mut m = m("komiku", "exact", "Solo Leveling");
            m.updated_at = Some(100); // lebih tua
            m
        };
        let newer = {
            let mut m = m("komiku", "newer", "Solo Necromancy");
            m.updated_at = Some(9_000);
            m
        };
        let out = rank_by_query(vec![newer, exact], "solo leveling");
        assert_eq!(ids(&out), vec!["exact", "newer"]);
    }

    /// 2. Prefix mengalahkan word-match (sisa kata).
    #[test]
    fn prefix_mengalahkan_word_match() {
        // "solo leveling" prefix dari "solo leveling reawakening";
        // "leveling" saja = word-match sebagian (bukan prefix).
        let prefix = m("komiku", "prefix", "Solo Leveling Reawakening");
        let word = m("komiku", "word", "Leveling Up Alone");
        let out = rank_by_query(vec![word, prefix], "solo leveling");
        assert_eq!(ids(&out), vec!["prefix", "word"]);
    }

    /// 3. All-tokens mengalahkan partial.
    #[test]
    fn all_tokens_mengalahkan_partial() {
        // "The Solo Leveling": bukan exact/prefix, tapi KEDUA token ada.
        let all = m("komiku", "all", "The Solo Leveling");
        let partial = m("komiku", "partial", "Solo Necromancy");
        let out = rank_by_query(vec![partial, all], "solo leveling");
        assert_eq!(ids(&out), vec!["all", "partial"]);
    }

    /// 4. Partial diurut jumlah token cocok desc.
    #[test]
    fn partial_urut_token_cocok_desc() {
        // Keduanya partial (bukan prefix): satu cocok 2 token, satu cocok 1.
        let two = m("komiku", "two", "Side Story Solo Leveling"); // cocok 2
        let one = m("komiku", "one", "Leveling Only"); // cocok 1
        let out = rank_by_query(vec![one, two], "solo leveling");
        assert_eq!(ids(&out), vec!["two", "one"]);
    }

    /// 5. Tieback recency desc (None di bawah) + SOURCE_PRIORITY.
    #[test]
    fn tieback_recency_lalu_source_priority() {
        let newer = {
            let mut m = m("komiku", "newer", "Solo Leveling");
            m.updated_at = Some(500);
            m
        };
        let older = {
            let mut m = m("komiku", "older", "Solo Leveling");
            m.updated_at = Some(100);
            m
        };
        let none = m("komiku", "none", "Solo Leveling"); // updated_at None
        let out = rank_by_query(vec![none, older, newer], "solo leveling");
        assert_eq!(ids(&out), vec!["newer", "older", "none"]);

        // Recency sama -> prioritas sumber: komiku < mangaku < shinigami < kiryuu.
        let same = Some(7);
        let a = {
            let mut m = m("kiryuu", "kiryuu", "Solo Leveling");
            m.updated_at = same;
            m
        };
        let b = {
            let mut m = m("komiku", "komiku", "Solo Leveling");
            m.updated_at = same;
            m
        };
        let out = rank_by_query(vec![a, b], "solo leveling");
        assert_eq!(ids(&out), vec!["komiku", "kiryuu"]);
    }

    /// 6. Kueri kosong = no-op; hasil = urutan + isi input apa adanya.
    #[test]
    fn kueri_kosong_noop() {
        let input = vec![
            m("komiku", "a", "Zeta"),
            m("komiku", "b", "Alpha"),
            m("komiku", "c", "Mid"),
        ];
        let out = rank_by_query(input.clone(), "   ");
        assert_eq!(ids(&out), ids(&input));
        let out2 = rank_by_query(input.clone(), "");
        assert_eq!(ids(&out2), ids(&input));
    }

    /// 7. Set hasil tak berubah: tidak ada item hilang/terduplikasi.
    #[test]
    fn hasil_set_tidak_berubah() {
        let input = vec![
            m("komiku", "a", "Solo Leveling"),
            m("komiku", "b", "Solo Leveling Reawakening"),
            m("komiku", "c", "Solo Necromancy"),
            m("komiku", "d", "Unrelated Title"),
            m("komiku", "e", "solo max level newbie"),
        ];
        let out = rank_by_query(input.clone(), "solo leveling");
        assert_eq!(out.len(), input.len());
        let mut a: Vec<&str> = input.iter().map(|m| m.native_id.as_str()).collect();
        let mut b: Vec<&str> = out.iter().map(|m| m.native_id.as_str()).collect();
        a.sort_unstable();
        b.sort_unstable();
        assert_eq!(a, b, "tidak boleh ada item hilang/terduplikasi");
    }

    /// 8. Query dikenali case-insensitive (title_key sudah lowercase, tapi
    ///    query bisa campur huruf besar).
    #[test]
    fn kueri_case_insensitive() {
        let m1 = m("komiku", "m", "Solo Leveling");
        let m2 = m("komiku", "n", "Solo Necromancy");
        let out = rank_by_query(vec![m2, m1], "SOLO Leveling");
        assert_eq!(ids(&out), vec!["m", "n"]);
    }

    // -------------------------------------------------- dedup ceiling (feed)

    fn with_last(mut m: Manga, last: &str) -> Manga {
        m.last_chapter = Some(last.to_string());
        m
    }

    /// Skenario utama: shinigami 102, komikku 100 -> hanya shinigami tampil,
    /// komikku (di bawah ceiling) disembunyikan.
    #[test]
    fn ceiling_sembunyikan_update_di_bawah() {
        let s = with_last(m("shinigami", "s", "Solo Leveling"), "102");
        let k = with_last(m("komiku", "k", "Solo Leveling"), "100");
        let out = dedup_rank_ceiling(vec![s, k]);
        assert_eq!(ids(&out), vec!["s"]);
        assert_eq!(out[0].last_chapter.as_deref(), Some("102"));
    }

    /// komikku naik ke 103 (> ceiling 102) -> jadi pemenang baru.
    #[test]
    fn ceiling_tampil_saat_melebihi() {
        let s = with_last(m("shinigami", "s", "Solo Leveling"), "102");
        let k = with_last(m("komiku", "k", "Solo Leveling"), "103");
        let out = dedup_rank_ceiling(vec![s, k]);
        assert_eq!(ids(&out), vec!["k"]);
        assert_eq!(out[0].last_chapter.as_deref(), Some("103"));
    }

    /// Ceiling sama besar -> tiebreak SOURCE_PRIORITY (komiku > shinigami).
    #[test]
    fn ceiling_tie_prioritas() {
        let s = with_last(m("shinigami", "s", "Solo Leveling"), "102");
        let k = with_last(m("komiku", "k", "Solo Leveling"), "102");
        let out = dedup_rank_ceiling(vec![s, k]);
        assert_eq!(ids(&out), vec!["k"]);
    }

    /// Tanpa last_chapter numerik -> fallback recency/prioritas (perilaku lama).
    #[test]
    fn ceiling_fallback_non_numerik() {
        let a = with_last(m("shinigami", "a", "X"), "extra");
        let b = with_last(m("komiku", "b", "X"), "prologue");
        let out = dedup_rank_ceiling(vec![a, b]);
        assert_eq!(ids(&out), vec!["b"]);
    }

    /// Campur: non-numerik tidak ikut ceiling, numerik menang.
    #[test]
    fn ceiling_numerik_mengalahkan_non_numerik() {
        let a = with_last(m("komiku", "a", "X"), "extra");
        let b = with_last(m("shinigami", "b", "X"), "102");
        let out = dedup_rank_ceiling(vec![a, b]);
        assert_eq!(ids(&out), vec!["b"]);
        assert_eq!(out[0].last_chapter.as_deref(), Some("102"));
    }

    /// Urutan antar-series tetap recency desc (updated_at).
    #[test]
    fn ceiling_urut_recency_desc() {
        let mut t1 = with_last(m("shinigami", "t1", "Alpha"), "10");
        t1.updated_at = Some(500);
        let t2 = with_last(m("komiku", "t2", "Beta"), "5");
        let out = dedup_rank_ceiling(vec![t2, t1]);
        assert_eq!(ids(&out), vec!["t1", "t2"]);
    }

    /// Jumlah hasil = jumlah judul unik (tidak ada duplikat judul).
    #[test]
    fn ceiling_hasil_set_unik() {
        let a = with_last(m("shinigami", "a", "Solo Leveling"), "102");
        let b = with_last(m("komiku", "b", "Solo Leveling"), "100");
        let c = with_last(m("komiku", "c", "Lain"), "7");
        let out = dedup_rank_ceiling(vec![a, b, c]);
        assert_eq!(out.len(), 2);
    }

    // ---------------------------------------------- QA adversarial (ultraqa)

    /// Input kosong -> output kosong (tidak panic).
    #[test]
    fn ceiling_empty_input() {
        let out = dedup_rank_ceiling::<Manga>(vec![]);
        assert!(out.is_empty());
    }

    /// Satu entri numerik -> lolos apa adanya (jumlah tetap 1).
    #[test]
    fn ceiling_single_numeric() {
        let a = with_last(m("komiku", "a", "Solo"), "105");
        let out = dedup_rank_ceiling(vec![a]);
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].last_chapter.as_deref(), Some("105"));
    }

    /// Normalisasi desimal: "179.60" vs "179.6" = tie -> prioritas komiku menang.
    #[test]
    fn ceiling_tie_desimal_ternormalisasi() {
        let a = with_last(m("shinigami", "a", "X"), "179.60");
        let b = with_last(m("komiku", "b", "X"), "179.6");
        let out = dedup_rank_ceiling(vec![a, b]);
        assert_eq!(ids(&out), vec!["b"]);
    }

    /// Normalisasi nol depan: "007" vs "7" = tie -> prioritas komiku menang.
    #[test]
    fn ceiling_tie_leading_zero() {
        let a = with_last(m("shinigami", "a", "X"), "007");
        let b = with_last(m("komiku", "b", "X"), "7");
        let out = dedup_rank_ceiling(vec![a, b]);
        assert_eq!(ids(&out), vec!["b"]);
    }

    /// Nomor lebih tinggi menang MESKIPUN sumbernya prioritas lebih rendah.
    #[test]
    fn ceiling_angka_tinggi_menang_bebas_prioritas() {
        let a = with_last(m("komiku", "a", "X"), "100"); // prioritas tinggi
        let b = with_last(m("kiryuu", "b", "X"), "120"); // prioritas rendah, angka besar
        let out = dedup_rank_ceiling(vec![a, b]);
        assert_eq!(ids(&out), vec!["b"]);
        assert_eq!(out[0].last_chapter.as_deref(), Some("120"));
    }

    /// last_chapter None tidak ikut ceiling; yang punya angka menang.
    #[test]
    fn ceiling_none_tidak_ikut() {
        let a = m("komiku", "a", "X"); // last_chapter None
        let b = with_last(m("shinigami", "b", "X"), "55");
        let out = dedup_rank_ceiling(vec![a, b]);
        assert_eq!(ids(&out), vec!["b"]);
    }

    /// Non-numerik lebih baru TIDAK mengalahkan numerik (numerik tetap ceiling).
    #[test]
    fn ceiling_non_numerik_baru_kalah_numerik() {
        let mut a = with_last(m("komiku", "a", "X"), "extra"); // non-numerik
        a.updated_at = Some(9_999); // sangat baru
        let b = with_last(m("shinigami", "b", "X"), "50"); // numerik, lebih tua
        let out = dedup_rank_ceiling(vec![a, b]);
        assert_eq!(ids(&out), vec!["b"]);
    }

    /// Urutan input tidak mengubah hasil (deterministik).
    #[test]
    fn ceiling_deterministik_terhadap_urutan() {
        let a = with_last(m("komiku", "a", "X"), "100");
        let b = with_last(m("shinigami", "b", "X"), "120");
        let out1 = dedup_rank_ceiling(vec![a.clone(), b.clone()]);
        let out2 = dedup_rank_ceiling(vec![b, a]);
        assert_eq!(ids(&out1), ids(&out2));
        assert_eq!(ids(&out1), vec!["b"]);
    }

    /// Judul seri SAMA tapi beda tata kata lintas sumber -> merge (kunci
    /// kanonik): "A Disaster-Class Hero Has Returned" vs "The Return of The
    /// Disaster Class Hero". Pemenang = ceiling (keduanya 193 -> tie prioritas).
    #[test]
    fn ceiling_merge_seri_beda_tata_kata() {
        let a = with_last(m("komiku", "a", "A Disaster-Class Hero Has Returned"), "193");
        let b = with_last(m("shinigami", "b", "The Return of The Disaster Class Hero"), "193");
        let out = dedup_rank_ceiling(vec![a, b]);
        assert_eq!(out.len(), 1, "seri yang sama harus jadi satu kartu");
        assert_eq!(out[0].last_chapter.as_deref(), Some("193"));
    }

    /// Judul beda yang mirip TIDAK boleh merge.
    #[test]
    fn ceiling_tidak_merge_seri_beda_mirip() {
        let a = with_last(m("komiku", "a", "Return of the Monster Class Hero"), "10");
        let b = with_last(m("shinigami", "b", "Return of the Disaster Class Hero"), "10");
        let out = dedup_rank_ceiling(vec![a, b]);
        assert_eq!(out.len(), 2, "seri beda harus tetap dua kartu");
    }

    /// Memoize validasi tie: simpan lalu ambil balik (kunci kanonik, ceiling).
    #[test]
    fn tie_cache_simpan_dan_ambil() {
        let c = tie_validation_cache();
        c.lock().unwrap().insert(("x".into(), "193".into()), "handleA".into());
        let got = c.lock().unwrap().get(&("x".into(), "193".into())).cloned();
        assert_eq!(got.as_deref(), Some("handleA"));
    }

    /// Kartu crit: `last_chapter` memakai max lintas sumber sekunci kanonik.
    #[test]
    fn ceiling_kartu_search_pakai_max_lintas_sumber() {
        let a = with_last(m("komiku", "a", "Solo Leveling"), "100");
        let b = with_last(m("shinigami", "b", "Solo Leveling"), "105");
        let c = with_last(m("komiku", "c", "Solo Necromancy"), "9");
        let mut items = vec![a, b, c];
        apply_ceiling_last_chapter(&mut items);
        assert_eq!(items[0].last_chapter.as_deref(), Some("105"));
        assert_eq!(items[1].last_chapter.as_deref(), Some("105"));
        // seri beda tidak tersentuh
        assert_eq!(items[2].last_chapter.as_deref(), Some("9"));
    }
}
