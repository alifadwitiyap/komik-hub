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
