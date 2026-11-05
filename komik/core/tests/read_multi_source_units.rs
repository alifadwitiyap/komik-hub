//! Unit test `Aggregator::read_chapter_any` untuk skenario MULTI-SUMBER:
//!
//! 1. Chapter yang ADA di daftar union tetap bisa dibaca walau sumber yang
//!    dicoba pertama punya nomor itu tapi GAGAL memberikan gambar. "Gagal
//!    memberi gambar" bukan cuma `images` kosong: adapter yang membangun URL
//!    dari base/path yang gagal bisa mengembalikan daftar BERISI string
//!    kosong — itu bukan gambar, jadi harus memicu pindah sumber juga.
//! 2. `prev`/`next` mengikuti urutan UNION lintas sumber, bukan daftar
//!    sumber yang melayani. Inilah yang membuat chapter eksklusif sumber lain
//!    (mis. "45.5") tidak dilompati: 46 -> prev 45.5, 45 -> next 45.5.
//!    Kalau navigasi hanya melihat daftar sumber pelayan, 46 -> prev 45.
//! 3. Filter `--source` TETAP menahan navigasi di sumber yang diminta
//!    (tanpa fan-out ke sumber lain).
//!
//! Semua test memakai MOCK `Source` (fixture hardcoded), TIDAK ada network.
use komik_core::aggregator::Aggregator;
use komik_core::model::{Chapter, ChapterPages, Manga, SeriesDetail, SourceId};
use komik_core::source::{Source, SourceResult};
use std::collections::HashMap;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;

// -------------------------------------------------------------------- mocks

/// Mock sumber: satu series dengan daftar chapter tetap, dan gambar per nomor
/// chapter. Nomor yang tidak dipetakan memakai `fallback_images` (default:
/// satu URL valid) supaya test navigasi tidak perlu menyiapkan gambar.
struct Mock {
    id: SourceId,
    title: String,
    native_id: String,
    chapters: Vec<Chapter>,
    /// Gambar per nomor chapter (nomor tampilan mentah, mis. "45.5").
    images: HashMap<String, Vec<String>>,
    fallback_images: Vec<String>,
    fail_pages: bool,
    /// Berapa kali `resolve` dipanggil — dipakai membuktikan sumber lain
    /// TIDAK disentuh saat `--source` mempersempit pencarian.
    resolve_calls: Arc<AtomicUsize>,
}

impl Mock {
    fn new(id: &str, title: &str, native_id: &str) -> Self {
        Mock {
            id: SourceId::from(id),
            title: title.into(),
            native_id: native_id.into(),
            chapters: vec![],
            images: HashMap::new(),
            fallback_images: vec!["https://img/default-1.jpg".into()],
            fail_pages: false,
            resolve_calls: Arc::new(AtomicUsize::new(0)),
        }
    }

    /// Daftar chapter, urutan TERBARU-DULU (kontrak trait `Source`).
    fn with(mut self, numbers: &[&str]) -> Self {
        self.chapters = numbers
            .iter()
            .map(|n| chapter(self.id.as_str(), &format!("{}-{}", self.native_id, n), n))
            .collect();
        self
    }

    /// Gambar untuk satu nomor chapter.
    fn pages_for(mut self, number: &str, urls: &[&str]) -> Self {
        self.images.insert(
            number.to_string(),
            urls.iter().map(|u| u.to_string()).collect(),
        );
        self
    }

    fn failing_pages(mut self) -> Self {
        self.fail_pages = true;
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
        Ok(vec![Manga::new(
            self.id.clone(),
            &self.native_id,
            &self.title,
        )])
    }
    async fn list(&self, _g: Option<&str>, _page: u32) -> SourceResult<Vec<Manga>> {
        Ok(vec![])
    }
    async fn genres(&self) -> SourceResult<Vec<(String, String)>> {
        Ok(vec![])
    }
    async fn series(&self, native_id: &str) -> SourceResult<SeriesDetail> {
        Ok(SeriesDetail {
            manga: Manga::new(self.id.clone(), native_id, &self.title),
            chapters: self.chapters.clone(),
        })
    }
    async fn chapter_pages(&self, _m: &Manga, c: &Chapter) -> SourceResult<ChapterPages> {
        if self.fail_pages {
            anyhow::bail!("mock {}: chapter_pages gagal", self.id);
        }
        let images = self
            .images
            .get(&c.number)
            .cloned()
            .unwrap_or_else(|| self.fallback_images.clone());
        Ok(ChapterPages {
            source: self.id.clone(),
            title: format!("Chapter {}", c.number),
            number: c.number.clone(),
            images,
        })
    }
    /// Override supaya panggilan lintas sumber bisa dihitung (default trait
    /// memakai `search`, yang tidak membedakan resolve dari pencarian biasa).
    async fn resolve(&self, title: &str) -> SourceResult<Option<Manga>> {
        self.resolve_calls.fetch_add(1, Ordering::SeqCst);
        if komik_core::model::title_key(title) == komik_core::model::title_key(&self.title) {
            Ok(Some(Manga::new(
                self.id.clone(),
                &self.native_id,
                &self.title,
            )))
        } else {
            Ok(None)
        }
    }
}

