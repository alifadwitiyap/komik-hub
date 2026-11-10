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

use crate::rank::{
    apply_ceiling_last_chapter, neighbor_refs, pick_union_neighbors, rank_cmp, source_priority,
    tie_validation_cache,
};
pub use crate::rank::{
    chapter_by_number, chapter_index_by_key, dedup_rank, dedup_rank_ceiling, rank_by_query,
    ChapterRef, Rankable,
};

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
// Varian `Ok` memang jauh lebih besar, tapi ini nilai sementara yang langsung
// dipakai lalu dibuang di jalur baca series — bukan koleksi jangka panjang.
// Boxing hanya menambah alokasi di hot path tanpa manfaat nyata.
#[allow(clippy::large_enum_variant)]
enum SeriesLoad {
    /// (manga, detail) — sumber terakses dan punya series-nya.
    Ok(Manga, SeriesDetail),
    /// Sumber terakses dan menyatakan "tidak ada" (resolve miss / 404).
    Miss,
    /// Sumber tidak bisa diakses (jaringan/429/timeout/parse).
    Inaccessible(SourceError),
}

/// Alasan sumber primary tidak melayani chapter. Dipakai untuk menyusun
/// catatan pindah sumber (`note`), dan `Empty`/`Inaccessible` juga memicu
/// percobaan ULANG ke sumber pelayan yang sama (adapter kadang transien):
/// `Missing` tidak, karena itu kesimpulan pasti.
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

// --------------------------------------------------------------- SortMode

/// Mode urutan daftar lintas sumber.
///
/// - `Latest`: recency (default; hasil merge `dedup_rank` apa adanya).
/// - `Rating`: rating tertinggi dulu, tie-break recency; item tanpa rating
///   jatuh ke recency (tak pernah kosong).
/// - `Trending`: rating di atas feed latest — urutan sama dengan `Rating`
///   (rating dulu, sisa recency), penamaan beda untuk frontend.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SortMode {
    Latest,
    Rating,
    Trending,
}

impl SortMode {
    /// Sufiks kunci cache: antar mode WAJIB beda biar tak ada hasil salah
    /// (cache tidak menyimpan mode, hanya set item yang sama).
    pub fn as_str(self) -> &'static str {
        match self {
            SortMode::Latest => "latest",
            SortMode::Rating => "rating",
            SortMode::Trending => "trending",
        }
    }

    /// Parsing `?sort=`. Tidak dikenal / kosong -> `Latest`. Case-insensitive.
    pub fn parse(s: Option<&str>) -> Self {
        match s.map(str::trim).filter(|s| !s.is_empty()) {
            Some(s) if s.eq_ignore_ascii_case("rating") => SortMode::Rating,
            Some(s) if s.eq_ignore_ascii_case("trending") => SortMode::Trending,
            _ => SortMode::Latest,
        }
    }
}

/// Parsing rating best-effort: string numerik ("9", "8.5", "10.0") -> f64.
/// Non-numerik / kosong -> None (lihat `merge_from`: field rating diisi dari
/// duplikat sumber lain, jadi nilai bisa beda sumber).
fn parse_rating(r: &Option<String>) -> Option<f64> {
    r.as_deref().and_then(|s| s.parse::<f64>().ok())
}

/// Urut daftar sesuai `SortMode`. `Latest` = no-op (hasil merge sudah recency).
/// `Rating`/`Trending`: rating tinggi dulu, tie-break recency (`rank_cmp`);
/// item tanpa rating jatuh ke recency — tak pernah kosong.
pub fn apply_sort(mut items: Vec<Manga>, sort: SortMode) -> Vec<Manga> {
    if matches!(sort, SortMode::Latest) {
        return items;
    }
    items.sort_by(compare_rating);
    items
}

/// Rating desc; tie-break recency (updated_at desc, lalu prioritas sumber).
fn compare_rating(a: &Manga, b: &Manga) -> std::cmp::Ordering {
    match (parse_rating(&a.rating), parse_rating(&b.rating)) {
        (Some(x), Some(y)) if x != y => {
            return x
                .partial_cmp(&y)
                .unwrap_or(std::cmp::Ordering::Equal)
                .reverse();
        }
        (Some(_), None) => return std::cmp::Ordering::Less,
        (None, Some(_)) => return std::cmp::Ordering::Greater,
        _ => {}
    }
    rank_cmp(a, b)
}

// --------------------------------------------------------------- Aggregator

