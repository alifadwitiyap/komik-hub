use crate::model::{title_canonical_key, Manga};
use std::collections::{HashMap, HashSet};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SimilarHit {
    pub handle: String,
    pub title: String,
    pub cover_url: Option<String>,
    pub manga_type: Option<String>,
    pub last_chapter: Option<String>,
    pub reason: String,
    pub score: u32,
}

fn norm(s: &str) -> String { s.trim().to_lowercase() }

fn rating_bonus(rating: Option<&str>) -> u32 {
    rating.and_then(|s| s.trim().parse::<f32>().ok())
        .map(|v| (v.clamp(0.0, 10.0)).round() as u32)
        .unwrap_or(0)
}

fn score(target: &Manga, candidate: &Manga) -> (u32, String) {
    let target_genres: HashSet<String> = target.genres.iter().map(|g| norm(g)).collect();
    let mut seen = HashSet::new();
    let mut overlap: Vec<String> = candidate
        .genres
        .iter()
        .filter_map(|genre| {
            let display = genre.trim();
            let key = norm(display);
            if display.is_empty() || !target_genres.contains(&key) || !seen.insert(key) {
                None
            } else {
                Some(display.to_string())
            }
        })
        .collect();
    overlap.sort_by_key(|genre| genre.to_lowercase());
    let genre_score = (overlap.len() as u32 * 25).min(75);
    let same_type = target.manga_type.as_ref().zip(candidate.manga_type.as_ref())
        .is_some_and(|(a, b)| norm(a) == norm(b));
    let same_author = target.author.as_ref().zip(candidate.author.as_ref())
        .is_some_and(|(a, b)| !a.trim().is_empty() && norm(a) == norm(b));
    let total = genre_score + u32::from(same_type) * 15 + u32::from(same_author) * 20
        + rating_bonus(candidate.rating.as_deref());
    let reason = if !overlap.is_empty() {
        overlap.iter().take(2).cloned().collect::<Vec<_>>().join(" · ")
    } else if same_author {
        "Karya author sama".to_string()
    } else if same_type {
        format!("Sesama {} populer", candidate.manga_type.as_deref().unwrap_or("komik"))
    } else {
        "Pilihan populer".to_string()
    };
    (total, reason)
}

pub fn rank(target: &Manga, candidates: Vec<Manga>, limit: usize) -> Vec<SimilarHit> {
    let target_key = title_canonical_key(&target.title);
    let target_handle = target.handle();
    let mut best: HashMap<String, (Manga, u32, String)> = HashMap::new();
    for candidate in candidates {
        let handle = candidate.handle();
        let key = title_canonical_key(&candidate.title);
        if handle == target_handle || key == target_key { continue; }
        let (score, reason) = score(target, &candidate);
        let replace = best.get(&key).is_none_or(|(old, old_score, _)|
            score > *old_score || (score == *old_score && candidate.source == target.source && old.source != target.source));
        if replace { best.insert(key, (candidate, score, reason)); }
    }
    let mut hits: Vec<_> = best.into_values().map(|(m, score, reason)| SimilarHit {
        handle: m.handle(), title: m.title, cover_url: m.cover_url, manga_type: m.manga_type,
        last_chapter: m.last_chapter, reason, score,
    }).collect();
    hits.sort_by(|a, b| b.score.cmp(&a.score).then_with(|| a.title.cmp(&b.title)));
    hits.truncate(limit.min(10));
    hits
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::SourceId;
    fn manga(src: &str, id: &str, title: &str, genres: &[&str]) -> Manga {
        let mut m = Manga::new(SourceId::from(src), id, title);
        m.genres = genres.iter().map(|s| s.to_string()).collect();
        m.manga_type = Some("Manhwa".into());
        m
    }
    #[test]
    fn ranks_filters_self_and_deduplicates() {
        let target = manga("komiku", "1", "The Hero Saga", &["Action", "Fantasy", "Drama"]);
        let mut other = manga("mangaku", "2", "Hero Saga Chronicles", &["action", "fantasy"]);
        other.rating = Some("9".into());
        let duplicate = manga("kiryuu", "3", "Hero Saga Chronicles", &["Action"]);
        let self_copy = manga("komiku", "x", "The Hero Saga", &["Action"]);
        let hits = rank(&target, vec![other, duplicate, self_copy], 10);
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].score, 74);
        assert_eq!(hits[0].reason, "Action · Fantasy");
    }
}
