//! Logika ranking/dedup/ceiling/tetangga MURNI (tanpa state Aggregator).
//!
//! Dipisah dari `aggregator.rs` supaya pemilihan pemenang dedup (recency /
//! ceiling lintas sumber), relevansi kueri, dan navigasi tetangga prev/next
//! bisa diuji tanpa Aggregator/cache/jaringan. Trait `Rankable` adalah satu-
//! satunya kontrak ke model: judul, recency, identitas sumber, dan merge
//! field kosong sudah cukup.

use crate::model::*;
use crate::union::cmp_chapter_number;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};

/// Referensi chapter tetangga untuk navigasi reader. Membawa sumber + handle
/// manga di sumber itu, supaya client bisa lanjut baca lintas sumber tanpa
/// perlu tahu sumber asal: kirim balik `handle` + `number` ke
/// [`crate::aggregator::Aggregator::read_chapter_any`].
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ChapterRef {
    /// Nomor tampilan mentah (mis. "179.6" / "extra") — kirim balik apa adanya.
    pub number: String,
    /// Sumber yang melayani chapter ini (bukan sumber primary).
    pub source: SourceId,
    /// Handle manga di sumber itu: "{source}:{native_id}".
    pub handle: String,
}

/// Trait kecil supaya `merged<T>` bisa dedup + rank tanpa menyalin logika per
/// tipe: judul, recency, dan identitas sumber sudah cukup.
pub trait Rankable: Sized {
    fn rank_title_key(&self) -> &str;
    /// Kunci grup untuk dedup ceiling. Default = title_key eksak; Manga
    /// override ke kunci kanonik supaya judul seri yang sama tapi beda tata
    /// kata lintas sumber bisa bergabung.
    fn rank_canonical_key(&self) -> String {
        self.rank_title_key().to_string()
    }
    fn rank_updated_at(&self) -> Option<i64>;
    fn rank_source(&self) -> &SourceId;
    /// Nomor chapter terbaru (string mentah; None kalau tidak tersedia).
    fn rank_last_chapter(&self) -> Option<&str>;
    /// Lengkapi field yang kosong dari duplikat (cover, author, ...).
    fn merge_from(&mut self, other: &Self);
}

impl Rankable for Manga {
    fn rank_title_key(&self) -> &str {
        &self.title_key
    }
    fn rank_updated_at(&self) -> Option<i64> {
        self.updated_at
    }
    fn rank_source(&self) -> &SourceId {
        &self.source
    }
    fn rank_canonical_key(&self) -> String {
        title_canonical_key(&self.title)
    }
    fn rank_last_chapter(&self) -> Option<&str> {
        self.last_chapter.as_deref()
    }
    fn merge_from(&mut self, other: &Self) {
        macro_rules! fill {
            ($f:ident) => {
                if self.$f.is_none() {
                    self.$f = other.$f.clone();
                }
            };
        }
        fill!(cover_url);
        fill!(author);
        fill!(status);
        fill!(manga_type);
        fill!(rating);
        fill!(last_chapter);
        fill!(url);
        if self.updated_at.is_none() {
            self.updated_at = other.updated_at;
        }
    }
}

/// Dedup by title_key (pemenang = recency terbaru, tiebreak prioritas sumber),
/// output di-rank recency desc (None paling bawah).
pub fn dedup_rank<T: Rankable + Clone>(items: Vec<T>) -> Vec<T> {
    let mut order: Vec<String> = Vec::new();
    let mut by_key: HashMap<String, T> = HashMap::new();

    for item in items {
        let key = item.rank_title_key().to_string();
        match by_key.get_mut(&key) {
            None => {
                order.push(key.clone());
                by_key.insert(key, item);
            }
            Some(existing) => {
                if rank_cmp(&item, existing) == std::cmp::Ordering::Less {
                    let mut item = item;
                    item.merge_from(existing);
                    *existing = item;
                } else {
                    existing.merge_from(&item);
                }
            }
        }
    }

    let mut out: Vec<T> = order.into_iter().filter_map(|k| by_key.remove(&k)).collect();
    out.sort_by(|a, b| rank_cmp(a, b));
    out
}

