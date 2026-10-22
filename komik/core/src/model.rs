//! Modelkan data lintas sumber dalam bentuk umum.
//!
//! Setiap adapter memetakan response asli ke struct ini. `source` + `native_id`
//! adalah identitas kanonik yang dicetak CLI dan dipakai user
//! (mis. `kiryuu:batsu-harembatsu-harem`).
use serde::{Deserialize, Serialize};
use std::fmt;

/// Urutan prioritas fallback (dipakai sebagai tiebreak ranking & fallback).
pub const SOURCE_PRIORITY: [&str; 4] = ["komiku", "mangaku", "shinigami", "kiryuu"];

#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct SourceId(pub String);

impl SourceId {
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl From<&str> for SourceId {
    fn from(s: &str) -> Self {
        SourceId(s.to_string())
    }
}

impl fmt::Display for SourceId {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

/// Parse "sumber:id-native" -> (SourceId, native_id). Kalau tanpa awalan
/// "sumber:", kembalikan sumber None (artinya judul, di-resolve nanti).
pub fn parse_handle(s: &str) -> (Option<SourceId>, String) {
    if let Some((src, rest)) = s.split_once(':') {
        if SOURCE_PRIORITY.contains(&src) {
            return (Some(SourceId(src.to_string())), rest.to_string());
        }
    }
    (None, s.to_string())
}

/// Kunci dedup: judul di-lowercase, karakter non-alnum jadi satu spasi.
pub fn title_key(title: &str) -> String {
    let mut out = String::with_capacity(title.len());
    let mut prev_sep = false;
    for ch in title.chars() {
        if ch.is_alphanumeric() {
            for lc in ch.to_lowercase() {
                out.push(lc);
            }
            prev_sep = false;
        } else if !prev_sep {
            out.push(' ');
            prev_sep = true;
        }
    }
    out.trim().to_string()
}

/// Kata fungsi Inggris yang dibuang saat membentuk kunci kanonik judul.
/// Tidak mengubah `title_key` (dipakai dedup persis); hanya dipakai untuk
/// mencocokkan judul yang sama tapi beda tata kata lintas sumber.
const TITLE_STOPWORDS: &[&str] = &[
    "a", "an", "the", "of", "and", "or", "to", "for", "with", "at", "from",
    "by", "in", "on", "is", "are", "was", "were", "be", "been", "being",
    "has", "have", "had", "as", "it", "its", "this", "that", "these",
    "those", "i", "you", "he", "she", "we", "they", "my", "your", "his",
    "her", "our", "their", "not", "no", "but", "so", "if", "then", "than",
    "too", "very", "s", "t", "d",
];

/// Stem ringan (English, heuristik) untuk mencocokkan bentuk kata (return vs
/// returned, demon vs demons). Aman untuk slice byte karena suffix yang diuji
/// semuanya ASCII.
fn light_stem(w: &str) -> String {
    let n = w.len();
    if n > 5 && w.ends_with("ing") {
        return w[..n - 3].to_string();
    }
    if n > 4 && w.ends_with("ed") {
        return w[..n - 2].to_string();
    }
    if n > 4 && w.ends_with("ies") {
        return format!("{}y", &w[..n - 3]);
    }
    if n > 3 && w.ends_with('s') && !w.ends_with("ss") {
        return w[..n - 1].to_string();
    }
    w.to_string()
}

/// Kunci kanonik judul untuk pencocokan lintas sumber: token signifikan
/// (stopword dibuang + stem ringan) diurutkan & dedup. Dua judul seri yang
/// sama dengan tata kata berbeda akan menghasilkan kunci identik; dua seri
/// beda hampir selalu beda kunci. Cuma dipakai di feed ceiling (`latest`),
/// bukan `title_key` (yang tetap eksak).
pub fn title_canonical_key(title: &str) -> String {
    let mut stems: Vec<String> = Vec::new();
    for tok in title_key(title).split_whitespace() {
        if TITLE_STOPWORDS.contains(&tok) {
            continue;
        }
        stems.push(light_stem(tok));
    }
    stems.sort();
    stems.dedup();
    stems.join(" ")
}

/// Identitas nomor chapter berbasis STRING (bukan f64: f64 tidak bisa jadi
/// kunci persis, dan "179.60" vs "179.6" jadi beda).
///
/// Aturan:
/// - Kalau nomor bisa di-parse desimal ("179.60", "007", "1.10"): buang
///   leading zero bagian integer + trailing zero fraksi -> "179.6", "7", "1.1".
/// - Kalau tidak ("extra", "part 2", "prologue"): raw trim lowercase.
///
/// Label TAMPILAN (`Chapter::number`) tetap mentah — fungsi ini hanya kunci
/// pembanding.
pub fn chapter_number_key(number: &str) -> String {
    let raw = number.trim();
    match split_decimal(raw) {
        Some((int_digits, frac_digits)) => {
            let int_trimmed = int_digits.trim_start_matches('0');
            let int_part = if int_trimmed.is_empty() { "0" } else { int_trimmed };
            let frac_part = frac_digits.trim_end_matches('0');
            if frac_part.is_empty() {
                int_part.to_string()
            } else {
                format!("{int_part}.{frac_part}")
            }
        }
        // Bukan desimal: label bebas, bandingkan case-insensitive.
        None => raw.to_lowercase(),
    }
}

/// Apakah nomor chapter berupa angka desimal ("102", "1.1")? Non-numerik
/// ("extra", "prologue", "specials") -> false. Dipakai dedup ceiling feed.
pub fn is_numeric_chapter(number: &str) -> bool {
    split_decimal(number).is_some()
}

/// "179.60" -> Some(("179", "60")); "7" -> Some(("7", "")); "extra" -> None.
fn split_decimal(s: &str) -> Option<(&str, &str)> {
    if s.is_empty() {
        return None;
    }
    let (int_part, frac_part) = match s.split_once('.') {
        Some((a, b)) => (a, b),
        None => (s, ""),
    };
    let is_digits = |p: &str| p.bytes().all(|b| b.is_ascii_digit());
    if int_part.is_empty() || !is_digits(int_part) {
        return None;
    }
    if !frac_part.is_empty() && !is_digits(frac_part) {
        return None;
    }
    Some((int_part, frac_part))
}

#[derive(Debug, Clone)]
pub struct Manga {
    pub source: SourceId,
    pub native_id: String,
    pub title: String,
    pub title_key: String,
    pub cover_url: Option<String>,
    pub author: Option<String>,
    pub status: Option<String>,
    pub manga_type: Option<String>,
    pub rating: Option<String>,
    /// Nomor chapter terbaru (string; bisa desimal).
    pub last_chapter: Option<String>,
    /// epoch millis update terbaru (best-effort; None kalau sumber tak expose).
    pub updated_at: Option<i64>,
    pub url: Option<String>,
}

impl Manga {
    pub fn new(source: SourceId, native_id: impl Into<String>, title: &str) -> Self {
        Manga {
            source,
            native_id: native_id.into(),
            title: title.to_string(),
            title_key: title_key(title),
            cover_url: None,
            author: None,
            status: None,
            manga_type: None,
            rating: None,
            last_chapter: None,
            updated_at: None,
            url: None,
        }
    }