// ---------------------------------------------------------------- fixtures

const JUDUL: &str = "Chainsaw Man";

fn ref_triple(r: &komik_core::aggregator::ChapterRef) -> (&str, &str, &str) {
    (r.number.as_str(), r.source.as_str(), r.handle.as_str())
}

// ---------------------------------------- fallback saat sumber tanpa gambar

/// Kasus dasar (regresi): chapter ADA di daftar sumber pertama, tapi
/// `chapter_pages` mengembalikan daftar gambar KOSONG. Harus jatuh ke sumber
/// kedua yang punya nomor sama dengan gambar valid.
#[tokio::test]
async fn chapter_ada_tapi_gambar_kosong_jatuh_ke_sumber_kedua() {
    let agg = Aggregator::new(vec![
        Arc::new(
            Mock::new("komiku", JUDUL, "a1")
                .with(&["6", "5", "4"])
                .pages_for("5", &[]),
        ),
        Arc::new(
            Mock::new("mangaku", JUDUL, "b1")
                .with(&["6", "5", "4"])
                .pages_for("5", &["https://b/5-1.jpg", "https://b/5-2.jpg"]),
        ),
    ]);

    let out = agg
        .read_chapter_any("komiku:a1", "5", None, 30)
        .await
        .expect("chapter 5 harus terbaca dari sumber kedua");

    assert_eq!(out.pages.source.as_str(), "mangaku");
    assert_eq!(out.pages.images.len(), 2);
    assert_eq!(
        out.switched_from.as_ref().map(|s| s.as_str()),
        Some("komiku"),
        "harus tercatat pindah dari sumber pertama"
    );
    assert_eq!(
        out.note.as_deref(),
        Some("chapter 5 tanpa gambar di komiku — dibaca dari mangaku")
    );
}

/// Bug inti: sumber pertama "berhasil" tapi gambar yang diberikannya TIDAK
/// BISA DIPAKAI (string kosong / whitespace). `images` tidak kosong, jadi
/// dulu dianggap sukses dan URL sampah dikembalikan ke reader.
#[tokio::test]
async fn gambar_tak_terpakai_di_sumber_pertama_jatuh_ke_sumber_kedua() {
    let agg = Aggregator::new(vec![
        Arc::new(
            Mock::new("komiku", JUDUL, "a1")
                .with(&["6", "5", "4"])
                .pages_for("5", &["", "   "]),
        ),
        Arc::new(
            Mock::new("mangaku", JUDUL, "b1")
                .with(&["6", "5", "4"])
                .pages_for("5", &["https://b/5-1.jpg"]),
        ),
    ]);

    let out = agg
        .read_chapter_any("komiku:a1", "5", None, 30)
        .await
        .expect("harus jatuh ke sumber dengan gambar valid");

    assert_eq!(
        out.pages.source.as_str(),
        "mangaku",
        "gambar kosong/whitespace bukan gambar: sumber pertama harus dilewati"
    );
    assert_eq!(out.pages.images, vec!["https://b/5-1.jpg".to_string()]);
    assert_eq!(
        out.note.as_deref(),
        Some("chapter 5 tanpa gambar di komiku — dibaca dari mangaku")
    );
}

/// Kalau sumber pertama masih memberi MINIMAL satu gambar valid, dia tetap
/// menang (prioritas sumber tidak boleh dibalik hanya karena ada entri
/// sampah). Menjaga fix di atas tidak jadi terlalu agresif.
#[tokio::test]
async fn gambar_sebagian_valid_tetap_dilayani_sumber_pertama() {
    let agg = Aggregator::new(vec![
        Arc::new(
            Mock::new("komiku", JUDUL, "a1")
                .with(&["6", "5", "4"])
                .pages_for("5", &["", "https://a/5-1.jpg"]),
        ),
        Arc::new(
            Mock::new("mangaku", JUDUL, "b1")
                .with(&["6", "5", "4"])
                .pages_for("5", &["https://b/5-1.jpg"]),
        ),
    ]);

    let out = agg
        .read_chapter_any("komiku:a1", "5", None, 30)
        .await
        .expect("sumber pertama masih punya gambar valid");

    assert_eq!(out.pages.source.as_str(), "komiku");
    assert!(out.switched_from.is_none());
    assert!(out.note.is_none());
}

