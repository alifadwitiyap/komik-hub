//! Unit test deterministik aggregator + cache. Semua pakai MOCK Source
//! (fixture hardcoded), TIDAK ada network.
//!
//! Cakupan: dedup exact-title, rank recency (+ tiebreak SOURCE_PRIORITY),
//! partial failure (error & timeout), fallback series/read lintas sumber,
//! chapter resolve by number, genre union, cache TTL expiry (memory + disk),
//! adapter stub tetap hijau.
use komik_core::adapters::all_sources;
use komik_core::aggregator::*;
use komik_core::cache::{Cache, DiskCache, DEFAULT_TTL, NEGATIVE_TTL};
use komik_core::model::*;
use komik_core::source::{Source, SourceResult};
use serde_json::Value;
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::Duration;

// -------------------------------------------------------------------- mocks

/// Mock sumber: sukses/error/timeout per operasi, semua fixture di-hardcode.
struct Mock {
    id: SourceId,
    popular_items: Vec<Manga>,
    search_items: Vec<Manga>,
    genre_items: Vec<(String, String)>,
    series_detail: Option<SeriesDetail>,
    series_chapters: Vec<Chapter>,
    pages_result: Option<ChapterPages>,
    /// Flag "operasi ini error".
    err_search: bool,
    err_genres: bool,
    err_series: bool,
    err_pages: bool,
    delay: Duration,
    resolve_calls: Arc<AtomicUsize>,
    series_calls: Arc<AtomicUsize>,
}

impl Mock {
    fn new(id: &str) -> Self {
        Mock {
            id: SourceId::from(id),
            popular_items: vec![],
            search_items: vec![],
            genre_items: vec![],
            series_detail: None,
            series_chapters: vec![],
            pages_result: None,
            err_search: false,
            err_genres: false,
            err_series: false,
            err_pages: false,
            delay: Duration::ZERO,
            resolve_calls: Arc::new(AtomicUsize::new(0)),
            series_calls: Arc::new(AtomicUsize::new(0)),
        }
    }

    fn with_popular(mut self, items: Vec<Manga>) -> Self {
        self.popular_items = items;
        self
    }
    fn with_search(mut self, items: Vec<Manga>) -> Self {
        self.search_items = items;
        self
    }
    fn with_genres(mut self, items: Vec<(String, String)>) -> Self {
        self.genre_items = items;
        self
    }
    fn with_series(mut self, mut detail: SeriesDetail) -> Self {
        // Chapter fixture opsional; kalau ada, override isi detail.
        if detail.chapters.is_empty() {
            detail.chapters = self.series_chapters.clone();
        }
        self.series_detail = Some(detail);
        self
    }
    fn with_pages(mut self, pages: ChapterPages) -> Self {
        self.pages_result = Some(pages);
        self
    }
    fn delay(mut self, d: Duration) -> Self {
        self.delay = d;
        self
    }
    /// Semua operasi gagal (sumber mati total).
    fn erroring(mut self) -> Self {
        self.err_search = true;
        self.err_genres = true;
        self.err_series = true;
        self.err_pages = true;
        self
    }
    /// Hanya `series` yang gagal (search/pages tetap jalan) — dipakai untuk
    /// menguji fallback lintas sumber.
    fn series_error(mut self) -> Self {
        self.err_series = true;
        self
    }
    fn series_calls(&self) -> usize {
        self.series_calls.load(Ordering::SeqCst)
    }
    fn resolve_calls(&self) -> usize {
        self.resolve_calls.load(Ordering::SeqCst)
    }
}

async fn maybe_sleep(d: Duration) {
    if !d.is_zero() {
        tokio::time::sleep(d).await;
    }
}

#[async_trait::async_trait]
impl Source for Mock {
    fn id(&self) -> SourceId {
        self.id.clone()
    }
    async fn popular(&self, _page: u32) -> SourceResult<Vec<Manga>> {
        Ok(self.popular_items.clone())
    }
    async fn latest(&self, _page: u32) -> SourceResult<Vec<Manga>> {
        Ok(vec![])
    }
    async fn search(&self, _q: &str, _page: u32) -> SourceResult<Vec<Manga>> {
        maybe_sleep(self.delay).await;
        if self.err_search {
            anyhow::bail!("mock {}: search gagal", self.id);
        }
        Ok(self.search_items.clone())
    }
    async fn list(&self, _g: Option<&str>, _page: u32) -> SourceResult<Vec<Manga>> {
        Ok(self.popular_items.clone())
    }
    async fn genres(&self) -> SourceResult<Vec<(String, String)>> {
        if self.err_genres {
            anyhow::bail!("mock {}: genres gagal", self.id);
        }
        Ok(self.genre_items.clone())
    }
    async fn series(&self, _native_id: &str) -> SourceResult<SeriesDetail> {
        self.series_calls.fetch_add(1, Ordering::SeqCst);
        self.resolve_calls.fetch_add(1, Ordering::SeqCst);
        if self.err_series {
            anyhow::bail!("mock {}: series gagal", self.id);
        }
        match &self.series_detail {
            Some(d) => Ok(d.clone()),
            None => Ok(SeriesDetail {
                manga: Manga::new(self.id.clone(), "m1", "Mock"),
                chapters: vec![],
            }),
        }
    }
    async fn chapter_pages(&self, _m: &Manga, _c: &Chapter) -> SourceResult<ChapterPages> {
        maybe_sleep(self.delay).await;
        if self.err_pages {
            anyhow::bail!("mock {}: chapter_pages gagal", self.id);
        }
        match &self.pages_result {
            Some(p) => Ok(p.clone()),
            None => Ok(ChapterPages {
                source: self.id.clone(),
                title: "Mock".into(),
                number: _c.number.clone(),
                images: vec![],
            }),
        }
    }
    async fn resolve(&self, title: &str) -> SourceResult<Option<Manga>> {
        self.resolve_calls.fetch_add(1, Ordering::SeqCst);
        if self.err_search {
            anyhow::bail!("mock {}: resolve gagal", self.id);
        }
        let key = title_key(title);
        let hits = self.search(title, 1).await?;
        Ok(hits.into_iter().find(|m| m.title_key == key))
    }
}

// ---------------------------------------------------------------- fixtures

fn manga(src: &str, id: &str, title: &str, updated: Option<i64>) -> Manga {
    let mut m = Manga::new(SourceId::from(src), id, title);
    m.updated_at = updated;
    m
}