    /// Bentuk kanonik "sumber:id-native".
    pub fn handle(&self) -> String {
        format!("{}:{}", self.source.as_str(), self.native_id)
    }
}

#[derive(Debug, Clone)]
pub struct Chapter {
    pub source: SourceId,
    pub native_id: String,
    pub title: String,
    /// Nomor tampilan (boleh desimal, mis. "1.1", "210").
    pub number: String,
    pub updated_at: Option<i64>,
    pub url: Option<String>,
}

#[derive(Debug, Clone)]
pub struct SeriesDetail {
    pub manga: Manga,
    pub chapters: Vec<Chapter>,
}

#[derive(Debug, Clone)]
pub struct ChapterPages {
    pub source: SourceId,
    pub title: String,
    pub number: String,
    /// URL gambar absolut, urut halaman.
    pub images: Vec<String>,
}

#[cfg(test)]
mod tests {
    use super::title_canonical_key;

    #[test]
    fn kanonik_seri_sama_beda_tata_kata() {
        // Kasus nyata: komiku vs shinigami untuk seri yang sama.
        let a = title_canonical_key("A Disaster-Class Hero Has Returned");
        let b = title_canonical_key("The Return of The Disaster Class Hero");
        assert_eq!(a, b, "judul seri yang sama harus punya kunci kanonik sama");
        assert_eq!(a, "class disaster hero return");
    }

    #[test]
    fn kanonik_seri_beda_tetap_beda() {
        let a = title_canonical_key("Solo Leveling");
        let b = title_canonical_key("Solo Leveling Reawakening");
        assert_ne!(a, b, "seri beda tidak boleh bergabung");

        let c = title_canonical_key("The King's Avatar");
        let d = title_canonical_key("Avatar: The Last Airbender");
        assert_ne!(c, d);

        let e = title_canonical_key("Return of the Monster Class Hero");
        let f = title_canonical_key("Return of the Disaster Class Hero");
        assert_ne!(e, f, "satu kata pembeda harus tetap memisahkan");
    }

    #[test]
    fn kanonik_hilangkan_stopword() {
        let a = title_canonical_key("The Tales of Demons and Gods");
        let b = title_canonical_key("Tales of Demons and Gods");
        assert_eq!(a, b);
        assert_eq!(a, "demon god tale");
    }
}