/// Dedup by title_key dengan aturan CEILING lintas sumber (feed "Update terbaru"):
/// dalam satu group judul, pemenang = entri dengan `last_chapter` numerik
/// TERTINGGI (tiebreak `SOURCE_PRIORITY`); entri di bawah ceiling TIDAK ikut
/// tampil. Kalau tidak ada entri yang numerik di group itu, fallback ke
/// recency/prioritas (perilaku `dedup_rank` lama). Output tetap di-rank recency
/// desc.
pub fn dedup_rank_ceiling<T: Rankable + Clone>(items: Vec<T>) -> Vec<T> {
    let mut order: Vec<String> = Vec::new();
    let mut by_key: HashMap<String, Vec<T>> = HashMap::new();
    for item in items {
        let key = item.rank_canonical_key();
        if !by_key.contains_key(&key) {
            order.push(key.clone());
        }
        by_key.entry(key).or_default().push(item);
    }

    let mut out = Vec::with_capacity(order.len());
    for key in order {
        let group = by_key.remove(&key).unwrap();
        out.push(pick_ceiling_winner(group));
    }
    out.sort_by(|a, b| rank_cmp(a, b));
    out
}

/// Pilih pemenang satu group judul untuk dedup ceiling.
fn pick_ceiling_winner<T: Rankable + Clone>(group: Vec<T>) -> T {
    // Indeks yang punya last_chapter numerik.
    let numeric: Vec<usize> = group
        .iter()
        .enumerate()
        .filter(|(_, x)| x.rank_last_chapter().map(is_numeric_chapter).unwrap_or(false))
        .map(|(i, _)| i)
        .collect();

    let winner_idx = if numeric.is_empty() {
        // Fallback: recency/prioritas (perilaku `dedup_rank` lama).
        group
            .iter()
            .enumerate()
            .reduce(|acc, cur| {
                if rank_cmp(acc.1, cur.1) == std::cmp::Ordering::Less {
                    acc
                } else {
                    cur
                }
            })
            .map(|(i, _)| i)
            .unwrap_or(0)
    } else {
        numeric
            .into_iter()
            .reduce(|best, cur| {
                let lb = group[best].rank_last_chapter().unwrap();
                let lc = group[cur].rank_last_chapter().unwrap();
                match cmp_chapter_number(lb, lc) {
                    std::cmp::Ordering::Greater => best,
                    std::cmp::Ordering::Less => cur,
                    std::cmp::Ordering::Equal => {
                        // Tie: prioritas sumber lebih tinggi (indeks kecil) menang.
                        let pb = source_priority(group[best].rank_source());
                        let pc = source_priority(group[cur].rank_source());
                        if pb <= pc { best } else { cur }
                    }
                }
            })
            .unwrap()
    };

    let mut winner = group[winner_idx].clone();
    for (i, other) in group.iter().enumerate() {
        if i != winner_idx {
            winner.merge_from(other);
        }
    }
    winner
}

/// Memoize keputusan validasi tie per (kunci kanonik series, nomor ceiling).
/// Nilai = handle pemenang. Grup tie yang berulang (mis. di lintas halaman)
/// tidak perlu re-fetch series resolve.
pub(crate) fn tie_validation_cache() -> &'static std::sync::Mutex<HashMap<(String, String), String>> {
    use std::sync::OnceLock;
    static CACHE: OnceLock<std::sync::Mutex<HashMap<(String, String), String>>> = OnceLock::new();
    CACHE.get_or_init(|| std::sync::Mutex::new(HashMap::new()))
}

pub(crate) fn rank_cmp<T: Rankable>(a: &T, b: &T) -> std::cmp::Ordering {
    match (a.rank_updated_at(), b.rank_updated_at()) {
        (Some(x), Some(y)) if x != y => return y.cmp(&x),
        (Some(_), None) => return std::cmp::Ordering::Less,
        (None, Some(_)) => return std::cmp::Ordering::Greater,
        _ => {}
    }
    source_priority(a.rank_source()).cmp(&source_priority(b.rank_source()))
}

pub(crate) fn source_priority(s: &SourceId) -> usize {
    SOURCE_PRIORITY
        .iter()
        .position(|p| *p == s.as_str())
        .unwrap_or(usize::MAX)
}

/// Tier relevansi sebuah judul terhadap kueri (lebih kecil = lebih relevan).
/// Dipakai [`rank_by_query`] sebagai kunci utama yang lebih penting dari
/// recency. Prefix & semua-token cocok STABIL (satu representan angka), jadi
/// dipakai `Ord`; tiebreak dalam tier partial ada di `match_count`.
#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Debug)]
enum MatchTier {
    /// Judul_key identik persis dengan kueri.
    Exact,
    /// title_key diawali kueri.
    Prefix,
    /// Semua token kueri muncul di judul.
    AllTokens,
    /// Hanya sebagian token yang cocok (tier berbeda hanya untuk pengelompokan;
    /// urutan dalam grup ini = jumlah token cocok desc).
    Partial,
    /// Tidak ada token kueri yang cocok (paling bawah).
    NoMatch,
}

