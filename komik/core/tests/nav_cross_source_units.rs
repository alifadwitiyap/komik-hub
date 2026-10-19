//! Unit test navigasi next/prev LINTAS SUMBER di `read_chapter_any`.
//!
//! Semua pakai MOCK Source (fixture hardcoded), TIDAK ada network.
//!
//! Aturan yang diuji:
//! - Sumber yang MELAYANI tetap jadi sumber prev/next selama punya tetangga
//!   (regresi: perilaku existing tidak berubah).
//! - Hanya di TEPI (sumber pelayan tidak punya next / tidak punya prev)
//!   pencarian lintas sumber menyala: kandidat `next` = nomor lebih besar
//!   yang terkecil, `prev` = nomor lebih kecil yang terbesar.
//! - Kandidat lintas sumber membawa `source` + `handle` miliknya sendiri.
//! - Sumber lain tanpa judul sama / sumber lain gagal -> `None`, bukan error.
use komik_core::aggregator::{Aggregator, ChapterRef};
use komik_core::model::{Chapter, Manga, SeriesDetail, SourceId};
use komik_core::source::{Source, SourceResult};
use std::sync::Arc;

// -------------------------------------------------------------------- mocks

/// Mock sumber: judul + daftar chapter ( terbaru-dulu, sesuai kontrak trait
/// `Source`), atau gagal total. `resolve` diwarisi dari trait (exact
/// `title_key`) — jadi cukup override `search` + `series`.
struct Mock {
    id: SourceId,
    title: String,
    native_id: String,
    chapters: Vec<Chapter>,
    fail_search: bool,
    fail_series: bool,
}

impl Mock {
    fn new(id: &str, title: &str, native_id: &str) -> Self {
        Mock {
            id: SourceId::from(id),
            title: title.into(),
            native_id: native_id.into(),
            chapters: vec![],
            fail_search: false,
            fail_series: false,
        }
    }

    /// Daftar chapter (urutan terbaru-dulu, mis. ["3","2","1"]).
    fn with(mut self, numbers: &[&str]) -> Self {
        self.chapters = numbers
            .iter()
            .map(|n| chapter(self.id.as_str(), &format!("{}-{}", self.native_id, n), n))
            .collect();
        self
    }