#[derive(Clone)]
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
            Some(s) => {
                let known = self.sources.iter().any(|src| src.id().as_str() == s);
                if !known {
                    // Sumber tak dikenal / format salah (mis. "komiku,mangaku"):
                    // fallback SEMUA — jangan balik kosong (QA F1).
                    self.sources.clone()
                } else {
                    self.sources
                        .iter()
                        .filter(|src| src.id().as_str() == s)
                        .cloned()
                        .collect()
                }
            }
        }
    }

    pub fn known_sources(&self) -> Vec<String> {
        self.sources.iter().map(|s| s.id().to_string()).collect()
    }

    // ---------------------------------------------------------- merged list

    pub async fn popular(
        &self,
        page: u32,
        limit: u32,
        source: Option<&str>,
        sort: SortMode,
    ) -> Merged<Manga> {
        // Sort disematkan ke kunci: hasil per mode disimpan terpisah.
        let key = format!("popular:{page}:{}", sort.as_str());
        let mut merged = self
            .merged(&key, false, source, move |src| async move {
                src.popular(page).await
            })
            .await;
        merged.items = apply_sort(merged.items, sort);
        merged.truncate(limit)
    }

    pub async fn latest(
        &self,
        page: u32,
        limit: u32,
        source: Option<&str>,
        sort: SortMode,
    ) -> Merged<Manga> {
        // Sort disematkan ke kunci: kunci `latest` penuh = ceil + sort.
        let key = format!("latest:{page}:{}", sort.as_str());
        let full_key = self.cache_key("list", source, &format!("ceil:{key}"));

        let sources = self.filtered(source);
        let total = sources.len();
        if let Some(cache) = &self.cache {
            if let Some(hit) = cache.fresh_json::<Vec<Manga>>(&full_key) {
                return Merged {
                    items: apply_sort(hit, sort),
                    failures: vec![],
                    sources_total: total,
                    sources_ok: total,
                    from_cache: true,
                }
                .truncate(limit);
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

        let resolved = apply_sort(self.resolve_latest_feed(items).await, sort);
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
        out.sort_by(rank_cmp);
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
                    // Validasi tie: tanya SEMUA kandidat serentak, bukan satu
                    // per satu. Versi serial membayar N× round-trip upstream
                    // (tiap `series_resolve` = 1 request jaringan) padahal
                    // kandidatnya independen — jadi latency tie = jumlah, bukan
                    // maksimum. `JoinSet` menjaga urutan prioritas tetap
                    // deterministik: kandidat pertama (urutan `tied`, sudah
                    // terurut prioritas sumber) yang mengonfirmasi menang.
                    let mut set = tokio::task::JoinSet::new();
                    for (pos, &i) in tied.iter().enumerate() {
                        let handle = group[i].handle();
                        let want = chapter_number_key(&max_num);
                        let agg = self.clone();
                        set.spawn(async move {
                            let ok = match agg.series_resolve(&handle, 2000, None).await {
                                Ok(outcome) => outcome
                                    .detail
                                    .chapters
                                    .iter()
                                    .any(|c| chapter_number_key(&c.number) == want),
                                Err(_) => false,
                            };
                            (pos, i, ok)
                        });
                    }
                    let mut confirmed: Vec<(usize, usize)> = Vec::new();
                    while let Some(joined) = set.join_next().await {
                        if let Ok((pos, i, true)) = joined {
                            confirmed.push((pos, i));
                        }
                    }
                    confirmed.sort_unstable();
                    let winner_idx = match confirmed.first() {
                        Some(&(_, i)) => i,
                        None => tied.into_iter().reduce(|best, cur| {
                            let pb = source_priority(group[best].rank_source());
                            let pc = source_priority(group[cur].rank_source());
                            if pb <= pc { best } else { cur }
                        }).unwrap(),
                    };
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
        sort: SortMode,
    ) -> Merged<Manga> {
        let q = query.to_string();
        let key = format!("search:{page}:{q}:{}", sort.as_str());
        let mut merged = self
            .merged(&key, false, source, move |src| {
                let q = q.clone();
                async move { src.search(&q, page).await }
            })
            .await;
        let mut items = merged.items;
        // Ceiling: kartu search menunjuk sumber dengan episode TERBESAR —
        // `last_chapter` tiap kartu = max numerik lintas sumber sekunci kanonik.
        apply_ceiling_last_chapter(&mut items);
        let ranked = rank_by_query(items, query);
        merged.items = apply_sort(ranked, sort);
        merged.truncate(limit)
    }

    /// Search DUA FASE: kembalikan hasil sumber cepat sekarang, selesaikan
    /// sumber lambat di background lalu tulis ke cache.
    ///
    /// Kenapa: `index.komikid.org` (komiku) punya TTFB 5-9 s sementara
    /// shinigami 59 ms. Menunggu semua sumber berarti user menatap layar
    /// kosong selama sumber terlambat. Di sini sumber cepat langsung
    /// dikirim, dan `pending` memberi tahu client sumber mana yang masih
    /// diproses (client boleh panggil ulang; cache sudah terisi).
    ///
    /// Hasil fase 2 ditulis ke kunci cache yang SAMA dengan yang dibaca
    /// `search()`, jadi panggilan berikutnya murah tanpa jalur kode baru.
    pub async fn search_dua_fase(
        &self,
        query: &str,
        page: u32,
        limit: u32,
        source: Option<&str>,
        deadline: Duration,
        sort: SortMode,
    ) -> (Merged<Manga>, Vec<SourceId>) {
        let q = query.to_string();
        let key = format!("search:{page}:{q}:{}", sort.as_str());
        // Kunci HARUS identik dengan yang dipakai `merged()` (tanpa awalan
        // "list" ganda) supaya hasil fase 2 benar-benar dibaca `search()`.
        let list_key = self.cache_key("list", source, &key);

        let sources = self.filtered(source);
        let total = sources.len();

        // Fase 2 sebelumnya mungkin sudah selesai: sajikan cache penuh.
        if let Some(cache) = &self.cache {
            if let Some(hit) = cache.fresh_json::<Vec<Manga>>(&list_key) {
                let items = apply_sort(rank_by_query(hit, query), sort);
                return (
                    Merged {
                        items,
                        failures: vec![],
                        sources_total: total,
                        sources_ok: total,
                        from_cache: true,
                    }
                    .truncate(limit),
                    Vec::new(),
                );
            }
        }

        let call = {
            let q = q.clone();
            move |src: Arc<dyn Source>| {
                let q = q.clone();
                async move { src.search(&q, page).await }
            }
        };

        let (done, pending, mut rest) =
            self.join_sources_until(sources, call, deadline).await;

        let mut items: Vec<Manga> = Vec::new();
        let mut failures = Vec::new();
        let mut ok = 0usize;
        for res in done {
            match res {
                Ok((_, v)) => {
                    ok += 1;
                    items.extend(v);
                }
                Err(f) => failures.push(f),
            }
        }

        let merged = Merged {
            items: dedup_rank(items),
            failures,
            sources_total: total,
            sources_ok: ok,
            from_cache: false,
        };

        // Fase 2: selesaikan sisa sumber di background, lalu tulis cache.
        // Hasil fase 1 HARUS dibawa masuk: cache sengaja belum diisi saat
        // masih ada pending, jadi `fresh_json` di dalam task akan kosong dan
        // sumber cepat (shinigami/mangaku) hilang dari hasil akhir.
        if !rest.is_empty() {
            let cache = self.cache.clone();
            let list_key = list_key.clone();
            let q2 = q.clone();
            let phase1: Vec<Manga> = merged.items.clone();
            tokio::spawn(async move {
                let mut extra: Vec<Manga> = Vec::new();
                let mut got_any = false;
                while let Some(joined) = rest.join_next().await {
                    if let Ok(Ok((_, v))) = joined {
                        got_any = true;
                        extra.extend(v);
                    }
                }
                if !got_any {
                    return;
                }
                if let Some(cache) = cache {
                    // Gabung hasil fase 1 + sisa sumber.
                    let mut all: Vec<Manga> = phase1;
                    all.extend(extra);
                    let mut deduped = dedup_rank(all);
                    apply_ceiling_last_chapter(&mut deduped);
                    let ranked = apply_sort(rank_by_query(deduped, &q2), sort);
                    if let Err(e) = cache.set_json(&list_key, &ranked) {
                        eprintln!("⚠ cache fase-2 gagal ditulis ({list_key}): {e}");
                    }
                }
            });
        }

        let mut items = merged.items;
        apply_ceiling_last_chapter(&mut items);
        let ranked = apply_sort(rank_by_query(items, query), sort);
        (
            Merged { items: ranked, ..merged }.truncate(limit),
            pending,
        )
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
        sort: SortMode,
    ) -> Merged<Manga> {
        let q = query.to_string();
        let g = genre.to_string();
        let key = format!("search-genre:{page}:{q}:{g}:{}", sort.as_str());
        let mut merged = self
            .merged(
                &key,
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
        let ranked = apply_sort(rank_by_query(items, query), sort);
        merged.items = ranked;
        merged.truncate(limit)
    }

    /// Katalog + filter genre (slug/nama diteruskan ke sumber apa adanya).
    pub async fn list(
        &self,
        genre: Option<&str>,
        page: u32,
        limit: u32,
        source: Option<&str>,
        sort: SortMode,
    ) -> Merged<Manga> {
        let g = genre.map(|s| s.to_string());
        let key = format!("list:{page}:{}:{}", genre.unwrap_or("*"), sort.as_str());
        let mut merged = self
            .merged(
                &key,
                false,
                source,
                move |src| {
                    let g = g.clone();
                    async move { src.list(g.as_deref(), page).await }
                },
            )
            .await;
        merged.items = apply_sort(merged.items, sort);
        merged.truncate(limit)
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

        // Sumber pelayan di urutan PERTAMA: label nomornya menang dedup
        // ("09" tetap "09", bukan "9"), jadi kredit sumber di halaman series
        // mengikuti sumber yang benar-benar menyajikan series itu.
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
    /// 3. TIDAK ketemu (atau gambarnya kosong / tak bisa dipakai — keputusan 1)
    ///    -> sumber lain urut prioritas: resolve by JUDUL (exact `title_key`),
    ///    ambil series, cari chapter. Pertama yang punya menang;
    ///    `switched_from` + `note` diisi.
    /// 4. `prev`/`next` dihitung dari daftar chapter UNION lintas sumber
    ///    (urutan yang sama dengan halaman series), jadi chapter eksklusif
    ///    sumber lain tidak pernah dilompati. Dengan filter `--source`,
    ///    navigasi tetap di sumber yang diminta (tanpa fan-out).
    /// 5. Semua request sumber dibungkus timeout [`PER_SOURCE_TIMEOUT_SECS`].
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
                self.load_series_cached(id, src, &native, cap).await
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

            // Gambar chapter dari sumber ini. `None` = sumber punya nomornya
            // tapi GAGAL memberi gambar yang bisa dipakai, jadi chapter yang
            // ADA di daftar union tetap harus dicoba di sumber lain.
            //
            // Ada dua bentuk kegagalan yang keduanya berarti "tidak ada
            // gambar": adapter mem-`bail!` (komiku/shinigami/kiryuu untuk
            // daftar kosong), atau adapter "sukses" tapi URL-nya kosong
            // (base/path gagal disusun). Bentuk kedua dulu lolos karena
            // `images` tidak kosong, sehingga reader menerima URL sampah
            // padahal sumber lain punya nomor yang sama dengan gambar valid.
            let mut images: Option<Vec<String>> = None;
            // Sumber yang melayani ternyata transien -> boleh dicoba sekali
            // lagi sebelum pindah (lihat pemakaian di bawah).
            let mut retry_serving = false;
            for attempt in 0..2 {
                match tokio::time::timeout(self.timeout, src.chapter_pages(&manga, &chapter)).await {
                    Ok(Ok(pages)) => {
                        if has_usable_images(&pages) {
                            images = Some(pages.images);
                            break;
                        }
                        // Gambar kosong = trigger pindah sumber (keputusan 1);
                        // TIDAK di-cache sebagai "tidak ada" (bukan kesimpulan
                        // pasti). Percobaan pertama: ulangi sekali ke sumber
                        // yang sama, karena sumber ini TERBUKTI punya chapter
                        // dengan nomor itu — gambar kosong lebih sering
                        // transien daripada "chapter ini memang tanpa gambar".
                        // Tanpa retry, sumber pelayan yang sedang rewel bikin
                        // reader pindah ke sumber yang bahkan tidak punya
                        // nomornya.
                        if attempt == 0 {
                            retry_serving = true;
                            continue;
                        }
                        if idx == 0 {
                            primary_miss = Some(PrimaryMiss::Empty);
                        }
                    }
                    Ok(Err(e)) => {
                        let kind = SourceError::from(e);
                        if kind.is_inaccessible() {
                            inaccessible.push((sid.clone(), kind.clone()));
                            if attempt == 0 {
                                retry_serving = true;
                                continue;
                            }
                            if idx == 0 {
                                primary_miss = Some(PrimaryMiss::Inaccessible(kind));
                            }
                        } else if idx == 0 {
                            // Kesimpulan pasti dari sumber yang terakses.
                            primary_miss = Some(PrimaryMiss::Missing);
                        }
                    }
                    Err(_) => {
                        inaccessible.push((sid.clone(), SourceError::Timeout));
                        if attempt == 0 {
                            retry_serving = true;
                            continue;
                        }
                        if idx == 0 {
                            primary_miss = Some(PrimaryMiss::Inaccessible(SourceError::Timeout));
                        }
                    }
                }
                break;
            }

            if let Some(images) = images {
                let pages = ChapterPages {
                    source: sid.clone(),
                    title: chapter.title.clone(),
                    number: chapter.number.clone(),
                    images,
                };
                // Tetangga: SATU definisi dari daftar UNION lintas sumber
                // (urutan yang sama dengan halaman series), jadi chapter
                // eksklusif sumber lain tidak pernah dilompati. Tepi union =
                // `None` (tidak wrap-around).
                //
                // Syarat:
                // - Pemanggil TIDAK mempersempit sumber (`--source`): dengan
                //   filter, navigasi harus tetap di sumber yang diminta dan
                //   tidak boleh memicu fan-out.
                // - Daftar chapter sumber pelayan punya konteks urutan
                //   (>1 chapter). Daftar 1 chapter tidak memberi tahu apakah
                //   itu tepi atas atau tepi bawah, jadi tak ada yang bisa
                //   ditaruh di union — dan tidak perlu request tambahan.
                let (local_prev, local_next) = neighbor_refs(&detail, pos);
                let (prev, next) = if source.is_some() || detail.chapters.len() <= 1 {
                    (local_prev, local_next)
                } else {
                    let (others, _failed) = self
                        .collect_series_across_sources(
                            &manga.title,
                            Some(&sid),
                            CROSS_SOURCE_CHAPTER_LIMIT,
                        )
                        .await;
                    // Urutan daftar menentukan LABEL pemenang dedup saat satu
                    // nomor ada di beberapa sumber ("01" vs "1"). Kalau daftar
                    // sumber PELAYAN ditaruh pertama, label yang menang
                    // bergantung pada chapter mana yang sedang dibuka — halaman
                    // series menampilkan "1" (shinigami) sementara tombol
                    // Berikutnya di chapter lain menampilkan "01" (komiku)
                    // untuk chapter yang SAMA.
                    //
                    // Karena itu urutan ditetapkan oleh SOURCE_PRIORITY, bukan
                    // oleh sumber pelayan: hasilnya identik dengan
                    // `series_merged` (yang juga mengurutkan menurut prioritas),
                    // jadi halaman series dan navigasi reader selalu sepakat.
                    //
                    // PENTING: sumber pelayan WAJIB ikut di daftar. Kalau ia
                    // dibuang (perilaku lama), union hanya berisi sumber LAIN
                    // sehingga chapter yang dilayani sumber pelayan sendiri
                    // bisa "hilang" dari perhitungan tetangga.
                    // Sumber pelayan di urutan PERTAMA (label nomornya menang
                    // dedup, sama seperti `series_merged`), jadi label chapter
                    // di reader identik dengan yang tampil di halaman series
                    // untuk series yang sama.
                    let primary_list = crate::union::SourceChapterList {
                        source: sid.clone(),
                        handle: manga.handle(),
                        chapters: detail.chapters.clone(),
                    };
                    let mut lists = Vec::with_capacity(others.len() + 1);
                    lists.push(primary_list);
                    lists.extend(others);
                    let merged = crate::union::merge_chapter_lists(&lists);
                    let (union_prev, union_next) =
                        pick_union_neighbors(&merged, &chapter.number);
                    // Guard pemotongan: `cap` memotong dari yang PALING TUA,
                    // jadi tepi ATAS selalu jujur (`next` aman), tapi tepi
                    // BAWAH bisa jadi artefak — sumber pelayan mungkin punya
                    // chapter lebih tua yang kita buang, dan itu bisa lebih
                    // dekat daripada kandidat sumber lain. Kalau daftar
                    // pelayan (mungkin) terpotong DAN dia tidak punya prev
                    // lokal, jangan menebak: `None` (perilaku lama).
                    let truncated = detail.chapters.len() >= cap;
                    let prev = if truncated && local_prev.is_none() {
                        None
                    } else {
                        union_prev
                    };
                    (prev, union_next)
                };
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
                // Warm cache series untuk saudara chapter lain. Tulis HANYA
                // saat sumber pelayan = sumber handle (kunci `series:*:{id}:
                // {native}` valid) dan daftar TIDAK terpotong (cap=2000 di
                // server; jika terpotong, menulis versi pendek ke cache
                // series yang dipakai bareng endpoint series akan mencemari
                // navigasi prev/next-nya).
                if handle_sid.as_ref() == Some(&sid) && detail.chapters.len() < cap {
                    self.cache_put(
                        &self.cache_key("series", None, &format!("{id}:{native}")),
                        &detail,
                    );
                }
                self.cache_put(&read_key, &outcome);
                return Ok(outcome);
            }

            // Sumber punya nomornya tapi gambarnya tetap tak terpakai: lanjut
            // ke sumber berikutnya. `retry_serving` sengaja dibiarkan agar
            // penanda `note` tetap jujur (bukan "tidak ada di primary").
            let _ = retry_serving;
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
    /// Versi cache-aware dari [`Aggregator::load_series`] untuk jalur baca
    /// chapter. Sumber primary (`handle_sid == sid`) memakai KUNCI cache yang
    /// SAMA dengan `series_resolve_pref` (`series:*:{id}:{native}`), jadi
    /// kunjungan series sebelumnya (atau baca chapter lain yang berhasil)
    /// sudah mengisi disk cache ini; baca chapter berikutnya tidak membayar
    /// ulang fetch upstream series primary (terukur ~2s) demi murni
    /// menghitung prev/next. Fix: mempercepat chapter COLD tanpa menambah
    /// fan-out.
    ///
    /// CATATAN: fungsi ini hanya MEMBACA cache; penulisan ke cache series
    /// dilakukan di `read_chapter_any` HANYA saat chapter berhasil dibaca
    /// (bukan saat chapter tidak ada — itu akan mencemari cache series yang
    /// dipakai bareng endpoint series).
    async fn load_series_cached(
        &self,
        id: &str,
        src: &Arc<dyn Source>,
        native: &str,
        cap: usize,
    ) -> SeriesLoad {
        // Kunci sama persis dengan `series_resolve_pref` (`series:*:{id}:{native}`
        // — `source` dibiarkan None supaya ketemu cache yang ditulis endpoint
        // series). `*-` pada handle/native dipertahankan.
        let key = self.cache_key("series", None, &format!("{id}:{native}"));
        if let Some(cache) = &self.cache {
            if let Some(detail) = cache.fresh_json::<SeriesDetail>(&key) {
                let mut detail = detail;
                detail.chapters.truncate(cap);
                return SeriesLoad::Ok(detail.manga.clone(), detail);
            }
        }
        self.load_series(src, native, cap).await
    }

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

    /// Kunci penanda negatif untuk sumber yang GAGAL (bukan "tidak ada")
    /// saat pengumpulan union `series-union:{title_key}`.
    ///
    /// Sengaja memakai `title_key`, bukan handle: panggilan berikutnya datang
    /// dengan judul/handle berbeda (chapter request vs halaman series) tapi
    /// `title_key`-nya sama, dan justru itu yang mau dilewati.
    fn neg_union_key(&self, tkey: &str, sid: &SourceId) -> String {
        format!("neg-union:{tkey}:{}", sid.as_str())
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

    /// Seperti [`Aggregator::neg_put`], tapi menyimpan PESAN kegagalan, bukan
    /// `true`. Dipakai penanda `neg-union`: panggilan warm melewati sumbernya
    /// tapi tetap bisa melaporkannya di `failed` dengan alasan yang sama
    /// seperti saat cold (bukan "hilang diam-diam" dari `failed_sources`).
    fn neg_put_msg(&self, key: &str, msg: &str) {
        if let Some(cache) = &self.cache {
            if let Err(e) = cache.set_negative(key, serde_json::json!(msg)) {
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

    /// Seperti [`Aggregator::join_sources`], tapi berhenti menunggu setelah
    /// `deadline` dan mengembalikan sisa task yang BELUM selesai.
    ///
    /// Dipakai mode dua fase: user dapat hasil sumber cepat lebih dulu, sisa
    /// sumber diselesaikan di background lalu ditulis ke cache, dan panggilan
    /// berikutnya untuk kunci yang sama langsung instan.
    ///
    /// Task yang di-detach TETAP berjalan sampai selesai (bukan dibatalkan) —
    /// itu intinya: pekerjaan lambat tidak hilang, hanya tidak ditunggu.
    #[allow(clippy::type_complexity)]
    async fn join_sources_until<T, F, Fut>(
        &self,
        sources: Vec<Arc<dyn Source>>,
        call: F,
        deadline: Duration,
    ) -> (
        Vec<Result<(Arc<dyn Source>, T), (SourceId, String)>>,
        Vec<SourceId>,
        tokio::task::JoinSet<Result<(Arc<dyn Source>, T), (SourceId, String)>>,
    )
    where
        T: Send + 'static,
        F: Fn(Arc<dyn Source>) -> Fut + Clone + Send + Sync + 'static,
        Fut: std::future::Future<Output = SourceResult<T>> + Send + 'static,
    {
        let timeout = self.timeout;
        let mut set = tokio::task::JoinSet::new();
        let mut all_ids: Vec<SourceId> = Vec::new();
        for src in sources {
            all_ids.push(src.id());
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
        let until = tokio::time::Instant::now() + deadline;
        while !set.is_empty() {
            let left = until.saturating_duration_since(tokio::time::Instant::now());
            if left.is_zero() {
                break;
            }
            match tokio::time::timeout(left, set.join_next()).await {
                Ok(Some(Ok(r))) => out.push(r),
                Ok(Some(Err(e))) => {
                    out.push(Err((SourceId::from("?"), format!("task gagal: {e}"))))
                }
                Ok(None) => break,
                Err(_) => break, // deadline habis
            }
        }
        // Sumber yang belum melapor = masih berjalan di `set`.
        let mut pending: Vec<SourceId> = all_ids
            .into_iter()
            .filter(|id| !out.iter().any(|r| match r {
                Ok((src, _)) => &src.id() == id,
                Err((eid, _)) => eid == id,
            }))
            .collect();
        pending.sort_by_key(|s| s.as_str().to_string());
        pending.dedup();
        (out, pending, set)
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
    /// - Sumber yang gagal juga ditandai negatif TTL pendek
    ///   (`neg-union:{title_key}:{sumber}`, `cache::NEGATIVE_TTL`) supaya
    ///   panggilan WARM berikutnya tidak mengulang fetch sumber yang sama.
    ///   Tanpa itu cache per-sumber selalu bolong satu sumber dan setiap
    ///   request membayar ulang HTTP-nya (terukur 470-517 ms untuk kiryuu).
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
        // (`skip_source`), yang sudah ada di cache, dan yang sedang ditandai
        // GAGAL oleh percobaan sebelumnya (`neg-union:{title_key}:{sumber}`).
        // Penanda itu TTL pendek (`cache::NEGATIVE_TTL`), jadi sumber yang
        // pulih kembali diikutkan lagi paling lama 60 detik kemudian.
        let skip_id = skip_source.cloned();
        let mut failed: Vec<(SourceId, String)> = Vec::new();
        let mut targets: Vec<Arc<dyn Source>> = Vec::new();
        for s in &self.sources {
            let sid = s.id();
            if Some(&sid) == skip_id.as_ref() || by_source.contains_key(sid.as_str()) {
                continue;
            }
            // Sumber yang ditandai gagal tetap DILAPORKAN di `failed` (dengan
            // pesan aslinya) tapi TIDAK di-fetch lagi — itulah inti Fix D.
            // Tanpa pelaporan ini `failed_sources` jadi kosong saat warm dan
            // klien kehilangan sinyal "sumber ini sedang bermasalah".
            match self
                .cache
                .as_ref()
                .and_then(|c| c.fresh_json::<String>(&self.neg_union_key(&tkey, &sid)))
            {
                Some(msg) => failed.push((sid, msg)),
                None => targets.push(s.clone()),
            }
        }
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
                    Err((sid, msg)) => {
                        // Gagal = sumber tak terakses / error sementara.
                        // Tandai negatif TTL pendek supaya warm tidak
                        // mengulang fetch sumber yang sama; pesannya ikut
                        // disimpan agar `failed` tetap jujur saat warm.
                        self.neg_put_msg(&self.neg_union_key(&tkey, &sid), &msg);
                        failed.push((sid, msg));
                    }
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
                        Err((sid, msg)) => {
                            // Sama seperti tahap 1: kegagalan sementara
                            // ditandai negatif TTL pendek (Fix D).
                            self.neg_put_msg(&self.neg_union_key(&tkey, &sid), &msg);
                            failed.push((sid, msg));
                        }
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


fn unique_sources(list: &[String]) -> Vec<String> {
    let mut seen = HashSet::new();
    list.iter()
        .filter(|s| !s.is_empty() && seen.insert(s.as_str()))
        .cloned()
        .collect()
}

/// Batas chapter per sumber saat mencari tetangga LINTAS sumber.
///
/// 0 = tanpa pemotongan: daftar chapter sumber lain dipakai utuh supaya
/// kandidat terdekat (mis. "233" dari "232") tak terpotong.
const CROSS_SOURCE_CHAPTER_LIMIT: u32 = 0;

/// Minimal satu URL gambar yang benar-benar bisa dipakai?
///
/// `images.is_empty()` saja tidak cukup: adapter yang menyusun URL dari
/// `base_url` + `path` yang gagal bisa mengembalikan daftar BERISI string
/// kosong. Itu bukan gambar — menganggapnya sukses berarti reader menerima
/// URL sampah padahal sumber lain punya nomor chapter yang sama dengan gambar
/// valid. Jadi "gagal memberi gambar" = tak ada satu pun URL non-kosong.
fn has_usable_images(pages: &ChapterPages) -> bool {
    pages.images.iter().any(|u| !u.trim().is_empty())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::source::Source;
    use std::sync::atomic::{AtomicUsize, Ordering};

    /// Stub sumber satu-satunya untuk tes cache series chapter: `series()`
    /// menghitung berapa kali benar-benar dipanggil (upstream), dan selalu
    /// mengembalikan daftar 60 chapter.
    struct StubSource {
        series_calls: Arc<AtomicUsize>,
    }
    #[async_trait::async_trait]
    impl Source for StubSource {
        fn id(&self) -> SourceId {
            SourceId::from("stub")
        }
        async fn popular(&self, _p: u32) -> SourceResult<Vec<Manga>> {
            Ok(vec![])
        }
        async fn latest(&self, _p: u32) -> SourceResult<Vec<Manga>> {
            Ok(vec![])
        }
        async fn search(&self, _q: &str, _p: u32) -> SourceResult<Vec<Manga>> {
            Ok(vec![])
        }
        async fn list(&self, _g: Option<&str>, _p: u32) -> SourceResult<Vec<Manga>> {
            Ok(vec![])
        }
        async fn genres(&self) -> SourceResult<Vec<(String, String)>> {
            Ok(vec![])
        }
        async fn series(&self, native_id: &str) -> SourceResult<SeriesDetail> {
            self.series_calls.fetch_add(1, Ordering::SeqCst);
            let manga = Manga::new(SourceId::from("stub"), native_id, "Judul Stub");
            let chapters = (1..=60)
                .map(|i| Chapter {
                    source: SourceId::from("stub"),
                    native_id: format!("ch{i}"),
                    title: format!("Chapter {i}"),
                    number: i.to_string(),
                    updated_at: None,
                    url: None,
                })
                .collect();
            Ok(SeriesDetail { manga, chapters })
        }
        async fn chapter_pages(&self, _m: &Manga, _c: &Chapter) -> SourceResult<ChapterPages> {
            Ok(ChapterPages {
                source: SourceId::from("stub"),
                title: String::new(),
                number: "0".into(),
                images: vec![],
            })
        }
    }

    #[tokio::test]
    async fn load_series_cached_reuses_series_cache() {
        let calls = Arc::new(AtomicUsize::new(0));
        let stub = Arc::new(StubSource {
            series_calls: calls.clone(),
        });
        let src: Arc<dyn Source> = stub.clone();
        let agg = Aggregator::with_cache(
            vec![src.clone()],
            Cache::memory(crate::cache::DEFAULT_TTL),
        )
        .with_timeout(Duration::from_secs(5));

        // Seb BI cache series dulu — persis seperti yang dilakukan endpoint
        // series (`series_resolve_pref`) saat ada kunjungan series sebelum
        // baca chapter. Kunci `series:*:{id}:{native}`.
        let manga = Manga::new(SourceId::from("stub"), "native1", "Judul Stub");
        let chapters = (1..=60)
            .map(|i| Chapter {
                source: SourceId::from("stub"),
                native_id: format!("ch{i}"),
                title: format!("Chapter {i}"),
                number: i.to_string(),
                updated_at: None,
                url: None,
            })
            .collect();
        let detail = SeriesDetail { manga, chapters };
        agg.cache_put(
            &agg.cache_key("series", None, &format!("stub:native1:native1")),
            &detail,
        );

        // Panggilan kedua: HIT cache -> upstream TIDAK dipanggil.
        let second = agg.load_series_cached("stub:native1", &src, "native1", 50).await;
        assert!(matches!(second, SeriesLoad::Ok(_, _)));
        assert_eq!(calls.load(Ordering::SeqCst), 0, "hit cache, tanpa upstream");
        // Hasil di-truncate ke cap.
        let SeriesLoad::Ok(_, detail) = second else { unreachable!() };
        assert_eq!(detail.chapters.len(), 50);
    }
}

/// Tambah sumber ke daftar urutan kalau belum ada (dedup by SourceId).
fn push_unique(list: &mut Vec<Arc<dyn Source>>, src: Arc<dyn Source>) {
    if !list.iter().any(|s| s.id() == src.id()) {
        list.push(src);
    }
}

