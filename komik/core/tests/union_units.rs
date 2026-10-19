//! Unit test union chapter lintas sumber (fondasi cross-chapter merge).
//!
//! Cakupan: dedup by `chapter_number_key` ("09" == "9"), episode eksklusif
//! sumber lain tetap ikut, urutan nomor (numerik DESC lalu label non-numerik),
//! perbandingan urutan, dan pengumpulan daftar chapter per sumber di
//! `Aggregator` (fan-out paralel, sumber pelayan dilewati, kegagalan
//! sumber ditoleransi).
use komik_core::aggregator::Aggregator;
use komik_core::model::{Chapter, Manga, SeriesDetail, SourceId};
use komik_core::source::{Source, SourceResult};
use komik_core::union::{cmp_chapter_number, merge_chapter_lists, SourceChapterList};
use std::cmp::Ordering;
use std::sync::atomic::{AtomicUsize, Ordering as AtomicOrdering};
use std::sync::Arc;

// ---------------------------------------------------------------- fixtures

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

fn list(src: &str, handle: &str, numbers: &[(&str, &str)]) -> SourceChapterList {
    SourceChapterList {
        source: SourceId::from(src),
        handle: handle.into(),
        chapters: numbers
            .iter()
            .map(|(native, number)| chapter(src, native, number))
            .collect(),
    }
}

/// Dua sumber dengan judul sama; "09" (komiku) dan "9" (shinigami) dianggap
/// chapter yang sama.
fn dua_sumber() -> Vec<SourceChapterList> {
    vec![
        list(
            "komiku",
            "komiku:6167",
            &[("k-09", "09"), ("k-232", "232")],
        ),
        list(
            "shinigami",
            "shinigami:3b1eab91",
            &[
                ("s-9", "9"),
                ("s-233", "233"),
                ("s-277", "277"),
                ("s-extra", "extra"),
            ],
        ),
    ]
}

// ------------------------------------------------------------------- tests

/// "09" (komiku) dan "9" (shinigami) = satu baris; pemenang dari daftar
/// pertama, field mentah tidak diubah.
#[test]
fn merge_dedup_09_dan_9_menang_dari_daftar_pertama() {
    let lists = dua_sumber();
    let out = merge_chapter_lists(&lists);

    let sembilan: Vec<_> = out.iter().filter(|c| c.number == "09" || c.number == "9").collect();
    assert_eq!(sembilan.len(), 1, "harus satu baris: {out:?}");
    assert_eq!(sembilan[0].number, "09", "nomor mentah sumber pemilik menang");
    assert_eq!(sembilan[0].native_id, "k-09");
    assert_eq!(sembilan[0].source.as_str(), "komiku");
    assert_eq!(sembilan[0].handle, "komiku:6167");
    assert_eq!(sembilan[0].title, "Chapter 09");
}

/// Episode eksklusif sumber kedua ("233") tetap ikut.
#[test]
fn merge_episode_eksklusif_sumber_kedua_ikut() {
    let lists = dua_sumber();
    let out = merge_chapter_lists(&lists);

    let c233 = out.iter().find(|c| c.number == "233").expect("233 harus ikut");
    assert_eq!(c233.source.as_str(), "shinigami");
    assert_eq!(c233.handle, "shinigami:3b1eab91");
    assert_eq!(c233.native_id, "s-233");
    assert_eq!(out.len(), 5, "09/9 jadi satu baris: {out:?}");
}

/// Urutan: numerik DESC dulu ("277" sebelum "232"), label non-numerik
/// ("extra") paling belakang.
#[test]
fn merge_urutan_numerik_desc_lalu_non_numerik() {
    let lists = dua_sumber();
    let out = merge_chapter_lists(&lists);

    let numbers: Vec<&str> = out.iter().map(|c| c.number.as_str()).collect();
    assert_eq!(numbers, vec!["277", "233", "232", "09", "extra"]);
}

