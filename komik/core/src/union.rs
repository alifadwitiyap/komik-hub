//! Tipe & fungsi union chapter lintas sumber.
//!
//! Union = menggabungkan daftar chapter dari beberapa sumber jadi satu daftar
//! tunggal. Identitas chapter memakai kunci STRING (lihat
//! [`crate::model::chapter_number_key`]): "09" == "9", "179.60" == "179.6",
//! "extra" != "7". Perbandingan untuk URUTAN (bukan identitas) terpisah di
//! [`cmp_chapter_number`].
use crate::model::{chapter_number_key, Chapter, SourceId};
use std::cmp::Ordering;
use std::collections::HashSet;

/// Chapter hasil union lintas sumber.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MergedChapter {
    /// Nomor tampilan mentah sumber pemiliknya ("233", "09").
    pub number: String,
    pub title: String,
    pub native_id: String,
    pub updated_at: Option<i64>,
    /// Sumber yang benar-benar punya chapter ini.
    pub source: SourceId,
    /// Handle series di sumber itu ("shinigami:3b1eab91-…" / "komiku:6167").
    pub handle: String,
}

/// Daftar chapter satu sumber + identitas series-nya.
#[derive(Debug, Clone)]
pub struct SourceChapterList {
    pub source: SourceId,
    pub handle: String,
    pub chapters: Vec<Chapter>,
}

/// Gabungkan daftar chapter lintas sumber jadi satu daftar.
///
/// Dedup by `chapter_number_key` — daftar yang lebih awal (preferensi caller)
/// menang. Urutan: chapter numerik DESC (terbaru dulu), lalu label non-numerik
/// ("extra", "prologue") SESUDAH-nya, diurutkan by key DESC.
pub fn merge_chapter_lists(lists: &[SourceChapterList]) -> Vec<MergedChapter> {
    let mut seen: HashSet<String> = HashSet::new();
    let mut out: Vec<MergedChapter> = Vec::new();
    for list in lists {
        for ch in &list.chapters {
            // Pemenang = daftar lebih awal; field tampilan apa adanya.
            if !seen.insert(chapter_number_key(&ch.number)) {
                continue;
            }
            out.push(MergedChapter {
                number: ch.number.clone(),
                title: ch.title.clone(),
                native_id: ch.native_id.clone(),
                updated_at: ch.updated_at,
                source: list.source.clone(),
                handle: list.handle.clone(),
            });
        }
    }
    // DESC: nomor besar dulu, label non-numerik paling belakang.
    out.sort_by(|a, b| cmp_chapter_number(&a.number, &b.number).reverse());
    out
}

/// Bandingkan dua nomor chapter untuk URUTAN (bukan identitas).
///
/// Numerik vs numerik -> numerik DESC wins. Numerik > non-numerik (non-numerik
/// ditaruh setelah). Non-numerik vs non-numerik -> bandingkan
/// `chapter_number_key` DESC.
///
/// Konvensi: `Ordering::Greater` = `a` lebih tinggi urutan (angka lebih besar;
/// label = `chapter_number_key` lebih besar). Daftar union diurutkan DESC atas
/// perbandingan ini — `sort_by(|x, y| cmp_chapter_number(&x.number, &y.number).reverse())`
/// — supaya chapter terbaru muncul lebih dulu dan label non-numerik ("extra",
/// "prologue") ditaruh paling belakang (key DESC).
pub fn cmp_chapter_number(a: &str, b: &str) -> Ordering {
    let ka = chapter_number_key(a);
    let kb = chapter_number_key(b);
    match (is_numeric_key(&ka), is_numeric_key(&kb)) {
        (true, true) => cmp_numeric_key(&ka, &kb),
        // Numerik selalu mendahului label bebas ("extra", "prologue").
        (true, false) => Ordering::Greater,
        (false, true) => Ordering::Less,
        // Label non-numerik: bandingkan key-nya (key besar = lebih tinggi).
        (false, false) => ka.cmp(&kb),
    }
}

/// Kunci chapter numerik? Bentuknya "int" atau "int.frac" (hasil
/// `chapter_number_key` sudah normalisasi leading/trailing zero).
fn is_numeric_key(key: &str) -> bool {
    let mut parts = key.split('.');
    let int = parts.next().unwrap_or("");
    let frac = match parts.next() {
        None => return !int.is_empty() && int.bytes().all(|b| b.is_ascii_digit()),
        Some(f) => f,
    };
    if parts.next().is_some() {
        return false;
    }
    !int.is_empty()
        && int.bytes().all(|b| b.is_ascii_digit())
        && !frac.is_empty()
        && frac.bytes().all(|b| b.is_ascii_digit())
}

/// Bandingkan dua kunci numerik tanpa f64 (presisi desimal): bagian bulat
/// dibanding panjang+leksikografis, bagian pecahan digit-per-digit dengan
/// nol-kan yang lebih pendek.
fn cmp_numeric_key(a: &str, b: &str) -> Ordering {
    let (ai, af) = split_numeric_key(a);
    let (bi, bf) = split_numeric_key(b);
    let ai = trim_leading_zeros(ai);
    let bi = trim_leading_zeros(bi);
    match ai.len().cmp(&bi.len()).then_with(|| ai.cmp(bi)) {
        Ordering::Equal => {}
        o => return o,
    }
    let n = af.len().max(bf.len());
    for i in 0..n {
        let x = af.as_bytes().get(i).copied().unwrap_or(b'0');
        let y = bf.as_bytes().get(i).copied().unwrap_or(b'0');
        match x.cmp(&y) {
            Ordering::Equal => {}
            o => return o,
        }
    }
    Ordering::Equal
}

/// Pecah kunci numerik jadi (bagian bulat, bagian pecahan).
fn split_numeric_key(key: &str) -> (&str, &str) {
    match key.split_once('.') {
        Some((i, f)) => (i, f),
        None => (key, ""),
    }
}

/// Buang nol di depan bagian bulat ("007" -> "7", "" -> "0").
fn trim_leading_zeros(s: &str) -> &str {
    let t = s.trim_start_matches('0');
    if t.is_empty() {
        "0"
    } else {
        t
    }
}