/// Tier + jumlah token kueri yang cocok di `title_key` (sudah lowercase dari
/// model). Item tanpa satu pun token tetap keluar (NoMatch) supaya set hasil
/// tidak menyusut. `query_key` = token kueri yang sudah di-join spasi.
fn match_tier(title_key: &str, tokens: &[String], query_key: &str) -> (MatchTier, usize) {
    if title_key.is_empty() {
        return (MatchTier::NoMatch, 0);
    }
    if title_key == query_key {
        return (MatchTier::Exact, tokens.len());
    }
    if title_key.starts_with(query_key) {
        return (MatchTier::Prefix, tokens.len());
    }
    let matched = tokens
        .iter()
        .filter(|t| title_key.contains(t.as_str()))
        .count();
    if matched == tokens.len() {
        (MatchTier::AllTokens, matched)
    } else if matched > 0 {
        (MatchTier::Partial, matched)
    } else {
        (MatchTier::NoMatch, 0)
    }
}

/// Rank ulang hasil merge menurut relevansi KUERI (bukan recency).
///
/// Urutan (frozen; semua pembanding di atas `title_key` lowercase):
/// 1. `title_key == query` (setelah normalisasi token), 2. prefix,
///    3. semua token kueri ada di judul, 4. sebagian token — jumlah token cocok
///    desc, 5. recency desc (`None` di bawah), 6. `SOURCE_PRIORITY`.
///
/// Setiap angka kunci berada di tuple terpisah, jadi `AllTokens` memang selalu
/// mengalahkan `Partial` berapa pun jumlah kecocokannya.
///
/// Input diasumsikan SUDAH dedup ([`dedup_rank`]); tidak ada item yang dibuang
/// atau digandakan di sini — hanya diurut ulang (jumlah tetap). Kueri kosong
/// (atau hanya spasi) = no-op, urutan input dikembalikan apa adanya.
///
/// TIDAK mengurangi/merusak `dedup_rank`: dipakai hanya oleh
/// [`crate::aggregator::Aggregator::search`]; `popular`/`latest`/`list` tetap pakai
/// `dedup_rank` (recency).
pub fn rank_by_query<T: Rankable>(items: Vec<T>, query: &str) -> Vec<T> {
    let mut out = retain_relevant(items, query);
    let tokens = query_tokens(query);
    if tokens.is_empty() {
        return out;
    }
    let query_key = tokens.join(" ");
    out.sort_by(|a, b| {
        let (ta, ma) = match_tier(&a.rank_title_key().to_lowercase(), &tokens, &query_key);
        let (tb, mb) = match_tier(&b.rank_title_key().to_lowercase(), &tokens, &query_key);
        // 1-4: tier lebih dulu; dalam tier Partial, jumlah token cocok desc.
        ta.cmp(&tb)
            .then_with(|| mb.cmp(&ma))
            // 5-6: recency desc (None di bawah), tiebreak SOURCE_PRIORITY —
            // komparator sama persis dengan `dedup_rank` supaya urutannya
            // total (tidak bergantung urutan input).
            .then_with(|| rank_cmp(a, b))
    });
    out
}

/// Ceiling untuk kartu: set `last_chapter` tiap item = max numerik lintas
/// sumber yang sekunci kanonik. Tidak mengubah jumlah/urutan item; hanya
/// menaikkan "chapter terbaru" yang ditampilkan ke sumber dengan episode terbesar.
pub(crate) fn apply_ceiling_last_chapter(items: &mut [Manga]) {
    use std::cmp::Ordering;
    let mut best: HashMap<String, Option<String>> = HashMap::new();
    for m in items.iter() {
        let k = m.rank_canonical_key();
        if let Some(lc) = m.rank_last_chapter() {
            let e = best.entry(k).or_default();
            let better = match e.as_deref() {
                None => true,
                Some(cur) => cmp_chapter_number(lc, cur) == Ordering::Greater,
            };
            if better {
                *e = Some(lc.to_string());
            }
        }
    }
    for m in items.iter_mut() {
        if let Some(v) = best.get(&m.rank_canonical_key()) {
            m.last_chapter = v.clone();
        }
    }
}

/// Token kueri: lowercase, tanpa duplikat, urutan dipertahankan.
/// Diekstrak dari [`rank_by_query`] supaya filter dan sort memakai token identik.
fn query_tokens(query: &str) -> Vec<String> {
    let mut seen = HashSet::new();
    query
        .to_lowercase()
        .split_whitespace()
        .filter(|t| seen.insert(t.to_string()))
        .map(|t| t.to_string())
        .collect()
}