fn chapter(src: &str, native_id: &str, number: &str) -> Chapter {
    Chapter {
        source: SourceId::from(src),
        native_id: native_id.into(),
        title: format!("Chapter {number}"),
        number: number.into(),
        updated_at: Some(10),
        url: None,
    }
}

fn detail(src: &str, native_id: &str, title: &str, chapters: Vec<Chapter>) -> SeriesDetail {
    SeriesDetail {
        manga: manga(src, native_id, title, Some(10)),
        chapters,
    }
}

fn pages(src: &str, title: &str, number: &str, urls: &[&str]) -> ChapterPages {
    ChapterPages {
        source: SourceId::from(src),
        title: title.into(),
        number: number.into(),
        images: urls.iter().map(|s| s.to_string()).collect(),
    }
}

fn cache_value(agg: &Aggregator, key: &str) -> Option<Value> {
    agg.cache().and_then(|c| c.fresh(key))
}

/// Clock uji yang bisa dimajukan (Clock menangkap Arc, bukan salinan u64).
fn test_clock(start: u64) -> (Cache, Arc<AtomicU64>) {
    let cell = Arc::new(AtomicU64::new(start));
    let c = cell.clone();
    (
        Cache::memory_with_clock(
            DEFAULT_TTL,
            std::sync::Arc::new(move || c.load(Ordering::SeqCst)),
        ),
        cell,
    )
}

fn test_disk_clock(dir: &std::path::Path, start: u64) -> (DiskCache, Arc<AtomicU64>) {
    let cell = Arc::new(AtomicU64::new(start));
    let c = cell.clone();
    (
        DiskCache::with_clock(
            dir,
            DEFAULT_TTL,
            std::sync::Arc::new(move || c.load(Ordering::SeqCst)),
        ),
        cell,
    )
}

// ------------------------------------------------------------------- tests

#[tokio::test]
async fn dedup_exact_title_keeps_most_recent_update() {
    // Judul sama setelah normalisasi (kapital + tanda baca beda).
    let agg = Aggregator::new(vec![
        Arc::new(Mock::new("komiku").with_popular(vec![
            manga("komiku", "c1", "Naruto", Some(1000)),
            manga("komiku", "o1", "Bleach", Some(2000)),
        ])),
        Arc::new(Mock::new("mangaku").with_popular(vec![manga("mangaku", "m1", "naruto", Some(3000))])),
        Arc::new(Mock::new("kiryuu").with_popular(vec![manga("kiryuu", "k1", "NARUTO!", Some(500))])),
    ]);
    let merged = agg.popular(1, 50, None).await;

    let titles: Vec<&str> = merged.items.iter().map(|m| m.title.as_str()).collect();
    // Perwakilan grup naruto = judul milik entry terbaru (mangaku "naruto"),
    // judul aslinya dipertahankan — bukan judul dari sumber prioritas.
    assert_eq!(titles, vec!["naruto", "Bleach"], "dedup + rank: naruto (3000) di atas bleach (2000)");
    let naruto = merged.items.iter().find(|m| m.title == "naruto").unwrap();
    assert_eq!(naruto.source.as_str(), "mangaku", "perwakilan = updated_at terbaru");
    assert_eq!(naruto.native_id, "m1");
    assert_eq!(naruto.updated_at, Some(3000));
    assert!(merged.failures.is_empty());
}

#[tokio::test]
async fn merge_from_fills_missing_fields_from_duplicates() {
    let mut covered = manga("komiku", "c1", "Solo Leveling", Some(100));
    covered.cover_url = Some("https://cover/1.jpg".into());
    covered.author = Some("Chugong".into());
    covered.status = Some("Ongoing".into());
    let bare = manga("kiryuu", "k1", "Solo Leveling!", Some(9_999));

    let agg = Aggregator::new(vec![
        Arc::new(Mock::new("komiku").with_search(vec![covered])),
        Arc::new(Mock::new("kiryuu").with_search(vec![bare])),
    ]);
    let merged = agg.search("solo leveling", 1, 10, None).await;
    assert_eq!(merged.items.len(), 1);
    let m = &merged.items[0];
    // kiryuu menang recency, tapi metadata dari komiku ikut melengkapi.
    assert_eq!(m.source.as_str(), "kiryuu");
    assert_eq!(m.cover_url.as_deref(), Some("https://cover/1.jpg"));
    assert_eq!(m.author.as_deref(), Some("Chugong"));
    assert_eq!(m.status.as_deref(), Some("Ongoing"));
}

#[tokio::test]
async fn rank_recency_desc_with_none_last() {
    let agg = Aggregator::new(vec![Arc::new(Mock::new("komiku").with_popular(vec![
        manga("komiku", "a", "Alpha", Some(100)),
        manga("komiku", "b", "Beta", None),
        manga("komiku", "c", "Gamma", Some(300)),
        manga("komiku", "d", "Delta", Some(200)),
    ]))]);
    let merged = agg.popular(1, 50, None).await;
    let order: Vec<&str> = merged.items.iter().map(|m| m.title.as_str()).collect();
    assert_eq!(order, vec!["Gamma", "Delta", "Alpha", "Beta"], "None paling bawah");
}

#[tokio::test]
async fn tiebreak_source_priority_when_recency_equal() {
    let same = 1_700_000_000_000i64;
    let agg = Aggregator::new(vec![
        Arc::new(Mock::new("kiryuu").with_popular(vec![manga("kiryuu", "k1", "Same Title", Some(same))])),
        Arc::new(Mock::new("komiku").with_popular(vec![manga("komiku", "c1", "Same Title", Some(same))])),
        Arc::new(Mock::new("shinigami").with_popular(vec![manga("shinigami", "s1", "Same Title", Some(same))])),
    ]);
    let merged = agg.popular(1, 50, None).await;
    assert_eq!(merged.items.len(), 1, "dedup jadi satu");
    assert_eq!(merged.items[0].source.as_str(), "komiku", "komiku > mangaku > shinigami > kiryuu");
}

#[tokio::test]
async fn title_key_normalization() {
    assert_eq!(title_key("Solo Leveling!"), "solo leveling");
    assert_eq!(title_key("Tate  no Yuusha"), "tate no yuusha");
    assert_eq!(title_key("  Kimetsu no Yaiba  "), "kimetsu no yaiba");
    assert_ne!(title_key("Naruto"), title_key("Naruto Shippuden"));
}

