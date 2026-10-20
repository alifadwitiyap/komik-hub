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

/// Pilih sumber representatif = sumber yang punya chapter numerik utama TERBESAR.
/// Non-numerik (extra/special/prologue) TIDAK dihitung. Tie-break: SOURCE_PRIORITY.
/// Kosong di semua sumber (atau semua non-numerik) -> None.
pub fn pick_representative_source(lists: &[SourceChapterList]) -> Option<SourceId> {
    let priority = crate::model::SOURCE_PRIORITY;
    lists
        .iter()
        .map(|list| {
            // latest_main = nomor numerik terbesar di list ini (skip non-numerik).
            let latest_main = list
                .chapters
                .iter()
                .map(|ch| ch.number.as_str())
                .filter(|k| is_numeric_key(k))
                .max_by(|a, b| cmp_chapter_number(a, b));
            (list, latest_main)
        })
        // Buang list tanpa chapter numerik sama sekali.
        .filter(|(_, latest)| latest.is_some())
        .max_by(|(a, la), (b, lb)| {
            cmp_chapter_number(la.unwrap(), lb.unwrap()).then_with(|| {
                // Tie-break: SOURCE_PRIORITY (indeks kecil = prioritas lebih tinggi).
                let ia = priority
                    .iter()
                    .position(|p| *p == a.source.as_str())
                    .unwrap_or(usize::MAX);
                let ib = priority
                    .iter()
                    .position(|p| *p == b.source.as_str())
                    .unwrap_or(usize::MAX);
                ib.cmp(&ia)
            })
        })
        .map(|(list, _)| list.source.clone())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn chapter(source: &str, number: &str) -> Chapter {
        Chapter {
            source: SourceId(source.to_string()),
            native_id: number.to_string(),
            title: String::new(),
            number: number.to_string(),
            updated_at: None,
            url: None,
        }
    }

    fn list(source: &str, numbers: &[&str]) -> SourceChapterList {
        SourceChapterList {
            source: SourceId(source.to_string()),
            handle: format!("{}:id", source),
            chapters: numbers.iter().map(|n| chapter(source, n)).collect(),
        }
    }

    #[test]
    fn pilih_max_numerik_di_antara_sumber_v() {
        // komiku max 90, shinigami 91 -> shinigami.
        let lists = vec![
            list("komiku", &["1", "90"]),
            list("shinigami", &["10", "91"]),
        ];
        let got = pick_representative_source(&lists);
        assert_eq!(got.as_ref().map(SourceId::as_str), Some("shinigami"));
    }

    #[test]
    fn tie_sumber_prioritas_lebi_tinggi() {
        // Dua sumber sama2 91 -> komiku (prioritas lebih tinggi daripada shinigami).
        let lists = vec![
            list("shinigami", &["91"]),
            list("komiku", &["91"]),
        ];
        let got = pick_representative_source(&lists);
        assert_eq!(got.as_ref().map(SourceId::as_str), Some("komiku"));
    }

    #[test]
    fn extra_diabaikan() {
        // extra 179.5 (label non-numerik) di satu sumber + main 90 di sumber lain
        // -> pilih yang 90 (extra diabaikan).
        let lists = vec![
            list("komiku", &["90"]),
            list("shinigami", &["extra 179.5"]),
        ];
        let got = pick_representative_source(&lists);
        assert_eq!(got.as_ref().map(SourceId::as_str), Some("komiku"));
    }

    #[test]
    fn semua_non_numerik_none() {
        let lists = vec![
            list("komiku", &["extra", "prologue"]),
            list("shinigami", &["specials"]),
        ];
        assert_eq!(pick_representative_source(&lists), None);
    }

    #[test]
    fn tie_desimal_angka_menjadi() {
        // 179.6 vs 179.60 dianggap sama -> tie-break prioritas -> kiryuu lebih tinggi.
        let lists = vec![
            list("komiku", &["179.60"]),
            list("kiryuu", &["179.6"]),
        ];
        let got = pick_representative_source(&lists);
        assert_eq!(got.as_ref().map(SourceId::as_str), Some("komiku"));
    }

    #[test]
    fn seratus_mengalahkan_sembilan_puluh_sembil() {
        let lists = vec![
            list("komiku", &["99"]),
            list("mangaku", &["100"]),
        ];
        let got = pick_representative_source(&lists);
        assert_eq!(got.as_ref().map(SourceId::as_str), Some("mangaku"));
    }
}