/// Buang item yang judulnya TIDAK berbagi satu token pun dengan kueri
/// ([`MatchTier::NoMatch`]).
///
/// Kenapa: sumber seperti shinigami mencocokkan author/studio/sinopsis, bukan
/// hanya judul, lalu mengembalikan item yang judulnya sama sekali asing.
/// `rank_by_query` hanya MENGURUTKAN mereka ke bawah — tidak membuang — sehingga
/// kueri "nano machine" menampilkan "Absolute Sword Sense" dan "Legend Of
/// Heavenly Chaos Demon" di bawah hasil yang benar.
///
/// Degradasi anggun: kalau SEMUA item NoMatch (mis. kueri nama author/studio yang
/// di upstream cocok lewat field lain), hasil filter = 0. Membalas "tidak ada
/// hasil" untuk kueri yang jelas punya hasil adalah kebohongan baru, jadi
/// kembalikan input apa adanya.
fn retain_relevant<T: Rankable>(items: Vec<T>, query: &str) -> Vec<T> {
    let tokens = query_tokens(query);
    if tokens.is_empty() {
        return items; // kueri kosong = no-op (kontrak lama)
    }
    let query_key = tokens.join(" ");
    let keep: Vec<bool> = items
        .iter()
        .map(|it| {
            match_tier(&it.rank_title_key().to_lowercase(), &tokens, &query_key).0
                != MatchTier::NoMatch
        })
        .collect();

    // Tidak ada satu pun sinyal judul -> jangan balas kosong.
    if !keep.iter().any(|k| *k) {
        return items;
    }
    items
        .into_iter()
        .zip(keep)
        .filter_map(|(it, k)| k.then_some(it))
        .collect()
}

/// Cari chapter by kunci kanonik STRING (lihat
/// [`crate::model::chapter_number_key`]): "179.60" == "179.6", "007" == "7",
/// "extra" TIDAK == "7". Bukan f64 — f64 tidak bisa jadi kunci persis dan
/// mempertaruhkan label non-desimal.
pub fn chapter_by_number(detail: &SeriesDetail, number: &str) -> Option<Chapter> {
    chapter_index_by_key(detail, number).map(|i| detail.chapters[i].clone())
}

/// Posisi chapter di daftar menurut kunci kanonik. Dipakai `read_chapter_any`
/// untuk menghitung tetangga prev/next dari daftar yang sama.
pub fn chapter_index_by_key(detail: &SeriesDetail, number: &str) -> Option<usize> {
    let want = chapter_number_key(number);
    detail
        .chapters
        .iter()
        .position(|c| chapter_number_key(&c.number) == want)
}

/// Batas chapter per sumber saat mencari tetangga LINTAS sumber.
///
/// 0 = tanpa pemotongan: daftar chapter sumber lain dipakai utuh supaya
/// kandidat terdekat (mis. "233" dari "232") tak terpotong.
/// prev/next dari daftar chapter sumber yang MELAYAN. Daftar chapter
/// terbaru-dulu (kontrak trait `Source`), jadi `prev` = lebih tua (index+1)
/// dan `next` = lebih baru (index-1) — konvensi sama dengan endpoint chapter
/// server yang sudah ada. Chapter di tepi dapat `None`.
pub(crate) fn neighbor_refs(detail: &SeriesDetail, pos: usize) -> (Option<ChapterRef>, Option<ChapterRef>) {
    let handle = detail.manga.handle();
    let mk = |c: &Chapter| ChapterRef {
        number: c.number.clone(),
        source: c.source.clone(),
        handle: handle.clone(),
    };
    let next = pos
        .checked_sub(1)
        .and_then(|i| detail.chapters.get(i))
        .map(mk);
    let prev = detail.chapters.get(pos + 1).map(mk);
    (prev, next)
}