/// Dua label non-numerik: diurutkan by key DESC (key besar lebih dulu).
#[test]
fn merge_dua_label_non_numerik_urut_key_desc() {
    let lists = vec![list(
        "komiku",
        "komiku:1",
        &[("a", "prologue"), ("b", "extra"), ("c", "9")],
    )];
    let out = merge_chapter_lists(&lists);

    let numbers: Vec<&str> = out.iter().map(|c| c.number.as_str()).collect();
    assert_eq!(numbers, vec!["9", "prologue", "extra"]);
}

/// Perbandingan urutan: bukan identitas.
#[test]
fn cmp_chapter_number_urutan_bukan_identitas() {
    // "232" > "233"? TIDAK -> "233" lebih besar.
    assert_eq!(cmp_chapter_number("232", "233"), Ordering::Less);
    assert_eq!(cmp_chapter_number("233", "232"), Ordering::Greater);
    // "9" > "10"? TIDAK.
    assert_eq!(cmp_chapter_number("9", "10"), Ordering::Less);
    assert_eq!(cmp_chapter_number("10", "9"), Ordering::Greater);
    // "extra" < "9" (numerik selalu lebih dulu).
    assert_eq!(cmp_chapter_number("extra", "9"), Ordering::Less);
    assert_eq!(cmp_chapter_number("9", "extra"), Ordering::Greater);
    // Ekuivalensi numerik: "007" == "7", "179.60" == "179.6".
    assert_eq!(cmp_chapter_number("007", "7"), Ordering::Equal);
    assert_eq!(cmp_chapter_number("179.60", "179.6"), Ordering::Equal);
}

/// Daftar kosong -> hasil kosong.
#[test]
fn merge_daftar_kosong_kosong() {
    assert!(merge_chapter_lists(&[]).is_empty());
}

// --------------------------------------------------------------- aggregator

/// Mock sumber: judul tetap + daftar chapter, atau gagal total.
struct Mock {
    id: SourceId,
    title: String,
    native_id: String,
    chapters: Vec<Chapter>,
    fail: bool,
    series_calls: Arc<AtomicUsize>,
}

impl Mock {
    fn new(id: &str, title: &str) -> Self {
        Mock {
            id: SourceId::from(id),
            title: title.into(),
            native_id: format!("{id}-native"),
            chapters: vec![],
            fail: false,
            series_calls: Arc::new(AtomicUsize::new(0)),
        }
    }
    fn with(mut self, numbers: &[&str]) -> Self {
        self.chapters = numbers
            .iter()
            .map(|n| chapter(self.id.as_str(), &format!("{}-{}", self.id, n), n))
            .collect();
        self
    }
    fn failing(mut self) -> Self {
        self.fail = true;
        self
    }
    fn series_calls(&self) -> usize {
        self.series_calls.load(AtomicOrdering::SeqCst)
    }
}

#[async_trait::async_trait]
impl Source for Mock {
    fn id(&self) -> SourceId {
        self.id.clone()
    }
    async fn popular(&self, _page: u32) -> SourceResult<Vec<Manga>> {
        Ok(vec![])
    }
    async fn latest(&self, _page: u32) -> SourceResult<Vec<Manga>> {
        Ok(vec![])
    }
    async fn search(&self, _q: &str, _page: u32) -> SourceResult<Vec<Manga>> {
        if self.fail {
            anyhow::bail!("mock {}: search gagal", self.id);
        }
        Ok(vec![Manga::new(self.id.clone(), &self.native_id, &self.title)])
    }
    async fn list(&self, _g: Option<&str>, _page: u32) -> SourceResult<Vec<Manga>> {
        Ok(vec![])
    }
    async fn genres(&self) -> SourceResult<Vec<(String, String)>> {
        Ok(vec![])
    }
    async fn series(&self, _native_id: &str) -> SourceResult<SeriesDetail> {
        self.series_calls.fetch_add(1, AtomicOrdering::SeqCst);
        if self.fail {
            anyhow::bail!("mock {}: series gagal", self.id);
        }
        Ok(SeriesDetail {
            manga: Manga::new(self.id.clone(), &self.native_id, &self.title),
            chapters: self.chapters.clone(),
        })
    }
    async fn chapter_pages(
        &self,
        _m: &Manga,
        _c: &Chapter,
    ) -> SourceResult<komik_core::model::ChapterPages> {
        anyhow::bail!("mock {}: chapter_pages tidak dipakai", self.id);
    }
}