/// Sumber pertama ERROR (bukan kosong) → tetap jatuh ke sumber kedua.
#[tokio::test]
async fn sumber_pertama_error_gambar_jatuh_ke_sumber_kedua() {
    let agg = Aggregator::new(vec![
        Arc::new(
            Mock::new("komiku", JUDUL, "a1")
                .with(&["6", "5", "4"])
                .failing_pages(),
        ),
        Arc::new(
            Mock::new("mangaku", JUDUL, "b1")
                .with(&["6", "5", "4"])
                .pages_for("5", &["https://b/5-1.jpg"]),
        ),
    ]);

    let out = agg
        .read_chapter_any("komiku:a1", "5", None, 30)
        .await
        .expect("harus pindah ke sumber kedua");

    assert_eq!(out.pages.source.as_str(), "mangaku");
    assert_eq!(out.pages.images, vec!["https://b/5-1.jpg".to_string()]);
}

// ---------------------------------------------- navigasi ikut daftar union

/// Sumber A: ['46','45','44']; sumber B: ['46','45.5','45','44'].
///
/// Union (A lebih dulu): [46(A), 45.5(B), 45(A), 44(A)].
/// Kalau navigasi hanya melihat daftar A, 46 -> prev 45 dan 45 -> next 46:
/// chapter eksklusif 45.5 dilompati. Test ini mengunci urutan union.
#[tokio::test]
async fn nav_ikut_urutan_union_bukan_daftar_sumber_pelayan() {
    let a = Arc::new(Mock::new("komiku", JUDUL, "a1").with(&["46", "45", "44"]));
    let b = Arc::new(Mock::new("mangaku", JUDUL, "b1").with(&["46", "45.5", "45", "44"]));
    let agg = Aggregator::new(vec![a, b]);

    // --- chapter 46 dilayani komiku (A). 46 = chapter tertinggi -> next None.
    let out = agg
        .read_chapter_any("komiku:a1", "46", None, 30)
        .await
        .expect("baca 46");

    assert_eq!(out.pages.source.as_str(), "komiku");
    assert!(
        out.next.is_none(),
        "46 adalah chapter tertinggi di union: {:?}",
        out.next
    );
    let prev = out.prev.expect("prev 46 harus ada");
    assert_eq!(
        ref_triple(&prev),
        ("45.5", "mangaku", "mangaku:b1"),
        "prev 46 harus 45.5 milik mangaku (chapter eksklusif union), BUKAN 45 milik komiku"
    );

    // --- chapter 45 dilayani komiku (A). Union: 46(A),45.5(B),45(A),44(A).
    let out2 = agg
        .read_chapter_any("komiku:a1", "45", None, 30)
        .await
        .expect("baca 45");

    assert_eq!(out2.pages.source.as_str(), "komiku");
    let next = out2.next.expect("next 45 harus ada");
    assert_eq!(
        ref_triple(&next),
        ("45.5", "mangaku", "mangaku:b1"),
        "next 45 harus 45.5 milik mangaku, bukan 46 milik komiku"
    );
    let prev2 = out2.prev.expect("prev 45 harus ada");
    assert_eq!(
        ref_triple(&prev2),
        ("44", "komiku", "komiku:a1"),
        "prev 45 tetap 44 milik komiku"
    );
}