/// Kandidat tetangga LINTAS SUMBER untuk chapter `current`.
///
/// Dipakai hanya saat sumber yang melayani sudah di TEPI (tidak punya
/// `next` / tidak punya `prev`). Sumber lain searched =
/// [`crate::aggregator::Aggregator::collect_series_across_sources`] (judul sama, sumber pelayan
/// dilewati).
///
/// - `next` = nomor LEBIH BESAR dari `current`, yang terkecil (suksesor
///   terdekat).
/// - `prev` = nomor LEBIH KECIL dari `current`, yang terbesar.
///
/// Perbandingan memakai [`crate::union::cmp_chapter_number`] (numerik-aware,
/// identitas string `chapter_number_key`) — bukan f64. Label non-numerik
/// ("extra", "prologue") kalah dari kandidat numerik, jadi `prev` memilih
/// "extra" hanya kalau tak ada kandidat numerik yang lebih kecil.
///
/// Kandidat dengan nomor sama di beberapa sumber: yang pertama (urutan
/// prioritas sumber) menang.
pub(crate) fn pick_cross_source_neighbors(
    lists: &[crate::union::SourceChapterList],
    current: &str,
) -> (Option<ChapterRef>, Option<ChapterRef>) {
    let mut next: Option<ChapterRef> = None;
    let mut prev: Option<ChapterRef> = None;
    for list in lists {
        for ch in &list.chapters {
            let mk = || ChapterRef {
                number: ch.number.clone(),
                source: list.source.clone(),
                handle: list.handle.clone(),
            };
            match crate::union::cmp_chapter_number(&ch.number, current) {
                // Nomor lebih besar -> kandidat `next`: ambil yang terkecil.
                std::cmp::Ordering::Greater => {
                    let better = match &next {
                        None => true,
                        Some(n) => {
                            crate::union::cmp_chapter_number(&ch.number, &n.number)
                                == std::cmp::Ordering::Less
                        }
                    };
                    if better {
                        next = Some(mk());
                    }
                }
                // Nomor lebih kecil -> kandidat `prev`: ambil yang terbesar.
                std::cmp::Ordering::Less => {
                    let better = match &prev {
                        None => true,
                        Some(p) => {
                            crate::union::cmp_chapter_number(&ch.number, &p.number)
                                == std::cmp::Ordering::Greater
                        }
                    };
                    if better {
                        prev = Some(mk());
                    }
                }
                // Nomor sama -> chapter itu sendiri, bukan tetangga.
                std::cmp::Ordering::Equal => {}
            }
        }
    }
    (prev, next)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::Manga;

    /// Manga sintetis: `updated_at` = None, `native_id` = tag identitas.
    fn m(src: &str, tag: &str, title: &str) -> Manga {
        let mut m = Manga::new(SourceId::from(src), tag, title);
        m.manga_type = Some("Manga".into());
        m
    }

    /// Urutan native_id hasil rank (setiap fixture punya native_id unik).
    fn ids(items: &[Manga]) -> Vec<&str> {
        items.iter().map(|m| m.native_id.as_str()).collect()
    }

    #[test]
    fn exact_mengalahkan_partial_yang_lebih_baru() {
        let exact = {
            let mut m = m("komiku", "exact", "Solo Leveling");
            m.updated_at = Some(100); // lebih tua
            m
        };
        let newer = {
            let mut m = m("komiku", "newer", "Solo Necromancy");
            m.updated_at = Some(9_000);
            m
        };
        let out = rank_by_query(vec![newer, exact], "solo leveling");
        assert_eq!(ids(&out), vec!["exact", "newer"]);
    }

    /// 2. Prefix mengalahkan word-match (sisa kata).
    #[test]
    fn prefix_mengalahkan_word_match() {
        // "solo leveling" prefix dari "solo leveling reawakening";
        // "leveling" saja = word-match sebagian (bukan prefix).
        let prefix = m("komiku", "prefix", "Solo Leveling Reawakening");
        let word = m("komiku", "word", "Leveling Up Alone");
        let out = rank_by_query(vec![word, prefix], "solo leveling");
        assert_eq!(ids(&out), vec!["prefix", "word"]);
    }

    /// 3. All-tokens mengalahkan partial.
    #[test]
    fn all_tokens_mengalahkan_partial() {
        // "The Solo Leveling": bukan exact/prefix, tapi KEDUA token ada.
        let all = m("komiku", "all", "The Solo Leveling");
        let partial = m("komiku", "partial", "Solo Necromancy");
        let out = rank_by_query(vec![partial, all], "solo leveling");
        assert_eq!(ids(&out), vec!["all", "partial"]);
    }

    /// 4. Partial diurut jumlah token cocok desc.
    #[test]
    fn partial_urut_token_cocok_desc() {
        // Keduanya partial (bukan prefix): satu cocok 2 token, satu cocok 1.
        let two = m("komiku", "two", "Side Story Solo Leveling"); // cocok 2
        let one = m("komiku", "one", "Leveling Only"); // cocok 1
        let out = rank_by_query(vec![one, two], "solo leveling");
        assert_eq!(ids(&out), vec!["two", "one"]);
    }

    /// 5. Tieback recency desc (None di bawah) + SOURCE_PRIORITY.
    #[test]
    fn tieback_recency_lalu_source_priority() {
        let newer = {
            let mut m = m("komiku", "newer", "Solo Leveling");
            m.updated_at = Some(500);
            m
        };
        let older = {
            let mut m = m("komiku", "older", "Solo Leveling");
            m.updated_at = Some(100);
            m
        };
        let none = m("komiku", "none", "Solo Leveling"); // updated_at None
        let out = rank_by_query(vec![none, older, newer], "solo leveling");
        assert_eq!(ids(&out), vec!["newer", "older", "none"]);

        // Recency sama -> prioritas sumber: komiku < mangaku < shinigami < kiryuu.
        let same = Some(7);
        let a = {
            let mut m = m("kiryuu", "kiryuu", "Solo Leveling");
            m.updated_at = same;
            m
        };
        let b = {
            let mut m = m("komiku", "komiku", "Solo Leveling");
            m.updated_at = same;
            m
        };
        let out = rank_by_query(vec![a, b], "solo leveling");
        assert_eq!(ids(&out), vec!["komiku", "kiryuu"]);
    }

    /// 6. Kueri kosong = no-op; hasil = urutan + isi input apa adanya.
    #[test]
    fn kueri_kosong_noop() {
        let input = vec![
            m("komiku", "a", "Zeta"),
            m("komiku", "b", "Alpha"),
            m("komiku", "c", "Mid"),
        ];
        let out = rank_by_query(input.clone(), "   ");
        assert_eq!(ids(&out), ids(&input));
        let out2 = rank_by_query(input.clone(), "");
        assert_eq!(ids(&out2), ids(&input));
    }

    /// 7. NoMatch dibuang; sisanya utuh tanpa duplikasi.
    #[test]
    fn hasil_set_tidak_berubah_kecuali_nomatch() {
        let input = vec![
            m("komiku", "a", "Solo Leveling"),
            m("komiku", "b", "Solo Leveling Reawakening"),
            m("komiku", "c", "Solo Necromancy"),
            m("komiku", "d", "Unrelated Title"),
            m("komiku", "e", "solo max level newbie"),
        ];
        let out = rank_by_query(input, "solo leveling");
        assert_eq!(out.len(), 4, "NoMatch dibuang, sisanya utuh");
        assert!(!ids(&out).contains(&"d"), "judul tanpa token kueri harus hilang");
    }

    /// 7b. Kasus nyata P1: hasil fuzzy shinigami untuk "nano machine".
    #[test]
    fn nomatch_dibuang_saat_ada_yang_cocok() {
        let input = vec![
            m("shinigami", "nano", "Nano Machine"),
            m("shinigami", "sword", "Absolute Sword Sense"),
            m("shinigami", "demon", "Legend Of Heavenly Chaos Demon"),
        ];
        let out = rank_by_query(input, "nano machine");
        assert_eq!(ids(&out), vec!["nano"]);
    }

    /// 7c. Degradasi anggun: kueri yang cocok lewat field non-judul (author,
    ///     studio) tidak boleh mendadak jadi "tidak ada hasil".
    #[test]
    fn semua_nomatch_dikembalikan_utuh() {
        let input = vec![
            m("shinigami", "a", "Nano Machine"),
            m("shinigami", "b", "Pick Me Up"),
        ];
        let out = rank_by_query(input, "redice");
        assert_eq!(out.len(), 2, "jangan balas 0 untuk kueri author/studio");
    }

    /// 7d. Partial TIDAK ikut terbuang — hanya NoMatch.
    #[test]
    fn nomatch_tidak_memotong_partial() {
        let input = vec![
            m("shinigami", "one", "One Piece"),
            m("shinigami", "punch", "One Punch Man"),
            m("shinigami", "unrelated", "Kingdom"),
        ];
        let out = rank_by_query(input, "one piece");
        assert_eq!(ids(&out), vec!["one", "punch"]);
    }

    /// 8. Query dikenali case-insensitive (title_key sudah lowercase, tapi
    ///    query bisa campur huruf besar).
    #[test]
    fn kueri_case_insensitive() {
        let m1 = m("komiku", "m", "Solo Leveling");
        let m2 = m("komiku", "n", "Solo Necromancy");
        let out = rank_by_query(vec![m2, m1], "SOLO Leveling");
        assert_eq!(ids(&out), vec!["m", "n"]);
    }

    // -------------------------------------------------- dedup ceiling (feed)

    fn with_last(mut m: Manga, last: &str) -> Manga {
        m.last_chapter = Some(last.to_string());
        m
    }

    /// Skenario utama: shinigami 102, komikku 100 -> hanya shinigami tampil,
    /// komikku (di bawah ceiling) disembunyikan.
    #[test]
    fn ceiling_sembunyikan_update_di_bawah() {
        let s = with_last(m("shinigami", "s", "Solo Leveling"), "102");
        let k = with_last(m("komiku", "k", "Solo Leveling"), "100");
        let out = dedup_rank_ceiling(vec![s, k]);
        assert_eq!(ids(&out), vec!["s"]);
        assert_eq!(out[0].last_chapter.as_deref(), Some("102"));
    }

    /// komikku naik ke 103 (> ceiling 102) -> jadi pemenang baru.
    #[test]
    fn ceiling_tampil_saat_melebihi() {
        let s = with_last(m("shinigami", "s", "Solo Leveling"), "102");
        let k = with_last(m("komiku", "k", "Solo Leveling"), "103");
        let out = dedup_rank_ceiling(vec![s, k]);
        assert_eq!(ids(&out), vec!["k"]);
        assert_eq!(out[0].last_chapter.as_deref(), Some("103"));
    }

    /// Ceiling sama besar -> tiebreak SOURCE_PRIORITY (komiku > shinigami).
    #[test]
    fn ceiling_tie_prioritas() {
        let s = with_last(m("shinigami", "s", "Solo Leveling"), "102");
        let k = with_last(m("komiku", "k", "Solo Leveling"), "102");
        let out = dedup_rank_ceiling(vec![s, k]);
        assert_eq!(ids(&out), vec!["k"]);
    }

    /// Tanpa last_chapter numerik -> fallback recency/prioritas (perilaku lama).
    #[test]
    fn ceiling_fallback_non_numerik() {
        let a = with_last(m("shinigami", "a", "X"), "extra");
        let b = with_last(m("komiku", "b", "X"), "prologue");
        let out = dedup_rank_ceiling(vec![a, b]);
        assert_eq!(ids(&out), vec!["b"]);
    }

    /// Campur: non-numerik tidak ikut ceiling, numerik menang.
    #[test]
    fn ceiling_numerik_mengalahkan_non_numerik() {
        let a = with_last(m("komiku", "a", "X"), "extra");
        let b = with_last(m("shinigami", "b", "X"), "102");
        let out = dedup_rank_ceiling(vec![a, b]);
        assert_eq!(ids(&out), vec!["b"]);
        assert_eq!(out[0].last_chapter.as_deref(), Some("102"));
    }

    /// Urutan antar-series tetap recency desc (updated_at).
    #[test]
    fn ceiling_urut_recency_desc() {
        let mut t1 = with_last(m("shinigami", "t1", "Alpha"), "10");
        t1.updated_at = Some(500);
        let t2 = with_last(m("komiku", "t2", "Beta"), "5");
        let out = dedup_rank_ceiling(vec![t2, t1]);
        assert_eq!(ids(&out), vec!["t1", "t2"]);
    }

    /// Jumlah hasil = jumlah judul unik (tidak ada duplikat judul).
    #[test]
    fn ceiling_hasil_set_unik() {
        let a = with_last(m("shinigami", "a", "Solo Leveling"), "102");
        let b = with_last(m("komiku", "b", "Solo Leveling"), "100");
        let c = with_last(m("komiku", "c", "Lain"), "7");
        let out = dedup_rank_ceiling(vec![a, b, c]);
        assert_eq!(out.len(), 2);
    }

    // ---------------------------------------------- QA adversarial (ultraqa)

    /// Input kosong -> output kosong (tidak panic).
    #[test]
    fn ceiling_empty_input() {
        let out = dedup_rank_ceiling::<Manga>(vec![]);
        assert!(out.is_empty());
    }

    /// Satu entri numerik -> lolos apa adanya (jumlah tetap 1).
    #[test]
    fn ceiling_single_numeric() {
        let a = with_last(m("komiku", "a", "Solo"), "105");
        let out = dedup_rank_ceiling(vec![a]);
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].last_chapter.as_deref(), Some("105"));
    }

    /// Normalisasi desimal: "179.60" vs "179.6" = tie -> prioritas komiku menang.
    #[test]
    fn ceiling_tie_desimal_ternormalisasi() {
        let a = with_last(m("shinigami", "a", "X"), "179.60");
        let b = with_last(m("komiku", "b", "X"), "179.6");
        let out = dedup_rank_ceiling(vec![a, b]);
        assert_eq!(ids(&out), vec!["b"]);
    }

    /// Normalisasi nol depan: "007" vs "7" = tie -> prioritas komiku menang.
    #[test]
    fn ceiling_tie_leading_zero() {
        let a = with_last(m("shinigami", "a", "X"), "007");
        let b = with_last(m("komiku", "b", "X"), "7");
        let out = dedup_rank_ceiling(vec![a, b]);
        assert_eq!(ids(&out), vec!["b"]);
    }

    /// Nomor lebih tinggi menang MESKIPUN sumbernya prioritas lebih rendah.
    #[test]
    fn ceiling_angka_tinggi_menang_bebas_prioritas() {
        let a = with_last(m("komiku", "a", "X"), "100"); // prioritas tinggi
        let b = with_last(m("kiryuu", "b", "X"), "120"); // prioritas rendah, angka besar
        let out = dedup_rank_ceiling(vec![a, b]);
        assert_eq!(ids(&out), vec!["b"]);
        assert_eq!(out[0].last_chapter.as_deref(), Some("120"));
    }

    /// last_chapter None tidak ikut ceiling; yang punya angka menang.
    #[test]
    fn ceiling_none_tidak_ikut() {
        let a = m("komiku", "a", "X"); // last_chapter None
        let b = with_last(m("shinigami", "b", "X"), "55");
        let out = dedup_rank_ceiling(vec![a, b]);
        assert_eq!(ids(&out), vec!["b"]);
    }

    /// Non-numerik lebih baru TIDAK mengalahkan numerik (numerik tetap ceiling).
    #[test]
    fn ceiling_non_numerik_baru_kalah_numerik() {
        let mut a = with_last(m("komiku", "a", "X"), "extra"); // non-numerik
        a.updated_at = Some(9_999); // sangat baru
        let b = with_last(m("shinigami", "b", "X"), "50"); // numerik, lebih tua
        let out = dedup_rank_ceiling(vec![a, b]);
        assert_eq!(ids(&out), vec!["b"]);
    }

    /// Urutan input tidak mengubah hasil (deterministik).
    #[test]
    fn ceiling_deterministik_terhadap_urutan() {
        let a = with_last(m("komiku", "a", "X"), "100");
        let b = with_last(m("shinigami", "b", "X"), "120");
        let out1 = dedup_rank_ceiling(vec![a.clone(), b.clone()]);
        let out2 = dedup_rank_ceiling(vec![b, a]);
        assert_eq!(ids(&out1), ids(&out2));
        assert_eq!(ids(&out1), vec!["b"]);
    }

    /// Judul seri SAMA tapi beda tata kata lintas sumber -> merge (kunci
    /// kanonik): "A Disaster-Class Hero Has Returned" vs "The Return of The
    /// Disaster Class Hero". Pemenang = ceiling (keduanya 193 -> tie prioritas).
    #[test]
    fn ceiling_merge_seri_beda_tata_kata() {
        let a = with_last(m("komiku", "a", "A Disaster-Class Hero Has Returned"), "193");
        let b = with_last(m("shinigami", "b", "The Return of The Disaster Class Hero"), "193");
        let out = dedup_rank_ceiling(vec![a, b]);
        assert_eq!(out.len(), 1, "seri yang sama harus jadi satu kartu");
        assert_eq!(out[0].last_chapter.as_deref(), Some("193"));
    }

    /// Judul beda yang mirip TIDAK boleh merge.
    #[test]
    fn ceiling_tidak_merge_seri_beda_mirip() {
        let a = with_last(m("komiku", "a", "Return of the Monster Class Hero"), "10");
        let b = with_last(m("shinigami", "b", "Return of the Disaster Class Hero"), "10");
        let out = dedup_rank_ceiling(vec![a, b]);
        assert_eq!(out.len(), 2, "seri beda harus tetap dua kartu");
    }

    /// Memoize validasi tie: simpan lalu ambil balik (kunci kanonik, ceiling).
    #[test]
    fn tie_cache_simpan_dan_ambil() {
        let c = tie_validation_cache();
        c.lock().unwrap().insert(("x".into(), "193".into()), "handleA".into());
        let got = c.lock().unwrap().get(&("x".into(), "193".into())).cloned();
        assert_eq!(got.as_deref(), Some("handleA"));
    }

    /// Kartu crit: `last_chapter` memakai max lintas sumber sekunci kanonik.
    #[test]
    fn ceiling_kartu_search_pakai_max_lintas_sumber() {
        let a = with_last(m("komiku", "a", "Solo Leveling"), "100");
        let b = with_last(m("shinigami", "b", "Solo Leveling"), "105");
        let c = with_last(m("komiku", "c", "Solo Necromancy"), "9");
        let mut items = vec![a, b, c];
        apply_ceiling_last_chapter(&mut items);
        assert_eq!(items[0].last_chapter.as_deref(), Some("105"));
        assert_eq!(items[1].last_chapter.as_deref(), Some("105"));
        // seri beda tidak tersentuh
        assert_eq!(items[2].last_chapter.as_deref(), Some("9"));
    }
}
