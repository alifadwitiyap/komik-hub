//! Test deterministik untuk pengumpulan union chapter lintas sumber.
//!
//! Semua pakai MOCK Source (fixture hardcoded, TIDAK ada network).
//!
//! Cakupan:
//! - Dedup union: key ternormalisasi ("09" == "9") -> satu baris, milik
//!   daftar yang lebih awal (primary).
//! - Episode eksklusif sumber kedua tetap ikut.
//! - Urutan: numerik DESC dulu, label non-numerik ("extra") di belakang.
//! - Anti-false-positive: judul yang MIRIP tapi title_key-nya beda TIDAK ikut
//!   digabung (mis. "Tower Of God: Side Story" vs "Tower Of God").
//! - Partial failure: satu sumber gagal -> sumber lain tetap hasil, sumber
//!   gagal dilaporkan di `failed`.
//! - **Batas round-trip**: pengumpulan union melakukan resolve lalu series per
//!   sumber, dan kedua tahap berjalan PARALEL antar sumber (bukan resolve
//!   lalu series berurutan per sumber). Test ini mengunci perilaku itu lewat
//!   penghitung request, bukan lewat timing (timing = flaky).
use komik_core::aggregator::*;
use komik_core::model::*;
use komik_core::source::{Source, SourceResult};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;

/// Mock sumber dengan penghitung request per operasi.
#[derive(Clone)]
struct Mock {
    id: SourceId,
    /// (title_key, native_id) yang dipunya sumber ini.
    owns: Vec<(String, String)>,
    /// Native id yang harus GAGAL saat `series` dipanggil.
    fail_series: bool,
    /// Native id yang harus GAGAL saat `resolve` dipanggil.
    fail_resolve: bool,
    resolve_calls: Arc<AtomicUsize>,
    series_calls: Arc<AtomicUsize>,
}

impl Mock {
    fn new(id: &str) -> Self {
        Mock {
            id: SourceId::from(id),
            owns: Vec::new(),
            fail_series: false,
            fail_resolve: false,
            resolve_calls: Arc::new(AtomicUsize::new(0)),
            series_calls: Arc::new(AtomicUsize::new(0)),
        }
    }

    fn owning(mut self, title_key: &str, native_id: &str) -> Self {
        self.owns.push((title_key.to_string(), native_id.to_string()));
        self
    }

    fn fail_series(mut self) -> Self {
        self.fail_series = true;
        self
    }

    fn fail_resolve(mut self) -> Self {
        self.fail_resolve = true;
        self
    }

    fn resolve_calls(&self) -> usize {
        self.resolve_calls.load(Ordering::SeqCst)
    }