#[tokio::test]
async fn partial_failure_reports_source_and_keeps_results() {
    let agg = Aggregator::new(vec![
        Arc::new(Mock::new("komiku").with_search(vec![manga("komiku", "c1", "One Piece", Some(1))])),
        Arc::new(Mock::new("mangaku").erroring()),
        Arc::new(Mock::new("kiryuu").erroring()),
    ]);
    let merged = agg.search("one", 1, 50, None).await;

    assert_eq!(merged.items.len(), 1, "hasil sukses tetap dikembalikan");
    assert_eq!(merged.failures.len(), 2);
    let failed: Vec<&str> = merged.failures.iter().map(|(s, _)| s.as_str()).collect();
    assert_eq!(failed, vec!["mangaku", "kiryuu"]);
    assert_eq!(merged.sources_total, 3);
    assert_eq!(merged.sources_ok, 1);
    assert!(!merged.all_failed());
    let warning = merged.warning().expect("harus ada peringatan");
    assert!(warning.starts_with("⚠ 2/3"), "warning: {warning}");
}

#[tokio::test]
async fn all_sources_failed_differs_from_empty_result() {
    let all_bad = Aggregator::new(vec![
        Arc::new(Mock::new("komiku").erroring()),
        Arc::new(Mock::new("kiryuu").erroring()),
    ]);
    let merged = all_bad.search("x", 1, 50, None).await;
    assert!(merged.items.is_empty());
    assert!(merged.all_failed());

    let empty_ok = Aggregator::new(vec![Arc::new(Mock::new("komiku"))]);
    let merged2 = empty_ok.search("x", 1, 50, None).await;
    assert!(merged2.items.is_empty());
    assert!(!merged2.all_failed(), "hasil kosong != semua sumber gagal");
    assert!(merged2.warning().is_none());
}

#[tokio::test]
async fn timeout_source_counts_as_failure() {
    let agg = Aggregator::new(vec![
        Arc::new(Mock::new("komiku").with_search(vec![manga("komiku", "c1", "Quick", Some(1))])),
        Arc::new(Mock::new("mangaku").delay(Duration::from_secs(30))),
        Arc::new(Mock::new("kiryuu").erroring()),
    ])
    .with_timeout(Duration::from_millis(120));

    let merged = agg.search("q", 1, 50, None).await;
    assert_eq!(merged.items.len(), 1);
    assert_eq!(merged.failures.len(), 2);
    let (src, msg) = merged.failures.iter().find(|(s, _)| s.as_str() == "mangaku").unwrap();
    assert_eq!(src.as_str(), "mangaku");
    assert!(msg.contains("timeout"), "pesan timeout: {msg}");
}

#[tokio::test]
async fn source_filter_narrows_fanout() {
    let agg = Aggregator::new(vec![
        Arc::new(Mock::new("komiku").with_search(vec![manga("komiku", "c1", "A", Some(1))])),
        Arc::new(Mock::new("kiryuu").with_search(vec![manga("kiryuu", "k1", "B", Some(2))])),
    ]);
    let merged = agg.search("q", 1, 50, Some("kiryuu")).await;
    assert_eq!(merged.items.len(), 1);
    assert_eq!(merged.items[0].source.as_str(), "kiryuu");
    assert_eq!(merged.sources_total, 1);
    assert_eq!(agg.known_sources(), vec!["komiku", "kiryuu"]);
}

#[tokio::test]
async fn genres_union_dedup_case_insensitive_with_source_badge() {
    let agg = Aggregator::new(vec![
        Arc::new(Mock::new("komiku").with_genres(vec![
            ("Action".into(), "Action".into()),
            ("Romance".into(), "Romance".into()),
        ])),
        Arc::new(Mock::new("kiryuu").with_genres(vec![
            ("action".into(), "Aksi".into()),
            ("Horror".into(), "Horror".into()),
        ])),
    ]);
    let merged = agg.genres(None).await;
    assert_eq!(merged.items.len(), 3, "dedup slug case-insensitive");
    let action = merged.items.iter().find(|r| r.slug.eq_ignore_ascii_case("action")).unwrap();
    assert_eq!(action.name, "Action", "nama sumber pertama menang");
    assert_eq!(action.sources, vec!["komiku", "kiryuu"], "badge sumber per baris");
}

#[tokio::test]
async fn genres_partial_failure_keeps_other_sources() {
    let agg = Aggregator::new(vec![
        Arc::new(Mock::new("komiku").with_genres(vec![("Isekai".into(), "Isekai".into())])),
        Arc::new(Mock::new("mangaku").erroring()),
    ]);
    let merged = agg.genres(None).await;
    assert_eq!(merged.items.len(), 1);
    assert_eq!(merged.failures.len(), 1);
    assert!(merged.warning().unwrap().contains("1/2"));
}

#[tokio::test]
async fn series_primary_source_from_handle() {
    let komiku = Mock::new("komiku")
        .with_series(detail("komiku", "k1", "Naruto", vec![
            chapter("komiku", "1", "1"),
            chapter("komiku", "2", "2"),
        ]));
    let kiryuu_calls = komiku.resolve_calls();
    let agg = Aggregator::new(vec![
        Arc::new(komiku),
        Arc::new(Mock::new("kiryuu").erroring()),
    ]);
    let out = agg.series_resolve("komiku:k1", 30, None).await.expect("series komiku");
    assert_eq!(out.detail.manga.source.as_str(), "komiku");
    assert_eq!(out.detail.chapters.len(), 2);
    let _ = kiryuu_calls;
}

#[tokio::test]
async fn series_fallback_when_primary_source_errors() {
    // Handle shinigami mati -> jatuh ke kiryuu via resolve slug judul.
    let agg = Aggregator::new(vec![
        Arc::new(Mock::new("shinigami").series_error()),
        Arc::new(
            Mock::new("kiryuu")
                .with_search(vec![manga("kiryuu", "k9", "Solo Leveling", Some(1))])
                .with_series(detail("kiryuu", "k9", "Solo Leveling", vec![
                    chapter("kiryuu", "179", "179"),
                    chapter("kiryuu", "178", "178"),
                ])),
        ),
    ]);
    // native_id "solo-leveling" -> title_key "solo leveling" == judul kiryuu.
    let out = agg
        .series_resolve("shinigami:solo-leveling", 30, None)
        .await
        .expect("harus fallback ke kiryuu");
    assert_eq!(out.detail.manga.source.as_str(), "kiryuu");
    assert_eq!(out.detail.chapters.len(), 2);
}