/// Fan-out lintas sumber: semua sumber dengan judul sama ikut; sumber gagal
/// dilaporkan di `failed`, sumber tanpa series itu diabaikan.
#[tokio::test]
async fn collect_across_sources_gabung_dan_toleransi_gagal() {
    let agg = Aggregator::new(vec![
        Arc::new(Mock::new("komiku", "Solo Leveling").with(&["2", "1"])),
        Arc::new(Mock::new("mangaku", "Solo Leveling").with(&["3"])),
        // Judul beda -> tidak punya series itu (bukan kegagalan).
        Arc::new(Mock::new("kiryuu", "Series Lain")),
        // Gagal diakses -> masuk `failed`.
        Arc::new(Mock::new("shinigami", "Solo Leveling").failing()),
    ]);

    let (lists, failed) = agg
        .collect_series_across_sources("Solo Leveling", None, 100)
        .await;

    let sumber: Vec<&str> = lists.iter().map(|l| l.source.as_str()).collect();
    assert_eq!(sumber, vec!["komiku", "mangaku"], "hanya sumber yang punya series");
    assert_eq!(lists[0].handle, "komiku:komiku-native");
    assert_eq!(
        lists[0].chapters.iter().map(|c| c.number.as_str()).collect::<Vec<_>>(),
        vec!["2", "1"]
    );
    assert_eq!(failed.len(), 1, "sumber gagal dilaporkan: {failed:?}");
    assert_eq!(failed[0].0.as_str(), "shinigami");
}

/// Sumber pelayan (`skip_source`) tidak ikut, dan `limit` memotong chapter
/// per sumber.
#[tokio::test]
async fn collect_across_sources_lewati_sumber_pelayan_dan_potong_limit() {
    let agg = Aggregator::new(vec![
        Arc::new(Mock::new("komiku", "Solo Leveling").with(&["2", "1"])),
        Arc::new(Mock::new("mangaku", "Solo Leveling").with(&["3"])),
    ]);

    let skip = SourceId::from("komiku");
    let (lists, failed) = agg
        .collect_series_across_sources("Solo Leveling", Some(&skip), 1)
        .await;

    assert!(failed.is_empty(), "tidak ada kegagalan: {failed:?}");
    assert_eq!(lists.len(), 1);
    assert_eq!(lists[0].source.as_str(), "mangaku");
    assert_eq!(lists[0].chapters.len(), 1, "limit = batas chapter per sumber");
    assert_eq!(lists[0].chapters[0].number, "3");
}

/// Panggilan kedua untuk judul sama dilayani cache (tidak fetch ulang).
#[tokio::test]
async fn collect_across_sources_pakai_cache_antar_panggilan() {
    let mock = Arc::new(Mock::new("komiku", "Solo Leveling").with(&["1"]));
    let agg = Aggregator::new(vec![mock.clone()]);

    let (first, _) = agg
        .collect_series_across_sources("Solo Leveling", None, 100)
        .await;
    assert_eq!(first.len(), 1);
    assert_eq!(mock.series_calls(), 1, "sumber diambil sekali");

    let (second, _) = agg
        .collect_series_across_sources("Solo Leveling", None, 100)
        .await;
    assert_eq!(second.len(), 1);
    assert_eq!(mock.series_calls(), 1, "panggilan kedua dilayani cache");
    assert_eq!(second[0].handle, first[0].handle);
    assert_eq!(second[0].chapters.len(), 1);
}