    fn failing_search(mut self) -> Self {
        self.fail_search = true;
        self
    }
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
        if self.fail_search {
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
    async fn series(&self, native_id: &str) -> SourceResult<SeriesDetail> {
        if self.fail_series {
            anyhow::bail!("mock {}: series gagal", self.id);
        }
        Ok(SeriesDetail {
            manga: Manga::new(self.id.clone(), native_id, &self.title),
            chapters: self.chapters.clone(),
        })
    }
    async fn chapter_pages(
        &self,
        _m: &Manga,
        c: &Chapter,
    ) -> SourceResult<komik_core::model::ChapterPages> {
        Ok(komik_core::model::ChapterPages {
            source: self.id.clone(),
            title: format!("Chapter {}", c.number),
            number: c.number.clone(),
            images: vec!["https://img/1.jpg".into()],
        })
    }
}

// ---------------------------------------------------------------- fixtures

const JUDUL: &str = "Chainsaw Man";

/// Sumber pelayan (komiku) + sumber lain (shinigami) dengan judul sama.
fn dua_sumber(a: &[&str], b: &[&str]) -> Aggregator {
    Aggregator::new(vec![
        Arc::new(Mock::new("komiku", JUDUL, "a1").with(a)),
        Arc::new(Mock::new("shinigami", JUDUL, "b1").with(b)),
    ])
}

fn ref_hasil(r: &ChapterRef) -> (&str, &str, &str) {
    (r.number.as_str(), r.source.as_str(), r.handle.as_str())
}

// ------------------------------------------------------------------- tests

/// Tepi atas sumber pelayan -> `next` diambil dari sumber lain (suksesor
/// terdekat: "4", bukan "5"), `prev` tetap dari sumber pelayan.
#[tokio::test]
async fn next_lintas_sumber_saat_pelayan_di_tepi_atas() {
    let agg = dua_sumber(&["3", "2", "1"], &["5", "4", "3"]);
    let out = agg
        .read_chapter_any("komiku:a1", "3", None, 30)
        .await
        .expect("baca chapter 3");

    let next = out.next.expect("next harus ada (dari sumber lain)");
    assert_eq!(ref_hasil(&next), ("4", "shinigami", "shinigami:b1"));

    // Regresi: prev tetap dari sumber yang MELAYANI.
    let prev = out.prev.expect("prev dari sumber pelayan");
    assert_eq!(ref_hasil(&prev), ("2", "komiku", "komiku:a1"));
}

/// Lubang di sumber lain (4 tidak ada) -> suksesor terdekat yang ada ("5").
#[tokio::test]
async fn next_lompat_lubang_di_sumber_lain() {
    let agg = dua_sumber(&["3", "2", "1"], &["5", "3"]);
    let out = agg
        .read_chapter_any("komiku:a1", "3", None, 30)
        .await
        .expect("baca chapter 3");

    let next = out.next.expect("next harus ada");
    assert_eq!(ref_hasil(&next), ("5", "shinigami", "shinigami:b1"));
}

/// Tepi bawah sumber pelayan -> `prev` dari sumber lain kalau ada yang lebih
/// kecil; kalau tidak ada -> `None` (bukan error).
#[tokio::test]
async fn prev_lintas_sumber_dan_none_bila_tak_ada_yang_kecil() {
    // Sumber pelayan ["3","2"] (terbaru-dulu): baca "2" -> tepi bawah
    // (prev None di sumber pelayan), "next" masih milik sumber pelayan.
    // Sumber lain punya "1" (lebih kecil dari "2") -> prev lintas sumber.
    let agg = dua_sumber(&["3", "2"], &["5", "1"]);
    let out = agg
        .read_chapter_any("komiku:a1", "2", None, 30)
        .await
        .expect("baca chapter 2");
    let prev = out.prev.expect("prev lintas sumber");
    assert_eq!(ref_hasil(&prev), ("1", "shinigami", "shinigami:b1"));
    let next = out.next.expect("next dari sumber pelayan");
    assert_eq!(ref_hasil(&next), ("3", "komiku", "komiku:a1"));

    // Sumber lain tidak punya yang lebih kecil -> prev None.
    let agg2 = dua_sumber(&["3", "2", "1"], &["5", "4", "3"]);
    let out2 = agg2
        .read_chapter_any("komiku:a1", "1", None, 30)
        .await
        .expect("baca chapter 1");
    assert!(out2.prev.is_none(), "tidak ada yang lebih kecil: {:?}", out2.prev);
    // next tetap dari sumber pelayan.
    let next = out2.next.expect("next dari sumber pelayan");
    assert_eq!(ref_hasil(&next), ("2", "komiku", "komiku:a1"));
}

/// Sumber lain tidak punya nomor lebih besar -> `next` = None.
#[tokio::test]
async fn next_none_bila_sumber_lain_tak_punya_lebih_besar() {
    let agg = dua_sumber(&["3", "2", "1"], &["3", "2", "1"]);
    let out = agg
        .read_chapter_any("komiku:a1", "3", None, 30)
        .await
        .expect("baca chapter 3");
    assert!(out.next.is_none(), "tak ada kandidat lebih besar: {:?}", out.next);
    // prev tetap dari sumber pelayan.
    let prev = out.prev.expect("prev dari sumber pelayan");
    assert_eq!(ref_hasil(&prev), ("2", "komiku", "komiku:a1"));
}

/// Sumber lain TIDAK punya judul sama -> `next` None, baca tetap berhasil.
#[tokio::test]
async fn sumber_lain_tanpa_judul_sama_tidak_error() {
    let agg = Aggregator::new(vec![
        Arc::new(Mock::new("komiku", JUDUL, "a1").with(&["3", "2", "1"])),
        Arc::new(Mock::new("shinigami", "Series Lain", "b1").with(&["5", "4", "3"])),
    ]);
    let out = agg
        .read_chapter_any("komiku:a1", "3", None, 30)
        .await
        .expect("baca harus tetap berhasil");
    assert_eq!(out.pages.source.as_str(), "komiku");
    assert!(out.next.is_none(), "tak ada kandidat: {:?}", out.next);
    let prev = out.prev.expect("prev dari sumber pelayan");
    assert_eq!(ref_hasil(&prev), ("2", "komiku", "komiku:a1"));
}

/// Sumber lain GAGAL -> `next` None, baca tetap berhasil (partial failure).
#[tokio::test]
async fn sumber_lain_gagal_tidak_error() {
    let agg = Aggregator::new(vec![
        Arc::new(Mock::new("komiku", JUDUL, "a1").with(&["3", "2", "1"])),
        Arc::new(Mock::new("shinigami", JUDUL, "b1").failing_search()),
    ]);
    let out = agg
        .read_chapter_any("komiku:a1", "3", None, 30)
        .await
        .expect("baca harus tetap berhasil");
    assert_eq!(out.pages.source.as_str(), "komiku");
    assert!(out.next.is_none(), "tak ada kandidat: {:?}", out.next);
    let prev = out.prev.expect("prev dari sumber pelayan");
    assert_eq!(ref_hasil(&prev), ("2", "komiku", "komiku:a1"));
}

/// REGRESI: selama sumber pelayan punya tetangga, prev/next TIDAK boleh
/// diambil dari sumber lain walau sumber lain punya chapter lebih dekat.
#[tokio::test]
async fn regresi_tetangga_sumber_pelayan_dipakai_saja() {
    let agg = dua_sumber(&["3", "2", "1"], &["5", "4", "3"]);
    let out = agg
        .read_chapter_any("komiku:a1", "2", None, 30)
        .await
        .expect("baca chapter 2");

    let next = out.next.expect("next");
    assert_eq!(ref_hasil(&next), ("3", "komiku", "komiku:a1"));
    let prev = out.prev.expect("prev");
    assert_eq!(ref_hasil(&prev), ("1", "komiku", "komiku:a1"));
}

/// Semantik comparator: label non-numerik ("extra") kalah dari kandidat
/// numerik, jadi `prev` memilih "extra" hanya kalau tak ada kandidat
/// numerik yang lebih kecil. Tidak ada case khusus — murni
/// `cmp_chapter_number`.
#[tokio::test]
async fn label_non_numerik_kalah_dari_kandidat_numerik() {
    // Sumber pelayan ["2","1"], sumber lain ["extra"].
    // Baca "1" -> prev lintas sumber = "extra" (tak ada kandidat numerik
    // lebih kecil di sumber lain).
    let agg = dua_sumber(&["2", "1"], &["extra"]);
    let out = agg
        .read_chapter_any("komiku:a1", "1", None, 30)
        .await
        .expect("baca chapter 1");
    let prev = out.prev.expect("prev lintas sumber");
    assert_eq!(ref_hasil(&prev), ("extra", "shinigami", "shinigami:b1"));

    // Sumber lain punya "0" (numerik) -> "0" menang atas "extra" (terbesar
    // di antara yang lebih kecil).
    let agg2 = dua_sumber(&["2", "1"], &["extra", "0"]);
    let out2 = agg2
        .read_chapter_any("komiku:a1", "1", None, 30)
        .await
        .expect("baca chapter 1");
    let prev = out2.prev.expect("prev lintas sumber");
    assert_eq!(ref_hasil(&prev), ("0", "shinigami", "shinigami:b1"));
}

/// Guard pemotongan: daftar sumber pelayan yang TERPOTONG (panjang ==
/// `cap`) bisa menyembunyikan chapter lebih tua miliknya sendiri. Kalau
/// begitu, `prev` TIDAK boleh diambil dari sumber lain (bisa melompati
/// chapter yang sebenarnya milik sumber pelayan).
///
/// Catatan urutan: daftar chapter sumber = terbaru-dulu, jadi `truncate`
/// membuang yang PALING TUA. Tepi bawah (`prev` = None)-lah yang bisa jadi
/// artefak pemotongan; tepi atas (`next`) selalu jujur.
#[tokio::test]
async fn prev_tidak_lintas_sumber_kalau_daftar_pelayan_terpotong() {
    // `cap` = max(limit, READ_CHAPTERS_MIN=50). Daftar pelayan 50 chapter
    // (tepat sama cap) = mungkin terpotong; 49 chapter = pasti utuh.
    let all: Vec<String> = (1..=50).map(|i| i.to_string()).collect();
    // Terbaru-dulu: ["50","49",...,"1"].
    let mut newest_first: Vec<&str> = all.iter().map(|s| s.as_str()).collect();
    newest_first.reverse();

    // Kasus 1: 50 chapter (== cap) -> prev di tepi bawah tidak boleh
    // lintas sumber, walau sumber lain punya "0".
    let agg = Aggregator::new(vec![
        Arc::new(Mock::new("komiku", JUDUL, "a1").with(&newest_first)),
        Arc::new(Mock::new("shinigami", JUDUL, "b1").with(&["49", "0"])),
    ]);
    let out = agg
        .read_chapter_any("komiku:a1", "1", None, 30)
        .await
        .expect("baca chapter 1");
    assert!(out.prev.is_none(), "prev harus None (daftar terpotong): {:?}", out.prev);
    // next tetap dari sumber pelayan.
    let next = out.next.expect("next dari sumber pelayan");
    assert_eq!(ref_hasil(&next), ("2", "komiku", "komiku:a1"));

    // Kasus 2: 49 chapter (< cap) -> daftar utuh, prev boleh lintas sumber.
    // `truncate` membuang yang paling TUA, jadi daftar 49 = ["50".."2"].
    let shorter: Vec<&str> = newest_first[..49].to_vec();
    let agg2 = Aggregator::new(vec![
        Arc::new(Mock::new("komiku", JUDUL, "a1").with(&shorter)),
        Arc::new(Mock::new("shinigami", JUDUL, "b1").with(&["49", "0"])),
    ]);
    let out2 = agg2
        .read_chapter_any("komiku:a1", "2", None, 30)
        .await
        .expect("baca chapter 2");
    let prev = out2.prev.expect("prev lintas sumber");
    assert_eq!(ref_hasil(&prev), ("0", "shinigami", "shinigami:b1"));
}