#[tokio::test]
async fn series_resolve_accepts_plain_title() {
    let agg = Aggregator::new(vec![
        Arc::new(Mock::new("komiku").erroring()),
        Arc::new(
            Mock::new("kiryuu")
                .with_search(vec![manga("kiryuu", "k9", "Berserk", Some(1))])
                .with_series(detail("kiryuu", "k9", "Berserk", vec![chapter("kiryuu", "1", "1")])),
        ),
    ]);
    let out = agg.series_resolve("Berserk", 30, None).await.expect("resolve by judul");
    assert_eq!(out.detail.manga.source.as_str(), "kiryuu");
    assert_eq!(out.detail.chapters.len(), 1);
}

#[tokio::test]
async fn series_with_fallback_stops_at_first_success() {
    let agg = Aggregator::new(vec![
        Arc::new(Mock::new("komiku").with_series(detail("komiku", "c1", "Berserk", vec![
            chapter("komiku", "1", "1"),
        ]))),
        Arc::new(Mock::new("kiryuu").with_series(detail("kiryuu", "k1", "Berserk", vec![
            chapter("kiryuu", "2", "2"),
        ]))),
    ]);
    let m = manga("komiku", "c1", "Berserk", Some(1));
    let out = agg.series_with_fallback(&m, 30, None).await.unwrap();
    assert_eq!(out.detail.manga.source.as_str(), "komiku", "primary menang");
    assert_eq!(out.detail.chapters[0].number, "1");
}

#[tokio::test]
async fn read_fallback_switches_source_and_resolves_chapter_by_number() {
    // Primary (mangaku) page error -> fallback ke shinigami via resolve judul,
    // chapter dicari ulang by number dari series sumber baru.
    let agg = Aggregator::new(vec![
        Arc::new(Mock::new("mangaku").erroring()),
        Arc::new(
            Mock::new("shinigami")
                .with_search(vec![manga("shinigami", "s1", "Vinland Saga", Some(1))])
                .with_series(detail("shinigami", "s1", "Vinland Saga", vec![
                    chapter("shinigami", "10", "10"),
                    chapter("shinigami", "10.5", "10.5"),
                ]))
                .with_pages(pages("shinigami", "Vinland Saga", "10.5", &[
                    "https://img/1.jpg",
                    "https://img/2.jpg",
                ])),
        ),
    ]);
    let m = manga("mangaku", "m1", "Vinland Saga", Some(1));
    let ch = chapter("mangaku", "x", "10.5");
    let out = agg
        .chapter_pages_with_fallback(&m, &ch, None)
        .await
        .expect("fallback read");
    assert_eq!(out.pages.source.as_str(), "shinigami");
    assert_eq!(out.pages.images.len(), 2);
    assert_eq!(out.pages.number, "10.5");
}

#[tokio::test]
async fn read_failure_when_all_sources_error() {
    let agg = Aggregator::new(vec![
        Arc::new(Mock::new("komiku").erroring()),
        Arc::new(Mock::new("kiryuu").erroring()),
    ]);
    let m = manga("komiku", "c1", "Naruto", Some(1));
    let ch = chapter("komiku", "1", "1");
    let err = agg.chapter_pages_with_fallback(&m, &ch, None).await.unwrap_err();
    assert!(err.to_string().contains("gagal ambil halaman"), "err: {err}");
}

#[tokio::test]
async fn read_skips_source_returning_empty_images() {
    let agg = Aggregator::new(vec![
        Arc::new(Mock::new("komiku").with_pages(pages("komiku", "T", "1", &[]))),
        Arc::new(Mock::new("kiryuu").with_pages(pages("kiryuu", "T", "1", &["https://k/1.jpg"]))),
    ]);
    let m = manga("komiku", "c1", "T", Some(1));
    let ch = chapter("komiku", "1", "1");
    let out = agg.chapter_pages_with_fallback(&m, &ch, None).await.unwrap();
    assert_eq!(out.pages.images.len(), 1, "gambar kosong tidak dihitung sukses");
}

#[tokio::test]
async fn chapter_by_number_handles_float_format() {
    let d = detail("kiryuu", "k1", "T", vec![
        chapter("kiryuu", "a", "1"),
        chapter("kiryuu", "b", "10.5"),
        chapter("kiryuu", "c", "11"),
    ]);
    assert_eq!(chapter_by_number(&d, "10.5").unwrap().native_id, "b");
    assert_eq!(chapter_by_number(&d, "10.50").unwrap().native_id, "b", "float compare");
    assert_eq!(chapter_by_number(&d, " 11 ").unwrap().native_id, "c", "trim");
    assert!(chapter_by_number(&d, "12").is_none());
}

#[tokio::test]
async fn memory_ttl_serves_then_expires() {
    let (cache, now) = test_clock(1_000);
    let agg = Aggregator::with_cache(
        vec![Arc::new(Mock::new("komiku").with_search(vec![manga("komiku", "c1", "Cached", Some(1))]))],
        cache,
    );

    let first = agg.search("cached", 1, 10, None).await;
    assert!(!first.from_cache, "panggilan pertama dari sumber");
    assert_eq!(first.items.len(), 1);

    let second = agg.search("cached", 1, 10, None).await;
    assert!(second.from_cache, "hit memory dalam TTL");
    assert_eq!(second.items.len(), 1);

    now.store(1_000 + DEFAULT_TTL.as_millis() as u64 + 1, Ordering::SeqCst);
    let third = agg.search("cached", 1, 10, None).await;
    assert!(!third.from_cache, "TTL kedaluwarsa -> fetch ulang");
    assert_eq!(third.items.len(), 1);

    let other = agg.search("lain", 1, 10, None).await;
    assert!(!other.from_cache, "kunci berbeda");
}