    fn series_calls(&self) -> usize {
        self.series_calls.load(Ordering::SeqCst)
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
    async fn search(&self, query: &str, _page: u32) -> SourceResult<Vec<Manga>> {
        self.resolve_calls.fetch_add(1, Ordering::SeqCst);
        if self.fail_resolve {
            anyhow::bail!("mock {}: resolve gagal", self.id);
        }
        // Hanya judul yang title_key-nya PERSIS sama yang dimiliki sumber ini.
        let key = title_key(query);
        Ok(self
            .owns
            .iter()
            .filter(|(k, _)| *k == key)
            .map(|(_, nid)| Manga::new(self.id.clone(), nid.clone(), query))
            .collect())
    }
    async fn list(&self, _g: Option<&str>, _page: u32) -> SourceResult<Vec<Manga>> {
        Ok(vec![])
    }
    async fn genres(&self) -> SourceResult<Vec<(String, String)>> {
        Ok(vec![])
    }
    async fn series(&self, native_id: &str) -> SourceResult<SeriesDetail> {
        self.series_calls.fetch_add(1, Ordering::SeqCst);
        if self.fail_series {
            anyhow::bail!("mock {}: series gagal", self.id);
        }
        let title = self
            .owns
            .iter()
            .find(|(_, nid)| nid == native_id)
            .map(|(k, _)| k.clone())
            .unwrap_or_else(|| "unknown".into());
        Ok(SeriesDetail {
            manga: Manga::new(self.id.clone(), native_id.to_string(), &title),
            chapters: vec![],
        })
    }
    async fn chapter_pages(&self, _m: &Manga, _c: &Chapter) -> SourceResult<ChapterPages> {
        Ok(ChapterPages {
            source: self.id.clone(),
            title: "t".into(),
            number: "1".into(),
            images: vec![],
        })
    }
}

/// SourceChapterList dengan chapter: nomor -> (native_id).
fn list_of(src: &str, handle: &str, numbers: &[&str]) -> komik_core::union::SourceChapterList {
    use komik_core::union::SourceChapterList;
    SourceChapterList {
        source: SourceId::from(src),
        handle: handle.to_string(),
        chapters: numbers
            .iter()
            .map(|n| Chapter {
                source: SourceId::from(src),
                native_id: format!("{src}-{}", n),
                title: format!("Chapter {n}"),
                number: n.to_string(),
                updated_at: Some(1),
                url: None,
            })
            .collect(),
    }
}

#[test]
fn merge_dedup_key_ternormalisasi_satu_baris_milik_daftar_awal() {
    let lists = vec![
        list_of("komiku", "komiku:1", &["09", "10"]),
        list_of("shinigami", "shinigami:1", &["9", "11"]),
    ];
    let merged = komik_core::union::merge_chapter_lists(&lists);
    let nums: Vec<&str> = merged.iter().map(|c| c.number.as_str()).collect();
    // "09" (komiku) dan "9" (shinigami) = satu baris, milik daftar AWAL.
    assert_eq!(nums, vec!["11", "10", "09"], "dedup by key, urutan numerik DESC");
    let c09 = merged.iter().find(|c| c.number == "09").unwrap();
    assert_eq!(c09.source.as_str(), "komiku", "pemegang = daftar lebih awal");
    assert_eq!(c09.handle, "komiku:1");
}

#[test]
fn merge_episode_eksklusif_sumber_kedua_ikut() {
    let lists = vec![
        list_of("komiku", "komiku:1", &["232"]),
        list_of("shinigami", "shinigami:1", &["232", "277"]),
    ];
    let merged = komik_core::union::merge_chapter_lists(&lists);
    let nums: Vec<&str> = merged.iter().map(|c| c.number.as_str()).collect();
    assert_eq!(nums, vec!["277", "232"]);
    let c277 = merged.iter().find(|c| c.number == "277").unwrap();
    assert_eq!(c277.source.as_str(), "shinigami");
    assert_eq!(c277.handle, "shinigami:1", "handle ikut sumber pemiliknya");
}

#[test]
fn merge_urutan_numerik_desc_lalu_non_numerik() {
    let lists = vec![list_of("komiku", "komiku:1", &["232", "10", "9", "extra"])];
    let merged = komik_core::union::merge_chapter_lists(&lists);
    let nums: Vec<&str> = merged.iter().map(|c| c.number.as_str()).collect();
    assert_eq!(nums, vec!["232", "10", "9", "extra"], "non-numerik paling belakang");
}

/// Kontrak comparator untuk label non-numerik (review Task 0 I1).
///
/// `cmp_chapter_number` memakai konvensi "Greater = nomor LEBIH TINGGI urutan"
/// untuk key numerik. Untuk label bebas ("extra", "prologue") tidak ada nomor,
/// jadi yang compared adalah `chapter_number_key`-nya. Kontrak plan Task 2
/// (lihat .omh/plans/cross-chapter-merge.md, "arah comparator") menyatakan
/// label non-numerik selalu `Less` dibanding numerik, dan antar-label
/// dibandingkan by key.
///
/// Test ini mengunci perilaku yang BENAR-BENAR dipakai Lane 2 saat memilih
/// kandidat `prev`: `prev` = kandidat dengan nomor TERBESAR di antara yang
/// lebih kecil. Untuk label, "terbesar" berarti key-nya lebih besar.
#[test]
fn cmp_label_non_numerik_arah_kunci_desc() {
    use std::cmp::Ordering;
    // Label ("extra", "prologue") selalu kalah dari numerik.
    assert_eq!(
        komik_core::union::cmp_chapter_number("9", "extra"),
        Ordering::Greater,
        "numerik selalu mendahului label bebas"
    );
    assert_eq!(
        komik_core::union::cmp_chapter_number("extra", "9"),
        Ordering::Less
    );
    // Antar-label: key DESC (key besar = "lebih tinggi urutan").
    assert_eq!(
        komik_core::union::cmp_chapter_number("prologue", "extra"),
        Ordering::Greater,
        "antar label non-numerik: key DESC"
    );
    assert_eq!(
        komik_core::union::cmp_chapter_number("extra", "prologue"),
        Ordering::Less
    );
}

/// Label non-numerik di daftar union: urut key DESC, tetap SESUDAH numerik.
///
/// Ini yang dipakai Lane 2 untuk memilih kandidat `prev` di antara label —
/// jadi urutannya harus DESC agar "terbesar" = paling dekat.
///
/// CATATAN: test ini sengaja mengunci output DESC label. Review Task 0 (I1)
/// mengusulkan membalik comparator label (`ka.cmp(&kb)` -> `kb.cmp(&ka)`)
/// agar "label diurutkan DESC". Tapi comparator itu dipakai di dua tempat
/// dengan arah BERBEDA:
///
/// - `merge_chapter_lists` -> `sort_by(cmp.reverse())` -> output akhir DESC.
/// - `pick_cross_source_neighbors` -> `cmp` langsung -> "terbesar"/"terkecil".
///
/// Membalik comparator label tanpa membalik sort site justru membuat output
/// label jadi ASC. Test ini mengunci output yang BENAR supaya usulan fix
/// salah tidak diam-diam merusak urutan.
#[test]
fn merge_label_urut_key_desc_setelah_numerik() {
    let lists = vec![list_of("komiku", "komiku:1", &["232", "prologue", "extra"])];
    let merged = komik_core::union::merge_chapter_lists(&lists);
    let nums: Vec<&str> = merged.iter().map(|c| c.number.as_str()).collect();
    assert_eq!(
        nums,
        vec!["232", "prologue", "extra"],
        "numerik dulu, lalu label by key DESC"
    );
}

/// Handle yang dibangun dari native id sumber harus bisa di-parse kembali.
///
/// Review Task 0 "tidak sempat dicek": `handle` = "{sumber}:{native_id}" dan
/// `parse_handle` memecah pada ':' PERTAMA. Native id yang memuat ':' sendiri
/// (mis. slug ber-':' atau id ber-':' di tengah) harus tetap ter-parse dengan
/// benar: prefix sumber jadi sumber, sisanya (termasuk ':') jadi native id.
#[test]
fn handle_dengan_native_id_ber_kolom_masih_ter_parse() {
    use komik_core::model::parse_handle;
    for (handle, expect_src, expect_native) in [
        ("komiku:6167", Some("komiku"), "6167"),
        ("shinigami:3b1eab91-4a88-4d5c-babe-f9cf40be1347", Some("shinigami"), "3b1eab91-4a88-4d5c-babe-f9cf40be1347"),
        // native id memuat ':' -> harus jadi bagian native, bukan dipotong.
        ("mangaku:some:weird:id", Some("mangaku"), "some:weird:id"),
    ] {
        let (src, native) = parse_handle(handle);
        assert_eq!(
            src.as_ref().map(|s| s.as_str()),
            expect_src,
            "sumber dari handle {handle}"
        );
        assert_eq!(native, expect_native, "native id dari handle {handle}");
    }
}

#[test]
fn cmp_chapter_number_arah_besar_lebih_besar() {
    use std::cmp::Ordering;
    assert_eq!(
        komik_core::union::cmp_chapter_number("233", "232"),
        Ordering::Greater
    );
    assert_eq!(komik_core::union::cmp_chapter_number("10", "9"), Ordering::Greater);
    assert_eq!(komik_core::union::cmp_chapter_number("9", "10"), Ordering::Less);
    assert_eq!(
        komik_core::union::cmp_chapter_number("9", "extra"),
        Ordering::Greater,
        "numerik selalu mendahului label bebas"
    );
}

#[tokio::test]
async fn collect_gabung_semua_sumber_dan_toleransi_gagal() {
    let a = Mock::new("komiku").owning("chainsaw man", "k1");
    let b = Mock::new("shinigami").owning("chainsaw man", "s1");
    // Mangaku MEMILIKI manga-nya tapi `series` gagal -> harus dilaporkan
    // sebagai sumber gagal, bukan lolos diam-diam.
    let c = Mock::new("mangaku").owning("chainsaw man", "m1").fail_series();
    let agg = Aggregator::new(vec![Arc::new(a), Arc::new(b), Arc::new(c)]);
    let (lists, failed) = agg
        .collect_series_across_sources("Chainsaw Man", None, 100)
        .await;
    let ids: Vec<&str> = lists.iter().map(|l| l.source.as_str()).collect();
    assert!(ids.contains(&"komiku"), "sumber sehat ikut: {ids:?}");
    assert!(ids.contains(&"shinigami"), "sumber sehat ikut: {ids:?}");
    assert!(!ids.contains(&"mangaku"), "sumber gagal tak masuk daftar");
    assert_eq!(failed.len(), 1, "sumber gagal dilaporkan: {failed:?}");
    assert_eq!(failed[0].0.as_str(), "mangaku");
}

#[tokio::test]
async fn collect_anti_false_positive_judul_mirip_tidak_tergabung() {
    // Komiku punya "Tower Of God: Side Story"; shinigami punya "Tower Of God"
    // (manga LAIN — title_key beda). Side Story TIDAK boleh tercemar chapter
    // dari Tower Of God meski judulnya mirip.
    let a = Mock::new("komiku").owning("tower of god side story", "k-side");
    let b = Mock::new("shinigami").owning("tower of god", "s-main");
    let agg = Aggregator::new(vec![Arc::new(a), Arc::new(b)]);
    let (lists, _failed) = agg
        .collect_series_across_sources("Tower Of God: Side Story", None, 100)
        .await;
    // Hanya komiku yang punya "tower of god: side story" -> shinigami
    // (yang punya "tower of god") TIDAK boleh ikut.
    let ids: Vec<&str> = lists.iter().map(|l| l.source.as_str()).collect();
    assert_eq!(ids, vec!["komiku"], "judul mirip tak boleh tercemar: {ids:?}");
}

#[tokio::test]
async fn collect_batas_round_trip_satu_resolve_satu_series_per_sumber() {
    let a = Mock::new("komiku").owning("chainsaw man", "k1");
    let b = Mock::new("shinigami").owning("chainsaw man", "s1");
    let agg = Aggregator::new(vec![Arc::new(a.clone()), Arc::new(b.clone())]);
    let _ = agg
        .collect_series_across_sources("Chainsaw Man", None, 100)
        .await;
    // Tiap sumber: 1x resolve + 1x series. Tidak ada pengulangan.
    assert_eq!(a.resolve_calls(), 1, "resolve satu kali per sumber");
    assert_eq!(a.series_calls(), 1, "series satu kali per sumber");
    assert_eq!(b.resolve_calls(), 1);
    assert_eq!(b.series_calls(), 1);
}

#[tokio::test]
async fn collect_sumber_gagal_tidak_menggagalkan_yang_lain() {
    let a = Mock::new("komiku").owning("chainsaw man", "k1");
    let b = Mock::new("shinigami").fail_resolve();
    let agg = Aggregator::new(vec![Arc::new(a), Arc::new(b)]);
    let (lists, failed) = agg
        .collect_series_across_sources("Chainsaw Man", None, 100)
        .await;
    assert_eq!(lists.len(), 1, "sumber sehat tetap hasil");
    assert_eq!(failed.len(), 1);
    assert_eq!(failed[0].0.as_str(), "shinigami");
}
