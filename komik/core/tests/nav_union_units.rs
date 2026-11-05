//! Unit test `pick_union_neighbors`: navigasi prev/next dari daftar chapter
//! UNION lintas sumber (bukan daftar satu sumber).
//!
//! Kenapa file ini ada: `neighbor_refs` hanya melihat daftar chapter SATU
//! sumber, dan `pick_cross_source_neighbors` hanya menyala di TEPI. Keduanya
//! tidak bisa menjawab "dari chapter 233 di sumber B, prev-nya 232 di sumber A".
//! `pick_union_neighbors` bekerja di daftar yang sudah di-merge
//! ([`merge_chapter_lists`]) sehingga tetangga selalu lintas sumber dan
//! `ChapterRef` membawa `source` + `handle` MILIK chapter itu sendiri.
//!
//! Semua test murni: tidak ada network, tidak ada Aggregator.
use komik_core::model::{Chapter, SourceId};
use komik_core::rank::{pick_union_neighbors, ChapterRef};
use komik_core::union::{merge_chapter_lists, MergedChapter, SourceChapterList};

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

/// Dua sumber dengan judul sama. Handle series BEDA per sumber — inilah yang
/// membuat `handle` di `ChapterRef` harus ikut chapter, bukan series primary.
///
/// Hasil `merge_chapter_lists` (terbaru-dulu):
/// `["277"(shinigami), "233"(shinigami), "232"(komiku), "09"(komiku), "extra"(shinigami)]`
fn dua_sumber() -> Vec<SourceChapterList> {
    vec![
        list("komiku", "komiku:6167", &[("k-09", "09"), ("k-232", "232")]),
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

fn merged_dua_sumber() -> Vec<MergedChapter> {
    merge_chapter_lists(&dua_sumber())
}

/// Chapter union buatan tangan (untuk kasus yang tidak butuh `merge`).
fn mc(src: &str, handle: &str, number: &str) -> MergedChapter {
    MergedChapter {
        number: number.into(),
        title: format!("Chapter {number}"),
        native_id: format!("{src}-{number}"),
        updated_at: Some(10),
        source: SourceId::from(src),
        handle: handle.into(),
    }
}

fn triple(r: &ChapterRef) -> (&str, &str, &str) {
    (r.number.as_str(), r.source.as_str(), r.handle.as_str())
}

fn opt_triple(r: &Option<ChapterRef>) -> Option<(&str, &str, &str)> {
    r.as_ref().map(triple)
}

// ------------------------------------------------------------------- tests

/// Kasus inti: tetangga diambil dari daftar UNION, jadi `prev`/`next` boleh
/// berasal dari sumber yang BERBEDA dengan chapter `current`.
#[test]
fn tetangga_dari_daftar_union_lintas_sumber() {
    let merged = merged_dua_sumber();
    let (prev, next) = pick_union_neighbors(&merged, "233");

    // prev = elemen index+1 (lebih tua) -> "232" milik komiku.
    assert_eq!(
        opt_triple(&prev),
        Some(("232", "komiku", "komiku:6167")),
        "prev harus chapter 232 dari komiku"
    );
    // next = elemen index-1 (lebih baru) -> "277" milik shinigami.
    assert_eq!(
        opt_triple(&next),
        Some(("277", "shinigami", "shinigami:3b1eab91")),
        "next harus chapter 277 dari shinigami"
    );
}

/// `ChapterRef` WAJIB membawa `source` + `handle` chapter itu sendiri, BUKAN
/// handle series primary (komiku:6167). Ini inti fitur cross-chapter: client
/// mengirim balik handle ini ke `read_chapter_any`.
#[test]
fn ref_membawa_handle_milik_chapter_bukan_handle_primary() {
    let merged = merged_dua_sumber();
    let (_prev, next) = pick_union_neighbors(&merged, "233");
    let next = next.expect("next harus ada");

    assert_eq!(next.source.as_str(), "shinigami");
    assert_eq!(next.handle, "shinigami:3b1eab91");
    assert_ne!(
        next.handle, "komiku:6167",
        "handle series primary tidak boleh dipakai untuk chapter sumber lain"
    );

    // Arah sebaliknya: dari chapter shinigami ke chapter komiku.
    let (prev, _next) = pick_union_neighbors(&merged, "233");
    let prev = prev.expect("prev harus ada");
    assert_eq!(prev.source.as_str(), "komiku");
    assert_eq!(prev.handle, "komiku:6167");
}

/// Identitas `chapter_number_key`: `current` "9" harus menemukan baris "09"
/// (bukan dianggap tidak ada lalu jatuh ke fallback posisi acak).
#[test]
fn identitas_09_sama_dengan_9() {
    let merged = merged_dua_sumber();
    let (prev, next) = pick_union_neighbors(&merged, "9");

    // Posisi "09" = index 3 -> next index 2 = "232", prev index 4 = "extra".
    assert_eq!(
        opt_triple(&next),
        Some(("232", "komiku", "komiku:6167")),
        "\"9\" harus cocok dengan baris \"09\""
    );
    assert_eq!(
        opt_triple(&prev),
        Some(("extra", "shinigami", "shinigami:3b1eab91")),
        "prev \"09\" = label non-numerik paling belakang"
    );
}

/// Identitas desimal: "179.60" == "179.6" — tidak boleh jatuh ke fallback.
#[test]
fn identitas_desimal_179_60_sama_dengan_179_6() {
    let merged = vec![
        mc("komiku", "komiku:1", "180"),
        mc("kiryuu", "kiryuu:2", "179.6"),
        mc("komiku", "komiku:1", "179"),
    ];
    let (prev, next) = pick_union_neighbors(&merged, "179.60");

    assert_eq!(opt_triple(&next), Some(("180", "komiku", "komiku:1")));
    assert_eq!(opt_triple(&prev), Some(("179", "komiku", "komiku:1")));
}

/// "extra" != "7": label non-numerik TIDAK boleh dianggap chapter 7.
/// Karena tidak ada yang cocok, fungsi jatuh ke fallback berbasis nomor, dan
/// "extra" (non-numerik) menempati posisi paling kecil -> jadi `prev`.
#[test]
fn label_extra_bukan_nomor_7() {
    let merged = vec![mc("shinigami", "shinigami:b1", "extra")];
    let (prev, next) = pick_union_neighbors(&merged, "7");

    assert_eq!(
        opt_triple(&prev),
        Some(("extra", "shinigami", "shinigami:b1")),
        "\"extra\" lebih kecil dari nomor apa pun, tapi bukan identitas \"7\""
    );
    assert_eq!(opt_triple(&next), None, "tidak ada nomor lebih besar dari 7");
}

/// Tepi daftar: elemen pertama tidak punya `next`, elemen terakhir tidak punya
/// `prev` (bukan error, bukan wrap-around).
#[test]
fn tepi_atas_dan_tepi_bawah_none() {
    let merged = merged_dua_sumber();

    let (prev_top, next_top) = pick_union_neighbors(&merged, "277");
    assert_eq!(next_top, None, "chapter terbaru tidak punya next");
    assert_eq!(opt_triple(&prev_top), Some(("233", "shinigami", "shinigami:3b1eab91")));

    let (prev_bottom, next_bottom) = pick_union_neighbors(&merged, "extra");
    assert_eq!(prev_bottom, None, "chapter tertua tidak punya prev");
    assert_eq!(opt_triple(&next_bottom), Some(("09", "komiku", "komiku:6167")));
}

/// `current` TIDAK ada di daftar -> fallback perbandingan nomor:
/// `next` = nomor lebih besar terkecil ("277"), `prev` = nomor lebih kecil
/// terbesar ("233"). Bukan posisi index.
#[test]
fn fallback_saat_current_tidak_ada() {
    let merged = merged_dua_sumber();
    let (prev, next) = pick_union_neighbors(&merged, "240");

    assert_eq!(
        opt_triple(&next),
        Some(("277", "shinigami", "shinigami:3b1eab91")),
        "suksesor terdekat dari 240 adalah 277"
    );
    assert_eq!(
        opt_triple(&prev),
        Some(("233", "shinigami", "shinigami:3b1eab91")),
        "predesesor terdekat dari 240 adalah 233"
    );
}

/// Fallback murni berbasis perbandingan: urutan slice yang TIDAK terurut tidak
/// mengubah hasil (kontrak `merged` terurut, tapi fallback tidak boleh
/// bergantung pada urutan).
#[test]
fn fallback_tidak_bergantung_urutan_daftar() {
    let merged = vec![
        mc("komiku", "komiku:1", "232"),
        mc("shinigami", "shinigami:b1", "277"),
        mc("komiku", "komiku:1", "09"),
        mc("shinigami", "shinigami:b1", "233"),
    ];
    let (prev, next) = pick_union_neighbors(&merged, "240");

    assert_eq!(opt_triple(&next), Some(("277", "shinigami", "shinigami:b1")));
    assert_eq!(opt_triple(&prev), Some(("233", "shinigami", "shinigami:b1")));
}

/// Fallback di luar rentang: tidak ada kandidat di satu sisi -> `None` sisi itu.
#[test]
fn fallback_di_luar_rentang() {
    let merged = merged_dua_sumber();

    // Lebih besar dari semua nomor -> next None, prev = nomor terbesar.
    let (prev, next) = pick_union_neighbors(&merged, "999");
    assert_eq!(next, None);
    assert_eq!(opt_triple(&prev), Some(("277", "shinigami", "shinigami:3b1eab91")));

    // Lebih kecil dari semua nomor -> prev None, next = nomor terkecil numerik.
    // Daftar sengaja numerik semua: label non-numerik ("extra") SELALU lebih
    // kecil dari numerik menurut `cmp_chapter_number`, jadi kalau "extra" ikut
    // di daftar, `prev` untuk "0" adalah "extra" (bukan None).
    let numerik = vec![
        mc("komiku", "komiku:6167", "09"),
        mc("komiku", "komiku:6167", "232"),
        mc("shinigami", "shinigami:3b1eab91", "277"),
    ];
    let (prev, next) = pick_union_neighbors(&numerik, "0");
    assert_eq!(prev, None);
    assert_eq!(opt_triple(&next), Some(("09", "komiku", "komiku:6167")));
}

/// Konsekuensi kontrak comparator: label non-numerik ("extra") lebih kecil dari
/// SEMUA nomor, jadi ia muncul sebagai `prev` saat `current` di bawah rentang
/// numerik — bukan `None`.
#[test]
fn fallback_label_non_numerik_jadi_prev_di_bawah_rentang() {
    let merged = merged_dua_sumber();
    let (prev, next) = pick_union_neighbors(&merged, "0");

    assert_eq!(
        opt_triple(&prev),
        Some(("extra", "shinigami", "shinigami:3b1eab91")),
        "\"extra\" lebih kecil dari \"0\" menurut cmp_chapter_number"
    );
    assert_eq!(opt_triple(&next), Some(("09", "komiku", "komiku:6167")));
}

/// Kontrak dari daftar UNION yang sudah ter-dedup: nomor chapter yang muncul di
/// BEBERAPA sumber (mis. "45.5" di komiku & shinigami) tetap SATU entri, dan
/// tetap jadi tetangga yang benar. Ini meniru kasus live: series shinigami
/// memuat "45.5" dari tiga sumber, dan navigasi tidak boleh melompati-nya.
#[test]
fn pick_union_neighbors_tetap_benar_saat_chapter_ada_di_banyak_sumber() {
    let lists = vec![
        list(
            "komiku",
            "komiku:865",
            &[("k-46", "46"), ("k-45.5", "45.5"), ("k-45", "45")],
        ),
        list(
            "shinigami",
            "shinigami:935b0a6e-1fcb-4ea4-b9ae-dcf6540a9f10",
            &[
                ("s-47", "47"),
                ("s-45.5", "45.5"),
                ("s-44", "44"),
            ],
        ),
    ];
    let merged = merge_chapter_lists(&lists);

    // Dedup: "45.5" dari dua sumber jadi SATU baris di union.
    let per_sembilan = merged.iter().filter(|c| c.number == "45.5").count();
    assert_eq!(
        per_sembilan, 1,
        "\"45.5\" harus satu entri setelah dedup: {merged:?}"
    );

    // Urutan union (terbaru-dulu): [47, 46, 45.5, 45, 44].
    let numbers: Vec<&str> = merged.iter().map(|c| c.number.as_str()).collect();
    assert_eq!(numbers, vec!["47", "46", "45.5", "45", "44"]);

    // Dari "45" (sebelum 45.5) -> next harus "45.5", bukan melompat ke "46".
    let (_prev, next) = pick_union_neighbors(&merged, "45");
    assert_eq!(
        opt_triple(&next),
        Some(("45.5", "komiku", "komiku:865")),
        "next dari 45 harus 45.5 (entri dedup yang ada di union)"
    );

    // Dari "46" (sesudah 45.5) -> prev harus "45.5".
    let (prev, _next) = pick_union_neighbors(&merged, "46");
    assert_eq!(
        opt_triple(&prev),
        Some(("45.5", "komiku", "komiku:865")),
        "prev dari 46 harus 45.5"
    );
}



/// Daftar kosong: bukan panic, kedua sisi `None`.
#[test]
fn daftar_kosong_menghasilkan_none() {
    let (prev, next) = pick_union_neighbors(&[], "1");
    assert_eq!(prev, None);
    assert_eq!(next, None);
}

/// Fungsi murni: panggilan berulang pada input sama menghasilkan hasil identik
/// dan tidak mengubah input (tidak ada state/urutan yang bergeser).
#[test]
fn murni_dan_deterministik() {
    let merged = merged_dua_sumber();
    let snapshot: Vec<String> = merged.iter().map(|c| c.number.clone()).collect();

    let first = pick_union_neighbors(&merged, "233");
    let second = pick_union_neighbors(&merged, "233");
    assert_eq!(first, second, "hasil harus deterministik");

    let after: Vec<String> = merged.iter().map(|c| c.number.clone()).collect();
    assert_eq!(snapshot, after, "input tidak boleh berubah");
}