#[tokio::test]
async fn disk_ttl_expiry_and_stale_entry_visible() {
    let dir = std::env::temp_dir().join(format!("komik-agg-disk-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    let (disk, now) = test_disk_clock(&dir, 5_000);
    disk.set("list:*:search:1:disk", serde_json::json!([{"t": 1}]))
        .unwrap();

    assert!(disk.fresh("list:*:search:1:disk").is_some());
    now.store(now.load(Ordering::SeqCst) + DEFAULT_TTL.as_millis() as u64 + 1, Ordering::SeqCst);
    assert!(disk.fresh("list:*:search:1:disk").is_none(), "kedaluwarsa");
    assert!(disk.get("list:*:search:1:disk").is_some(), "stale masih bisa dibaca (SWR)");

    let _ = std::fs::remove_dir_all(&dir);
}

#[tokio::test]
async fn unified_cache_disk_promotes_to_memory() {
    let dir = std::env::temp_dir().join(format!("komik-agg-promote-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    let disk = DiskCache::new(&dir, DEFAULT_TTL);
    disk.set("k", serde_json::json!({"a": 1})).unwrap();

    let cache = Cache::with_disk(DEFAULT_TTL, &dir);
    assert_eq!(cache.fresh("k"), Some(serde_json::json!({"a": 1})), "disk hit");
    // Setelah dipromosikan, memory melayani juga (cache.set menghapus memory
    // bukan jalur diuji; lookup ulang dari disk membuktikan promosi).
    assert!(cache.fresh("k").is_some());

    let _ = std::fs::remove_dir_all(&dir);
}

#[tokio::test]
async fn successful_result_is_cached_but_partial_failure_is_not() {
    let agg_ok = Aggregator::with_cache(
        vec![Arc::new(Mock::new("komiku").with_search(vec![manga("komiku", "c1", "PF", Some(1))]))],
        Cache::memory(DEFAULT_TTL),
    );
    let merged = agg_ok.search("pf", 1, 10, None).await;
    assert!(merged.failures.is_empty());
    assert!(cache_value(&agg_ok, "list:*:search:1:pf").is_some(), "hasil sukses di-cache");

    let agg_bad = Aggregator::with_cache(
        vec![Arc::new(Mock::new("komiku").erroring())],
        Cache::memory(DEFAULT_TTL),
    );
    let bad = agg_bad.search("pf", 1, 10, None).await;
    assert!(bad.all_failed());
    assert!(cache_value(&agg_bad, "list:*:search:1:pf").is_none(), "kegagalan tidak di-cache");
}

#[tokio::test]
async fn no_cache_mode_always_fetches() {
    let agg = Aggregator::new(vec![Arc::new(
        Mock::new("komiku").with_search(vec![manga("komiku", "c1", "NC", Some(1))]),
    )])
    .without_cache();
    assert!(agg.cache().is_none());
    let first = agg.search("nc", 1, 10, None).await;
    assert!(!first.from_cache);
    let second = agg.search("nc", 1, 10, None).await;
    assert!(!second.from_cache, "--no-cache: selalu fetch");
}

#[tokio::test]
async fn parse_handle_maps_source_and_native_id() {
    let (src, native) = parse_handle("komiku:naruto");
    assert_eq!(src.unwrap().as_str(), "komiku");
    assert_eq!(native, "naruto");
    let (none, title) = parse_handle("naruto");
    assert!(none.is_none());
    assert_eq!(title, "naruto");
    let (unknown, _) = parse_handle("unknownhost:xyz");
    assert!(unknown.is_none(), "sumber tak dikenal diperlakukan sebagai judul");
}

#[tokio::test]
async fn all_sources_registered_and_accounted_for() {
    // Registry lengkap + setiap sumber diperhitungkan (sukses/gagal) tanpa
    // mengandalkan hasil network (adapter boleh stub atau nyata).
    let sources = all_sources(reqwest::Client::new());
    assert_eq!(sources.len(), 4);
    let ids: Vec<String> = sources.iter().map(|s| s.id().to_string()).collect();
    assert_eq!(ids, vec!["komiku", "mangaku", "shinigami", "kiryuu"]);
    let agg = Aggregator::new(sources);
    let merged = agg.popular(1, 5, None).await;
    assert_eq!(merged.sources_total, 4);
    assert_eq!(merged.sources_ok + merged.failures.len(), 4, "semua sumber diperhitungkan");
}

#[tokio::test]
async fn known_source_ids_match_model_priority_order() {
    let sources = all_sources(reqwest::Client::new());
    let agg = Aggregator::new(sources);
    assert_eq!(agg.known_sources(), SOURCE_PRIORITY.iter().map(|s| s.to_string()).collect::<Vec<_>>());
}

// ------------------------------------------- cross-source chapter fallback

#[tokio::test]
async fn chapter_number_identity_is_string_based() {
    // (a) desimal: leading zero integer + trailing zero fraksi dibuang.
    assert_eq!(chapter_number_key("179.60"), "179.6");
    assert_eq!(chapter_number_key("179.6"), "179.6");
    assert_eq!(chapter_number_key("007"), "7");
    assert_eq!(chapter_number_key("1.10"), "1.1");
    assert_eq!(chapter_number_key("  12  "), "12");
    assert_eq!(chapter_number_key("0.50"), "0.5");
    // (a) non-desimal: raw trim lowercase.
    assert_eq!(chapter_number_key("Extra"), "extra");
    assert_eq!(chapter_number_key(" Part 2 "), "part 2");
    // "extra" TIDAK boleh ketuker dengan 7 (alasan A3: bukan f64).
    assert_ne!(chapter_number_key("extra"), chapter_number_key("7"));

    let d = detail("kiryuu", "k1", "T", vec![
        chapter("kiryuu", "a", "7"),
        chapter("kiryuu", "b", "179.6"),
        chapter("kiryuu", "c", "extra"),
    ]);
    assert_eq!(chapter_by_number(&d, "179.60").unwrap().native_id, "b");
    assert_eq!(chapter_by_number(&d, "007").unwrap().native_id, "a");
    assert_eq!(chapter_by_number(&d, " 179.6 ").unwrap().native_id, "b", "trim");
    assert_eq!(chapter_by_number(&d, "EXTRA").unwrap().native_id, "c", "label bebas, case-insensitive");
    assert!(chapter_by_number(&d, "8").is_none());
    assert_eq!(chapter_index_by_key(&d, "179.60"), Some(1));
}

#[tokio::test]
async fn source_error_classifies_failures() {
    use komik_core::source::{classified, SourceError};

    // Sumber TERAKSES dan bilang tidak ada.
    assert_eq!(
        SourceError::classify_message("manga 'x' tidak ditemukan"),
        SourceError::Missing
    );
    assert_eq!(
        SourceError::classify_message("chapter 5 tidak punya gambar"),
        SourceError::Empty
    );
    // Tidak bisa diakses.
    assert_eq!(SourceError::classify_message("timeout 10s"), SourceError::Timeout);
    assert_eq!(
        SourceError::classify_message("HTTP 429: too many requests"),
        SourceError::RateLimited
    );
    // "struktur situs berubah" = parse error, BUKAN "tidak ditemukan"
    // (pesan parser juga memakai kata itu).
    assert_eq!(
        SourceError::classify_message("data-page tidak ditemukan (struktur situs berubah?)"),
        SourceError::ParseError
    );
    // Jaringan = Other (tak boleh disimpulkan "tidak ada").
    assert!(matches!(
        SourceError::classify_message("network error: connection reset"),
        SourceError::Other(_)
    ));

    assert!(SourceError::Missing.is_conclusive());
    assert!(SourceError::Empty.is_conclusive());
    assert!(SourceError::Timeout.is_inaccessible());
    assert!(SourceError::RateLimited.is_inaccessible());
    assert!(SourceError::ParseError.is_inaccessible());

    // classified() = kelas pasti + pesan asli utuh.
    let e = classified(SourceError::Missing, "manga 'zz' tidak ditemukan");
    assert_eq!(SourceError::from(&e), SourceError::Missing);
    assert_eq!(e.to_string(), "manga 'zz' tidak ditemukan");

    // Fallback From<anyhow::Error> untuk galat biasa adapter.
    let plain = anyhow::anyhow!("HTTP 404: not found");
    assert_eq!(SourceError::from(plain), SourceError::Missing);
}

#[tokio::test]
async fn read_chapter_any_switches_source_with_sticky_prev_next() {
    // (b) + (c): primary tak punya nomor -> pindah sumber kedua, note benar,
    // prev/next mengikuti sumber yang melayani.
    let agg = Aggregator::new(vec![
        Arc::new(Mock::new("komiku").with_series(detail("komiku", "c1", "Solo Leveling", vec![
            chapter("komiku", "x1", "179.7"),
            chapter("komiku", "x2", "179.5"),
            chapter("komiku", "x3", "179.2"),
        ]))),
        Arc::new(
            Mock::new("mangaku")
                .with_search(vec![manga("mangaku", "m2", "Solo Leveling", Some(2))])
                .with_series(detail("mangaku", "m2", "Solo Leveling", vec![
                    chapter("mangaku", "n1", "179.7"),
                    chapter("mangaku", "n2", "179.6"),
                    chapter("mangaku", "n3", "179.5"),
                    chapter("mangaku", "n4", "179.2"),
                ]))
                .with_pages(pages("mangaku", "Solo Leveling", "179.6", &["https://m/1.jpg"])),
        ),
    ]);

    let out = agg
        .read_chapter_any("komiku:c1", "179.6", None, 30)
        .await
        .expect("harus pindah ke mangaku");

    assert_eq!(out.pages.source.as_str(), "mangaku");
    assert_eq!(out.pages.images.len(), 1);
    assert_eq!(out.switched_from.as_ref().unwrap().as_str(), "komiku");
    assert_eq!(
        out.note.as_deref(),
        Some("chapter 179.6 tidak ada di komiku — dibaca dari mangaku")
    );

    // prev/next dari daftar sumber PELAYAN (mangaku), bukan primary.
    let prev = out.prev.expect("prev mangaku");
    assert_eq!(prev.number, "179.5", "prev = lebih tua");
    assert_eq!(prev.source.as_str(), "mangaku");
    assert_eq!(prev.handle, "mangaku:m2");
    let next = out.next.expect("next mangaku");
    assert_eq!(next.number, "179.7", "next = lebih baru");
    assert_eq!(next.handle, "mangaku:m2");
}

#[tokio::test]
async fn read_chapter_any_keeps_primary_when_chapter_exists() {
    // (f) regresi: nomor ADA di primary -> TIDAK pindah sumber.
    let komiku = Mock::new("komiku")
        .with_series(detail("komiku", "c1", "Solo Leveling", vec![
            chapter("komiku", "x1", "180"),
        ]))
        .with_pages(pages("komiku", "Solo Leveling", "180", &[
            "https://k/1.jpg",
            "https://k/2.jpg",
        ]));
    let other = Mock::new("mangaku")
        .with_series(detail("mangaku", "m2", "Solo Leveling", vec![
            chapter("mangaku", "n1", "180"),
        ]))
        .with_pages(pages("mangaku", "Solo Leveling", "180", &["https://m/1.jpg"]));
    let other_calls = other.resolve_calls.clone();

    let agg = Aggregator::new(vec![Arc::new(komiku), Arc::new(other)]);
    let out = agg
        .read_chapter_any("komiku:c1", "180", None, 30)
        .await
        .expect("chapter ada di primary");

    assert_eq!(out.pages.source.as_str(), "komiku");
    assert_eq!(out.pages.images.len(), 2);
    assert!(out.switched_from.is_none(), "tidak pindah sumber");
    assert!(out.note.is_none());
    assert_eq!(
        other_calls.load(Ordering::SeqCst),
        0,
        "sumber kedua tidak boleh disentuh"
    );
    // Chapter tunggal = tepi dua sisi.
    assert!(out.prev.is_none() && out.next.is_none());
}

#[tokio::test]
async fn read_chapter_any_switches_when_primary_images_empty() {
    // Keputusan 1: gambar kosong di sumber terpilih = trigger pindah.
    let agg = Aggregator::new(vec![
        // pages_result None -> mock balas images kosong.
        Arc::new(Mock::new("komiku").with_series(detail("komiku", "c1", "T", vec![
            chapter("komiku", "x1", "5"),
        ]))),
        Arc::new(
            Mock::new("mangaku")
                .with_search(vec![manga("mangaku", "m2", "T", Some(1))])
                .with_series(detail("mangaku", "m2", "T", vec![chapter("mangaku", "n1", "5")]))
                .with_pages(pages("mangaku", "T", "5", &["https://m/1.jpg"])),
        ),
    ]);

    let out = agg
        .read_chapter_any("komiku:c1", "5", None, 30)
        .await
        .expect("gambar kosong harus pindah sumber");

    assert_eq!(out.pages.source.as_str(), "mangaku");
    assert_eq!(
        out.note.as_deref(),
        Some("chapter 5 tanpa gambar di komiku — dibaca dari mangaku")
    );
    // Gambar kosong BUKAN kesimpulan "tidak ada" -> tak boleh di-cache.
    assert!(cache_value(&agg, "neg-chapter:komiku:c1:komiku:5").is_none());
    assert!(cache_value(&agg, "neg-series:komiku:c1:komiku").is_none());
}

#[tokio::test]
async fn read_chapter_any_all_sources_inaccessible_is_not_not_found() {
    // (d) semua sumber gagal DIAKSES -> "gagal diakses", BUKAN "tidak ditemukan".
    let agg = Aggregator::new(vec![
        Arc::new(Mock::new("komiku").erroring()),
        Arc::new(Mock::new("mangaku").erroring()),
    ]);
    let err = agg
        .read_chapter_any("komiku:c1", "179.6", None, 30)
        .await
        .unwrap_err();
    let msg = err.to_string();
    assert!(msg.contains("gagal memuat chapter"), "err: {msg}");
    assert!(msg.contains("semua sumber gagal diakses"), "err: {msg}");
    assert!(!msg.contains("tidak ditemukan"), "A4: jangan klaim tidak ada: {msg}");
    // Kegagalan jaringan TIDAK masuk negative cache.
    assert!(cache_value(&agg, "neg-chapter:komiku:c1:komiku:179.6").is_none());
    assert!(cache_value(&agg, "neg-series:komiku:c1:komiku").is_none());
}

#[tokio::test]
async fn read_chapter_any_missing_everywhere_says_not_found() {
    // Kebalikan (d): semua sumber TERAKSES dan memang tak punya chapter.
    let agg = Aggregator::new(vec![Arc::new(Mock::new("komiku").with_series(detail(
        "komiku",
        "c1",
        "T",
        vec![chapter("komiku", "x1", "1")],
    )))]);
    let err = agg
        .read_chapter_any("komiku:c1", "999", None, 30)
        .await
        .unwrap_err();
    assert!(
        err.to_string().contains("tidak ditemukan di sumber mana pun"),
        "err: {err}"
    );
}

#[tokio::test]
async fn negative_cache_short_ttl_and_never_for_network_failure() {
    // (e) "tidak ada" di-cache sebentar; kegagalan jaringan tidak.
    let (cache, now) = test_clock(1_000);
    let komiku = Mock::new("komiku").with_series(detail("komiku", "c1", "Solo Leveling", vec![
        chapter("komiku", "x1", "179.5"),
    ]));
    let calls = komiku.resolve_calls.clone();
    let agg = Aggregator::with_cache(vec![Arc::new(komiku)], cache);

    let err = agg
        .read_chapter_any("komiku:c1", "179.6", None, 30)
        .await
        .unwrap_err();
    assert!(err.to_string().contains("tidak ditemukan"), "err: {err}");
    assert!(
        cache_value(&agg, "neg-chapter:komiku:c1:komiku:179.6").is_some(),
        "miss di-cache TTL pendek"
    );
    let after_first = calls.load(Ordering::SeqCst);
    assert!(after_first > 0, "series sumber dipanggil");

    // Panggilan kedua: sumber dilewati tanpa request.
    let _ = agg
        .read_chapter_any("komiku:c1", "179.6", None, 30)
        .await
        .unwrap_err();
    assert_eq!(
        calls.load(Ordering::SeqCst),
        after_first,
        "neg-hit segar: tanpa request sumber"
    );

    // Setelah NEGATIVE_TTL, penanda kedaluwarsa -> fetch ulang.
    now.store(1_000 + NEGATIVE_TTL.as_millis() as u64 + 1, Ordering::SeqCst);
    let _ = agg
        .read_chapter_any("komiku:c1", "179.6", None, 30)
        .await
        .unwrap_err();
    assert!(
        calls.load(Ordering::SeqCst) > after_first,
        "TTL pendek kedaluwarsa -> fetch ulang"
    );

    // Series kosong juga boleh di-cache sebentar.
    let empty = Aggregator::with_cache(
        vec![Arc::new(Mock::new("kiryuu").with_series(detail("kiryuu", "k1", "T", vec![])))],
        Cache::memory(DEFAULT_TTL),
    );
    let _ = empty
        .read_chapter_any("kiryuu:k1", "3", None, 30)
        .await
        .unwrap_err();
    assert!(cache_value(&empty, "neg-series:kiryuu:k1:kiryuu").is_some());

    // Kegagalan jaringan: tidak ada penanda sama sekali.
    let bad = Aggregator::with_cache(
        vec![Arc::new(Mock::new("shinigami").erroring())],
        Cache::memory(DEFAULT_TTL),
    );
    let err2 = bad
        .read_chapter_any("shinigami:s1", "3", None, 30)
        .await
        .unwrap_err();
    assert!(err2.to_string().contains("gagal"), "err: {err2}");
    assert!(cache_value(&bad, "neg-chapter:shinigami:s1:shinigami:3").is_none());
    assert!(cache_value(&bad, "neg-series:shinigami:s1:shinigami").is_none());
}

#[tokio::test]
async fn series_resolve_pref_tries_last_source_first() {
    // Sticky: sumber terakhir client dicoba lebih dulu.
    let agg = Aggregator::new(vec![
        Arc::new(
            Mock::new("komiku")
                .with_search(vec![manga("komiku", "c1", "Berserk", Some(1))])
                .with_series(detail("komiku", "c1", "Berserk", vec![chapter("komiku", "a", "1")])),
        ),
        Arc::new(
            Mock::new("kiryuu")
                .with_search(vec![manga("kiryuu", "k9", "Berserk", Some(1))])
                .with_series(detail("kiryuu", "k9", "Berserk", vec![chapter("kiryuu", "b", "2")])),
        ),
    ]);

    let plain = agg.series_resolve("Berserk", 30, None).await.unwrap();
    assert_eq!(plain.detail.manga.source.as_str(), "komiku", "default: prioritas");
    assert!(!plain.from_cache);

    // Sticky dilayani kiryuu, dan TIDAK mencontaminasi cache default.
    let sticky = agg
        .series_resolve_pref("Berserk", 30, None, Some("kiryuu"))
        .await
        .expect("sticky kiryuu");
    assert_eq!(sticky.detail.manga.source.as_str(), "kiryuu");
    assert_eq!(sticky.detail.chapters[0].number, "2");
    assert!(!sticky.from_cache, "kunci sticky terpisah dari kunci default");

    // Default tetap komiku walau sticky kiryuu baru saja di-cache.
    let plain_again = agg.series_resolve("Berserk", 30, None).await.unwrap();
    assert_eq!(
        plain_again.detail.manga.source.as_str(),
        "komiku",
        "cache sticky tak membocor ke kunci default"
    );

    // Sticky kedua: hit cache.
    let sticky_again = agg
        .series_resolve_pref("Berserk", 30, None, Some("kiryuu"))
        .await
        .unwrap();
    assert!(sticky_again.from_cache);
    assert_eq!(sticky_again.detail.manga.source.as_str(), "kiryuu");

    // Last-source tak dikenal -> jatuh ke perilaku normal.
    let unknown = agg
        .series_resolve_pref("Berserk", 30, None, Some("sumber-hantu"))
        .await
        .unwrap();
    assert_eq!(unknown.detail.manga.source.as_str(), "komiku");

    // None -> identik series_resolve.
    let none = agg.series_resolve_pref("Berserk", 30, None, None).await.unwrap();
    assert_eq!(none.detail.manga.source.as_str(), "komiku");
}

#[tokio::test]
async fn series_resolve_pref_falls_back_when_last_source_errors() {
    let agg = Aggregator::new(vec![
        Arc::new(Mock::new("shinigami").series_error()),
        Arc::new(
            Mock::new("kiryuu")
                .with_search(vec![manga("kiryuu", "k9", "Berserk", Some(1))])
                .with_series(detail("kiryuu", "k9", "Berserk", vec![chapter("kiryuu", "b", "2")])),
        ),
    ]);
    let out = agg
        .series_resolve_pref("Berserk", 30, None, Some("shinigami"))
        .await
        .expect("sticky gagal -> fallback normal");
    assert_eq!(out.detail.manga.source.as_str(), "kiryuu");
}

#[tokio::test]
async fn series_resolve_pref_handle_uses_real_title_for_sticky() {
    // Regresi bug: handle "komiku:k1" dengan judul asli "Solo Leveling".
    // Sticky kiryuu harus jatuh ke kiryuu — dulu pencarian pakai slug id
    // ("k1") sehingga meleset dan sticky tak pernah kepakai.
    let agg = Aggregator::new(vec![
        Arc::new(
            Mock::new("komiku")
                .with_series(detail("komiku", "k1", "Solo Leveling", vec![chapter("komiku", "c1", "179")]))
                .with_search(vec![]),
        ),
        Arc::new(
            Mock::new("kiryuu")
                .with_search(vec![manga("kiryuu", "solo-leveling", "Solo Leveling", Some(2))])
                .with_series(detail("kiryuu", "solo-leveling", "Solo Leveling", vec![chapter("kiryuu", "c9", "179.6")])),
        ),
        Arc::new(
            Mock::new("shinigami")
                .with_search(vec![manga("shinigami", "s9", "Solo Leveling", Some(5))])
                .with_series(detail("shinigami", "s9", "Solo Leveling", vec![chapter("shinigami", "c8", "179")])),
        ),
    ]);
    let out = agg
        .series_resolve_pref("komiku:k1", 30, None, Some("kiryuu"))
        .await
        .expect("sticky kiryuu harus kepakai");
    assert_eq!(out.detail.manga.source.as_str(), "kiryuu");
    assert_eq!(out.detail.chapters.len(), 1);
    assert_eq!(out.detail.chapters[0].number, "179.6");
}

#[tokio::test]
async fn resolve_title_slug_variant_hyphen_to_space() {
    // Regresi: user paste slug "solo-leveling"; sumber (kiryuu/wp) hanya
    // match bentuk berspasi "solo leveling". Harus tetap ketemu.
    use std::sync::atomic::AtomicUsize;
    struct SpaceOnlyMock;
    #[async_trait::async_trait]
    impl Source for SpaceOnlyMock {
        fn id(&self) -> SourceId { SourceId::from("kiryuu") }
        async fn popular(&self, _p: u32) -> SourceResult<Vec<Manga>> { Ok(vec![]) }
        async fn latest(&self, _p: u32) -> SourceResult<Vec<Manga>> { Ok(vec![]) }
        async fn search(&self, _q: &str, _p: u32) -> SourceResult<Vec<Manga>> { Ok(vec![]) }
        async fn list(&self, _g: Option<&str>, _p: u32) -> SourceResult<Vec<Manga>> { Ok(vec![]) }
        async fn genres(&self) -> SourceResult<Vec<(String, String)>> { Ok(vec![]) }
        async fn series(&self, _id: &str) -> SourceResult<SeriesDetail> {
            Ok(detail("kiryuu", "solo-leveling", "Solo Leveling", vec![chapter("kiryuu", "c1", "179")]))
        }
        async fn chapter_pages(&self, _m: &Manga, _c: &Chapter) -> SourceResult<ChapterPages> {
            Ok(ChapterPages { source: SourceId::from("kiryuu"), title: "C".into(), number: "179".into(), images: vec!["https://x/1.jpg".into()] })
        }
        async fn resolve(&self, title: &str) -> SourceResult<Option<Manga>> {
            // hanya cocok kalau query memakai SPASI, bukan hyphen
            if title == "solo leveling" {
                Ok(Some(manga("kiryuu", "solo-leveling", "Solo Leveling", Some(1))))
            } else {
                Ok(None)
            }
        }
    }
    let _ = AtomicUsize::new(0);
    let agg = Aggregator::new(vec![Arc::new(SpaceOnlyMock)]);
    let out = agg.series_resolve("solo-leveling", 10, None).await.expect("varian hyphen->spasi harus resolve");
    assert_eq!(out.detail.manga.source.as_str(), "kiryuu");
    assert_eq!(out.detail.chapters.len(), 1);
}

#[tokio::test]
async fn read_chapter_any_caches_result_second_call_no_fetch() {
    // Regresi perf: pembacaan ulang chapter tidak boleh fetch ulang.
    let mock = Arc::new(
        Mock::new("komiku")
            .with_series(detail("komiku", "m1", "M", vec![chapter("komiku", "c1", "10")]))
            .with_pages(ChapterPages {
                source: SourceId::from("komiku"),
                title: "Chapter 10".into(),
                number: "10".into(),
                images: vec!["https://x/1.jpg".into()],
            }),
    );
    let agg = Aggregator::new(vec![mock.clone()]);
    let first = agg.read_chapter_any("komiku:m1", "10", None, 30).await.expect("baca pertama");
    let calls_after_first = mock.series_calls();
    let second = agg.read_chapter_any("komiku:m1", "10", None, 30).await.expect("baca kedua");
    let calls_after_second = mock.series_calls();
    assert_eq!(calls_after_second, calls_after_first, "baca kedua harus cache, tanpa fetch");
    assert_eq!(first.pages.images, second.pages.images);
    assert_eq!(first.pages.title, second.pages.title);
}