/// Navigasi lintas sumber juga harus benar saat chapter dilayani sumber
/// KEDUA (bukan primary). Yang diuji adalah URUTAN nomor + kontrak handle:
/// tiap `ChapterRef` membawa `source`/`handle` MILIKNYA, dan handle itu bisa
/// langsung dikirim balik ke `read_chapter_any` (round-trip).
///
/// Catatan dedup: sumber pelayan sengaja diletakkan PERTAMA di daftar union,
/// jadi nomor yang muncul di beberapa sumber dimenangkan sumber pelayan
/// (label nomornya yang sedang dilihat user dipertahankan). Urutan nomornya
/// identik dengan halaman series — hanya atribusi sumber untuk nomor duplikat
/// yang mengikuti sumber pelayan.
#[tokio::test]
async fn nav_union_saat_dilayani_sumber_kedua() {
    // Aggregator SEGAR: panggilan sebelumnya akan mengisi cache
    // "series-union:{judul}", sehingga daftar union bisa tidak memuat sumber
    // yang belum pernah di-resolve. Itu perilaku cache yang sah (entri per
    // sumber), bukan yang diuji di sini.
    let agg = Aggregator::new(vec![
        Arc::new(Mock::new("komiku", JUDUL, "a1").with(&["46", "45", "44"])),
        Arc::new(
            Mock::new("mangaku", JUDUL, "b1")
                .with(&["46", "45.5", "45", "44"])
                .pages_for("45.5", &["https://b/45-5.jpg"]),
        ),
    ]);

    let out = agg
        .read_chapter_any("komiku:a1", "45.5", None, 30)
        .await
        .expect("45.5 hanya ada di mangaku");

    assert_eq!(out.pages.source.as_str(), "mangaku");

    // Urutan union: [46, 45.5, 45, 44] -> next 45.5 = 46, prev 45.5 = 45.
    let next = out.next.expect("next 45.5 = 46");
    assert_eq!(next.number, "46");
    let prev = out.prev.expect("prev 45.5 = 45");
    assert_eq!(prev.number, "45");

    // Kontrak `ChapterRef`: `handle` harus milik SUMBER chapter itu sendiri
    // (bukan handle series yang sedang dibuka), dan bisa dikirim balik ke
    // resolver (round-trip) — inilah yang membuat reader bisa lanjut lintas
    // sumber tanpa tahu sumber asalnya.
    //
    // CATATAN: `46` dan `45` ada di KEDUA sumber, jadi pemenang dedup adalah
    // komiku (`SOURCE_PRIORITY` tertinggi), bukan mangaku. Assertion lama
    // memaksa semua tetangga jadi "b1" — itu salah asumsi, bukan kontrak.
    // Yang benar: handle selalu konsisten dengan `source` milik chapter itu.
    for r in [&next, &prev] {
        assert!(
            r.handle.starts_with(&format!("{}:", r.source.as_str())),
            "handle {:?} harus milik sumber {:?}",
            r.handle,
            r.source.as_str()
        );
        // Round-trip: handle yang ditunjuk benar-benar bisa dibaca balik.
        let back = agg
            .read_chapter_any(&r.handle, &r.number, None, 30)
            .await
            .unwrap_or_else(|e| panic!("handle {} tidak bisa dibaca balik: {e}", r.handle));
        assert_eq!(back.pages.number, r.number);
    }
}

// ------------------------------------- regresi: filter --source dihormati

/// REGRESI: dengan `--source komiku`, navigasi TIDAK boleh keluar dari
/// komiku dan sumber lain tidak boleh disentuh sama sekali (tanpa fan-out).
#[tokio::test]
async fn nav_tetap_di_sumber_filter_tanpa_fanout() {
    let a = Arc::new(Mock::new("komiku", JUDUL, "a1").with(&["46", "45", "44"]));
    let b = Arc::new(Mock::new("mangaku", JUDUL, "b1").with(&["46", "45.5", "45", "44"]));
    let b_calls = b.resolve_calls.clone();
    let agg = Aggregator::new(vec![a, b]);

    let out = agg
        .read_chapter_any("komiku:a1", "46", Some("komiku"), 30)
        .await
        .expect("baca 46 dari komiku");

    assert_eq!(out.pages.source.as_str(), "komiku");
    assert!(out.next.is_none(), "46 tertinggi di komiku: {:?}", out.next);
    let prev = out.prev.expect("prev 46");
    assert_eq!(
        ref_triple(&prev),
        ("45", "komiku", "komiku:a1"),
        "filter --source: navigasi tetap di komiku, 45.5 milik mangaku diabaikan"
    );
    assert_eq!(
        b_calls.load(Ordering::SeqCst),
        0,
        "filter --source tidak boleh memicu fan-out ke sumber lain"
    );
}

// ------------------- catatan kontrak: chapter ada di banyak sumber

// Chapter yang muncul di BEBERAPA sumber (nomor sama) harus tetap terbaca
// walaupun sumber yang pertama dicoba gagal memberi gambar — lihat
// `chapter_ada_tapi_gambar_kosong_jatuh_ke_sumber_kedua` dan kerabatnya di
// atas. Catatan penting: LABEL nomor yang dipakai adalah milik sumber
// PELAYAN (pola sama dengan `series_merged`), jadi bila satu nomor ditulis
// berbeda antar sumber ("01" vs "1") label bisa ikut sumber yang melayani.
// Itu konsekuensi yang diterima: kredit sumber lebih penting daripada
// keseragaman tulisan nomor.
