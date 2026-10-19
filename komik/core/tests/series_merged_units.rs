//! Unit test `Aggregator::series_merged` — UNION daftar chapter lintas sumber.
//!
//! Seam: method publik `series_merged` (core), diamati lewat struct
//! `MergedSeries` (manga + chapters + failed). Semua pakai MOCK Source
//! (fixture hardcoded) — TIDAK ada network.
//!
//! Cakupan: episode eksklusif sumber lain ikut, dedup key sama ("09" vs "9")
//! dimenangin primary, kegagalan sumber lain ditoleransi (hasil primary
//! tetap keluar + sumber gagal dilaporkan), dan manga hasil = manga primary.
use komik_core::aggregator::Aggregator;
use komik_core::model::{chapter_number_key, Chapter, Manga, SeriesDetail, SourceId};
use komik_core::source::{Source, SourceResult};
use std::sync::Arc;

// -------------------------------------------------------------------- mocks

/// Mock sumber: judul tetap + daftar chapter, atau gagal total.
struct Mock {
    id: SourceId,
    title: String,
    native_id: String,
    chapters: Vec<Chapter>,
    fail: bool,
}

impl Mock {
    fn new(id: &str, title: &str) -> Self {
        Mock {
            id: SourceId::from(id),
            title: title.into(),
            native_id: format!("{id}-native"),
            chapters: vec![],
            fail: false,
        }
    }
    fn with(mut self, numbers: &[&str]) -> Self {
        self.chapters = numbers
            .iter()
            .map(|n| Chapter {
                source: self.id.clone(),
                native_id: format!("{}-{}", self.id.as_str(), n),
                title: format!("Chapter {n}"),
                number: (*n).into(),
                updated_at: Some(10),
                url: None,
            })
            .collect();
        self
    }
    fn failing(mut self) -> Self {
        self.fail = true;
        self
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

// ------------------------------------------------------------------- tests

/// Dua sumber dengan judul sama -> `chapters` = union: episode eksklusif
/// sumber kedua ikut, episode milik primary tetap ada.
#[tokio::test]
async fn series_merged_union_memuat_episode_eksklusif_sumber_lain() {
    let agg = Aggregator::new(vec![
        Arc::new(Mock::new("komiku", "Chainsaw Man").with(&["232", "09"])),
        Arc::new(Mock::new("shinigami", "Chainsaw Man").with(&["233", "277"])),
    ]);

    let merged = agg
        .series_merged("komiku:6167", 100, None, None)
        .await
        .expect("union harus berhasil");

    let numbers: Vec<&str> = merged.chapters.iter().map(|c| c.number.as_str()).collect();
    assert!(
        numbers.contains(&"277"),
        "episode 277 hanya ada di shinigami — harus ikut: {numbers:?}"
    );
    assert!(
        numbers.contains(&"232"),
        "episode primary harus tetap ada: {numbers:?}"
    );
    // Baris 277 membawa sumber + handle sumber itu.
    let c277 = merged
        .chapters
        .iter()
        .find(|c| c.number == "277")
        .expect("277 harus ada");
    assert_eq!(c277.source.as_str(), "shinigami");
    assert_eq!(c277.handle, "shinigami:shinigami-native");
    assert_eq!(c277.native_id, "shinigami-277");
}

/// Key chapter sama ("09" vs "9") -> SATU baris, milik primary.
#[tokio::test]
async fn series_merged_key_sama_dipenangin_primary() {
    let agg = Aggregator::new(vec![
        Arc::new(Mock::new("komiku", "Chainsaw Man").with(&["09"])),
        Arc::new(Mock::new("shinigami", "Chainsaw Man").with(&["9"])),
    ]);

    let merged = agg
        .series_merged("komiku:6167", 100, None, None)
        .await
        .expect("union harus berhasil");

    let sembilan: Vec<_> = merged
        .chapters
        .iter()
        .filter(|c| chapter_number_key(&c.number) == "9")
        .collect();
    assert_eq!(sembilan.len(), 1, "harus satu baris: {:?}", merged.chapters);
    assert_eq!(sembilan[0].source.as_str(), "komiku", "primary menang dedup");
    assert_eq!(sembilan[0].number, "09", "nomor mentah primary dipakai");
}

/// Sumber kedua gagal -> `chapters` tetap berisi chapter primary, sumber
/// gagal dilaporkan di `failed` (partial failure tolerated).
#[tokio::test]
async fn series_merged_sumber_gagal_toleran_dan_ditaupkan() {
    let agg = Aggregator::new(vec![
        Arc::new(Mock::new("komiku", "Chainsaw Man").with(&["232"])),
        Arc::new(Mock::new("shinigami", "Chainsaw Man").failing()),
    ]);

    let merged = agg
        .series_merged("komiku:6167", 100, None, None)
        .await
        .expect("primary sukses -> hasil tetap dikembalikan");

    let numbers: Vec<&str> = merged.chapters.iter().map(|c| c.number.as_str()).collect();
    assert_eq!(numbers, vec!["232"], "chapter primary tetap keluar");
    assert_eq!(merged.failed.len(), 1, "sumber gagal dilaporkan: {:?}", merged.failed);
    assert_eq!(merged.failed[0].0.as_str(), "shinigami");
}

/// Manga hasil = manga PRIMARY (metadata tidak berubah oleh union).
#[tokio::test]
async fn series_merged_manga_hasil_primary() {
    let agg = Aggregator::new(vec![
        Arc::new(Mock::new("komiku", "Chainsaw Man").with(&["232"])),
        Arc::new(Mock::new("shinigami", "Chainsaw Man").with(&["277"])),
    ]);

    let merged = agg
        .series_merged("komiku:6167", 100, None, None)
        .await
        .expect("union harus berhasil");

    assert_eq!(merged.manga.source.as_str(), "komiku");
    assert_eq!(merged.manga.native_id, "komiku-native");
    assert_eq!(merged.manga.title, "Chainsaw Man");
}
