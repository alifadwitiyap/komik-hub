//! Adapter per sumber. Setiap adapter = satu file; lane implementasi hanya
//! menyentuh file-nya sendiri.
pub mod komiku;
pub mod mangaku;
pub mod kiryuu;
pub mod shinigami;

use crate::model::SourceId;
use crate::source::Source;
use std::sync::Arc;

/// Registry semua sumber. Tiap adapter ambil reqwest::Client yang sama
/// (pola komiku-server: satu static Client). Lane adapter hanya mengisi file
/// adapters/<nama>.rs — call site di sini tetap.
pub fn all_sources(client: reqwest::Client) -> Vec<Arc<dyn Source>> {
    vec![
        Arc::new(super::adapters::komiku::KomikuSource::new(client.clone())) as Arc<dyn Source>,
        Arc::new(super::adapters::mangaku::MangakuSource::new(client.clone())) as Arc<dyn Source>,
        Arc::new(super::adapters::shinigami::ShinigamiSource::new(client.clone())) as Arc<dyn Source>,
        Arc::new(super::adapters::kiryuu::KiryuuSource::new(client)) as Arc<dyn Source>,
    ]
}

pub fn source_ids() -> Vec<SourceId> {
    SOURCE_PRIORITY.iter().map(|s| SourceId::from(*s)).collect()
}

/// Filter daftar genre mentah dari sumber: buang entri yang BUKAN genre
/// (status/origin/format: "Tamat", "Completed", "Jepang", "China", "Korea",
/// "Novel", "Fanfiction", "HTL", "Latest", "Manhwa", "Webtoon", dst) supaya
/// tidak mengotori union genre dan dropdown filter (yang menampilkan entri
/// seperti ini → hasil filter selalu 0).
pub fn is_genre(slug: &str, name: &str) -> bool {
    let s = slug.to_lowercase();
    let n = name.to_lowercase();
    const NON_GENRE: &[&str] = &[
        "tamat", "completed", "ongoing", "jepang", "china", "chinese", "korea",
        "japan", "korean", "novel", "fanfiction", "htl", "latest", "manhwa",
        "manhua", "webtoon", "webtoons", "manga", "comic", "oneshot", "one-shot",
    ];
    if NON_GENRE.iter().any(|k| s == *k || n == *k) {
        return false;
    }
    true
}

#[cfg(test)]
mod tests {
    use super::is_genre;

    #[test]
    fn is_genre_buang_taxonomy_non_genre() {
        // status/origin/format harus dibuang
        assert!(!is_genre("tamat", "Tamat"));
        assert!(!is_genre("completed", "Completed"));
        assert!(!is_genre("jepang", "Jepang"));
        assert!(!is_genre("china", "China"));
        assert!(!is_genre("novel", "Novel"));
        assert!(!is_genre("fanfiction", "Fanfiction"));
        assert!(!is_genre("htl", "HTL"));
        assert!(!is_genre("latest", "Latest"));
        assert!(!is_genre("manhwa", "Manhwa"));
        assert!(!is_genre("webtoon", "Webtoon"));
        // case-insensitive di slug maupun nama
        assert!(!is_genre("TAMAT", "tamat"));
    }

    #[test]
    fn is_genre_pertahankan_genre_asli() {
        assert!(is_genre("action", "Action"));
        assert!(is_genre("romance", "Romance"));
        assert!(is_genre("fantasy", "Fantasy"));
        assert!(is_genre("slice-of-life", "Slice of Life"));
        assert!(is_genre("martial-arts", "Martial Arts"));
    }
}

use crate::model::SOURCE_PRIORITY;
