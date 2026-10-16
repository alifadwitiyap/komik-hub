//! Trait umum tiap sumber. Adapter mengimplementasikan ini; aggregator hanya
//! bicara ke trait. Semua method async (RPITIT, Rust >= 1.75).
use crate::model::*;
use std::fmt;

pub type SourceResult<T> = anyhow::Result<T>;

/// Timeout per-request sumber di aggregator (detik).
pub const PER_SOURCE_TIMEOUT_SECS: u64 = 10;

/// Klasifikasi kegagalan sumber (A4). Bedakan "sumber menjawab: tidak ada"
/// (`Missing`/`Empty`) dari "sumber tidak bisa diakses"
/// (`RateLimited`/`Timeout`/`ParseError`/`Other`) supaya resolver tahu kapan
/// boleh pindah sumber TANPA menyimpulkan "chapter tidak ada" yang palsu.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SourceError {
    /// Sumber menyatakan manga/chapter tidak ada (404 / "tidak ditemukan").
    Missing,
    /// Ada tapi kosong: 0 gambar atau 0 chapter.
    Empty,
    /// HTTP 429 / rate limit.
    RateLimited,
    /// Timeout.
    Timeout,
    /// Respons tak sesuai harapan (struktur situs berubah, gagal parse).
    ParseError,
    /// Lainnya; pesan asli dibawa apa adanya.
    Other(String),
}

impl SourceError {
    /// Klasifikasi dari pesan error: adapter yang membungkus galalnya dengan
    /// [`classified`] dikenali persis; sisanya ditebak dari kata kunci.
    pub fn classify_message(msg: &str) -> Self {
        let m = msg.to_lowercase();
        let has = |needle: &str| m.contains(needle);
        if has("timeout") || has("timed out") {
            return SourceError::Timeout;
        }
        if has("429") || has("rate limit") || has("rate limited") || has("too many requests") {
            return SourceError::RateLimited;
        }
        // "struktur situs berubah" / parse — diperiksa SEBELUM "tidak ditemukan"
        // karena pesan parser juga memakai kata itu ("data-page tidak
        // ditemukan di ... (struktur situs berubah?)").
        if has("struktur") || has("berubah") || has("tak terduga") || has("parse") {
            return SourceError::ParseError;
        }
        if has("tidak ditemukan") || has("not found") || has("404") || has("tidak ada data") {
            return SourceError::Missing;
        }
        if has("kosong") || has("empty") || has("tanpa gambar") || has("tidak punya gambar") {
            return SourceError::Empty;
        }
        SourceError::Other(msg.to_string())
    }

    /// True kalau sumber TERAKSES dan pernyataannya pasti: boleh jadi dasar
    /// negative-cache + kesimpulan "chapter tidak ada di sumber ini".
    pub fn is_conclusive(&self) -> bool {
        matches!(self, SourceError::Missing | SourceError::Empty)
    }

    /// True kalau sumber TIDAK bisa diakses — TIDAK boleh masuk negative cache
    /// dan TIDAK boleh disimpulkan sebagai "tidak ada".
    pub fn is_inaccessible(&self) -> bool {
        !self.is_conclusive()
    }
}

impl fmt::Display for SourceError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            SourceError::Missing => f.write_str("tidak ada di sumber"),
            SourceError::Empty => f.write_str("kosong (tanpa gambar/chapter)"),
            SourceError::RateLimited => f.write_str("rate limited"),
            SourceError::Timeout => f.write_str("timeout"),
            SourceError::ParseError => f.write_str("respons sumber gagal diparse"),
            SourceError::Other(m) => f.write_str(m),
        }
    }
}

impl std::error::Error for SourceError {}

/// Galat berdetail yang sekaligus terklasifikasi: adapter yang tahu pasti
/// penyebabnya memakai [`classified`] supaya pesan asli utuh DAN kelasnya
/// tepat (heuristik teks tidak perlu menebak).
#[derive(Debug)]
pub struct ClassifiedError {
    pub kind: SourceError,
    pub msg: String,
}

impl fmt::Display for ClassifiedError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.msg)
    }
}

impl std::error::Error for ClassifiedError {}

/// Bungkus pesan apa adanya jadi `anyhow::Error` ber-kelas `kind`.
pub fn classified(kind: SourceError, msg: impl Into<String>) -> anyhow::Error {
    anyhow::Error::new(ClassifiedError { kind, msg: msg.into() })
}

fn kind_of(e: &anyhow::Error) -> SourceError {
    e.downcast_ref::<ClassifiedError>()
        .map(|c| c.kind.clone())
        .unwrap_or_else(|| SourceError::classify_message(&format!("{e:#}")))
}

impl From<anyhow::Error> for SourceError {
    fn from(e: anyhow::Error) -> Self {
        kind_of(&e)
    }
}

impl From<&anyhow::Error> for SourceError {
    fn from(e: &anyhow::Error) -> Self {
        kind_of(e)
    }
}

#[async_trait::async_trait]
pub trait Source: Send + Sync {
    fn id(&self) -> SourceId;

    /// Ranking populer sumber ini.
    async fn popular(&self, page: u32) -> SourceResult<Vec<Manga>>;

    /// Update terbaru sumber ini.
    async fn latest(&self, page: u32) -> SourceResult<Vec<Manga>>;

    /// Pencarian judul.
    async fn search(&self, query: &str, page: u32) -> SourceResult<Vec<Manga>>;

    /// Katalog dengan filter genre opsional (slug/nama tergantung sumber).
    async fn list(&self, genre: Option<&str>, page: u32) -> SourceResult<Vec<Manga>>;

    /// Daftar genre: (slug, nama).
    async fn genres(&self) -> SourceResult<Vec<(String, String)>>;

    /// Detail series + chapter (terbaru dulu).
    async fn series(&self, native_id: &str) -> SourceResult<SeriesDetail>;

    /// Gambar chapter. Manga & chapter dua-duanya diberikan karena sebagian
    /// sumber (kiryuu/mangaku) butuh slug manga + nomor chapter.
    async fn chapter_pages(&self, manga: &Manga, chapter: &Chapter) -> SourceResult<ChapterPages>;

    /// Cari manga by judul (exact normalized match). Dipakai untuk
    /// `read <judul> <chapter>` tanpa handle eksplisit.
    async fn resolve(&self, title: &str) -> SourceResult<Option<Manga>> {
        let key = title_key(title);
        let hits = self.search(title, 1).await?;
        Ok(hits.into_iter().find(|m| m.title_key == key))
    }

    /// Pencarian judul SEKALIGUS filter genre — dipakai dropdown "Genre" di
    /// halaman Cari supaya filternya benar-benar menyaring, bukan cuma
    /// memberi tahu ketersediaan.
    ///
    /// Default = genre DIABAIKAN (kembali ke `search` biasa). Adapter yang
    /// upstream-nya mendukung WAJIB override:
    /// - komiku    : `index("page/{n}/", [("s", q), ("genre", slug)])`
    /// - mangaku   : `list_filtered(genre, None, Some(q), None, page)`
    /// - shinigami : `/manga/list` + `q` + `genre` (slug kalau berspasi)
    /// - kiryuu    : `search_page(page, q, "popular", Some(slug))`
    ///
    /// `genre` = slug/nama genre apa adanya dari union `/genres`; setiap
    /// adapter menormalkan sendiri (kiryuu butuh slug, shinigami slug-ify
    /// nama berspasi). Adapter yang tidak override membuat hasilnya LEBIH
    /// LUAS dari yang diminta — itu batas jujur, bukan hasil palsu.
    async fn search_in_genre(
        &self,
        query: &str,
        page: u32,
        genre: Option<&str>,
    ) -> SourceResult<Vec<Manga>> {
        let _ = genre;
        self.search(query, page).await
    }

    /// Probe liveness sumber ini (uji cepat "sumber ini hidup?").
    ///
    /// Default = satu panggilan `genres()` (endpoint metadata paling murah di
    /// keempat adapter). Adapter BOLEH override ke endpoint yang lebih murah
    /// (HEAD/health) kalau nanti perlu.
    ///
    /// Kenapa method trait dan BUKAN HTTP mentah ke base URL: setiap adapter
    /// pegang client-nya sendiri. Kiryuu resolve host lewat Cloudflare DoH
    /// karena `*.kiryuu.to` DNS-block di jaringan ID; reqwest langsung ke host
    /// itu akan lapor MATI padahal sumbernya hidup. Probe lewat trait method
    /// ikut pinning DNS adapter-nya.
    ///
    /// ponytail: default `genres()` (bukan HEAD/health) karena keempat adapter
    /// belum punya endpoint health; ganti default kalau semua adapter sudah
    /// expose endpoint ringan.
    async fn ping(&self) -> SourceResult<()> {
        self.genres().await.map(|_| ())
    }
}
