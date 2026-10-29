//! Isolasi kegagalan PER SUMBER (circuit breaker).
//!
//! Kenapa ada: core aggregator sudah fan-out paralel + timeout per sumber,
//! TAPI hasil dengan kegagalan sengaja TIDAK di-cache
//! (`aggregator.rs:727`). Akibatnya, selama satu sumber mati (mis.
//! index.komikid.org timeout), SETIAP request daftar/search membayar penuh
//! timeout sumber itu lagi — request user jadi lambat terus-menerus.
//!
//! Wrapper ini membuka breaker setelah satu kegagalan "tidak bisa diakses"
//! (timeout/jaringan/5xx/parse) dan melewati sumber itu selama
//! [`SOURCE_COOLDOWN`]. Setelah cooldown, satu percobaan (half-open) boleh
//! lewat; sukses menutup breaker, gagal membukanya lagi.
//!
//! Yang TIDAK di-breaker: `ping()`. Probe health harus selalu mencoba
//! sumber asli supaya sumber yang sudah pulih bisa langsung terdeteksi.
//!
//! Ini murni lapisan server; core (CLI) tidak berubah.

use std::sync::Arc;
use std::time::{Duration, Instant};

use komik_core::model::{Chapter, ChapterPages, Manga, SeriesDetail, SourceId};
use komik_core::source::{classified, Source, SourceError, SourceResult};

/// Timeout per operasi sumber di server. Diukur: `index.komikid.org` (API komiku)
/// punya TTFB median 5.0 s, p90 5.4 s, maks 9.6 s saat dibebani, dan memburuk
/// saat request paralel — jadi 6 s membuat search komiku SELALU timeout
/// (`failed_sources=['komiku']`) meski upstream sehat. 15 s memberi ruang
/// di atas p90 + variasi beban origin. Ini kompensasi sadar: akar masalahnya
/// origin komikid lambat (TTFB 5-9 s), bukan jaringan kita (DNS 11 ms,
/// TCP 293 ms, TLS 310 ms).
pub const SOURCE_TIMEOUT_SECS: u64 = 15;

/// Lama sumber dilewati setelah gagal. Cukup pendek supaya pemulihan cepat,
/// cukup panjang supaya request beruntun tidak menembak sumber mati terus.
pub const SOURCE_COOLDOWN: Duration = Duration::from_secs(30);

/// Timeout DI DALAM wrapper, sengaja sedikit lebih pendek dari timeout
/// aggregator (15 s). Kalau sama, timeout luar bisa membatalkan future wrapper
/// lebih dulu sehingga `record()` tak pernah jalan dan breaker tak terbuka.
/// Diukur: TTFB `index.komikid.org` median 5.0 s, p90 5.4 s, maks 9.6 s —
/// 5.5 s lama membuat search komiku selalu timeout padahal upstream sehat.
pub const SOURCE_INNER_TIMEOUT: Duration = Duration::from_millis(14_500);

/// Statistik runtime per sumber, untuk endpoint `/api/stats`.
///
/// Sengaja global (bukan field di `ResilientSource`) supaya tidak mengubah
/// signature `ResilientSource::new`/`wrap_all` dan tidak perlu meneruskan
/// state ke `Aggregator`. Dihitung di `record()` — satu-satunya titik yang
/// dilewati SEMUA operasi sumber, jadi angkanya tidak bisa bolong.
pub mod stats {
    use std::collections::BTreeMap;
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::sync::Mutex;
    use std::sync::OnceLock;

    #[derive(Default, Clone, Copy)]
    pub struct Counter {
        pub calls: u64,
        pub ok: u64,
        pub fail: u64,
        pub timeout: u64,
        /// Berapa kali sumber ini membuka breaker (cooldown).
        pub breaker_open: u64,
    }

    fn table() -> &'static Mutex<BTreeMap<String, Counter>> {
        static T: OnceLock<Mutex<BTreeMap<String, Counter>>> = OnceLock::new();
        T.get_or_init(|| Mutex::new(BTreeMap::new()))
    }

    /// Total request yang dilayani server (semua endpoint).
    pub static REQUESTS: AtomicU64 = AtomicU64::new(0);
    /// Total respons gambar 502 dari proxy /img (host mati / diblokir).
    pub static IMG_FAIL: AtomicU64 = AtomicU64::new(0);

    pub fn record_call(source: &str, ok: bool, is_timeout: bool) {
        let mut t = table().lock().unwrap_or_else(|e| e.into_inner());
        let c = t.entry(source.to_string()).or_default();
        c.calls += 1;
        if ok {
            c.ok += 1;
        } else {
            c.fail += 1;
            if is_timeout {
                c.timeout += 1;
            }
        }
    }

    pub fn record_breaker_open(source: &str) {
        let mut t = table().lock().unwrap_or_else(|e| e.into_inner());
        t.entry(source.to_string()).or_default().breaker_open += 1;
    }

    /// Snapshot JSON-ready. `requests`/`img_fail` adalah angka global server.
    pub fn snapshot() -> serde_json::Value {
        let t = table().lock().unwrap_or_else(|e| e.into_inner());
        let per: serde_json::Map<String, serde_json::Value> = t
            .iter()
            .map(|(k, c)| {
                (
                    k.clone(),
                    serde_json::json!({
                        "calls": c.calls,
                        "ok": c.ok,
                        "fail": c.fail,
                        "timeout": c.timeout,
                        "breaker_open": c.breaker_open,
                    }),
                )
            })
            .collect();
        serde_json::json!({
            "requests": REQUESTS.load(Ordering::Relaxed),
            "img_fail": IMG_FAIL.load(Ordering::Relaxed),
            "sources": per,
        })
    }
}

struct BreakerState {
    /// `Some(t)` = breaker terbuka sampai `t`.
    open_until: Option<Instant>,
    last_error: String,
}

/// Sumber yang dibungkus circuit breaker. Semua method trait didelegasikan;
/// hanya jalur `ping` yang sengaja tidak di-gate.
pub struct ResilientSource {
    inner: Arc<dyn Source>,
    cooldown: Duration,
    timeout: Duration,
    state: std::sync::Mutex<BreakerState>,
}

impl ResilientSource {
    pub fn new(inner: Arc<dyn Source>, cooldown: Duration, timeout: Duration) -> Self {
        Self {
            inner,
            cooldown,
            timeout,
            state: std::sync::Mutex::new(BreakerState {
                open_until: None,
                last_error: String::new(),
            }),
        }
    }

    /// Bungkus semua sumber dengan breaker yang sama konfigurasinya.
    pub fn wrap_all(
        sources: Vec<Arc<dyn Source>>,
        cooldown: Duration,
        timeout: Duration,
    ) -> Vec<Arc<dyn Source>> {
        sources
            .into_iter()
            .map(|s| Arc::new(Self::new(s, cooldown, timeout)) as Arc<dyn Source>)
            .collect()
    }

    /// `Err` = breaker terbuka; sumber TIDAK disentuh.
    fn gate(&self) -> SourceResult<()> {
        let st = self.state.lock().unwrap_or_else(|e| e.into_inner());
        match st.open_until {
            Some(until) if Instant::now() < until => {
                let sisa = until.saturating_duration_since(Instant::now());
                let msg = format!(
                    "{}: sumber dilewati (cooldown {}s, galat terakhir: {})",
                    self.inner.id().as_str(),
                    sisa.as_secs().max(1),
                    st.last_error
                );
                Err(classified(SourceError::Other(msg.clone()), msg))
            }
            _ => {
                // Cooldown lewat (atau belum pernah terbuka) -> izinkan trial
                // half-open. `open_until` sengaja TIDAK dibersihkan di sini;
                // `close()` yang membersihkannya setelah trial sukses supaya
                // log pemulihan bisa membedakan "baru pulih" dari "normal".
                Ok(())
            }
        }
    }

    fn record<T>(&self, res: &SourceResult<T>) {
        match res {
            Ok(_) => {
                stats::record_call(self.inner.id().as_str(), true, false);
                self.close();
            }
            Err(e) => {
                let kind = SourceError::from(e);
                stats::record_call(
                    self.inner.id().as_str(),
                    false,
                    matches!(kind, SourceError::Timeout),
                );
                if kind.is_inaccessible() {
                    self.open(kind.to_string());
                } else {
                    // Sumber menjawab (missing/empty) -> hidup, jangan breaker.
                    self.close();
                }
            }
        }
    }

    fn open(&self, reason: String) {
        stats::record_breaker_open(self.inner.id().as_str());
        let mut st = self.state.lock().unwrap_or_else(|e| e.into_inner());
        st.open_until = Some(Instant::now() + self.cooldown);
        st.last_error = reason.clone();
        tracing::warn!(
            "sumber {} gagal ({}), di-cooldown {}s",
            self.inner.id().as_str(),
            reason,
            self.cooldown.as_secs()
        );
    }

    fn close(&self) {
        let mut st = self.state.lock().unwrap_or_else(|e| e.into_inner());
        let was_open = st.open_until.take().is_some();
        st.last_error.clear();
        if was_open {
            tracing::info!("sumber {} pulih, breaker ditutup", self.inner.id().as_str());
        }
    }
}

/// Delegasi + gate untuk satu operasi trait. Timeout di sini WAJIB lebih
/// pendek dari timeout aggregator supaya kegagalan tercatat di breaker.
macro_rules! guarded {
    ($self:ident, $call:expr) => {{
        $self.gate()?;
        let res = match tokio::time::timeout($self.timeout, $call).await {
            Ok(r) => r,
            Err(_) => Err(classified(
                SourceError::Timeout,
                format!("timeout {} ms", $self.timeout.as_millis()),
            )),
        };
        $self.record(&res);
        res
    }};
}

#[async_trait::async_trait]
impl Source for ResilientSource {
    fn id(&self) -> SourceId {
        self.inner.id()
    }

    async fn popular(&self, page: u32) -> SourceResult<Vec<Manga>> {
        guarded!(self, self.inner.popular(page))
    }

    async fn latest(&self, page: u32) -> SourceResult<Vec<Manga>> {
        guarded!(self, self.inner.latest(page))
    }

    async fn search(&self, query: &str, page: u32) -> SourceResult<Vec<Manga>> {
        guarded!(self, self.inner.search(query, page))
    }

    async fn list(&self, genre: Option<&str>, page: u32) -> SourceResult<Vec<Manga>> {
        guarded!(self, self.inner.list(genre, page))
    }

    async fn genres(&self) -> SourceResult<Vec<(String, String)>> {
        guarded!(self, self.inner.genres())
    }

    async fn series(&self, native_id: &str) -> SourceResult<SeriesDetail> {
        guarded!(self, self.inner.series(native_id))
    }

    async fn chapter_pages(&self, manga: &Manga, chapter: &Chapter) -> SourceResult<ChapterPages> {
        guarded!(self, self.inner.chapter_pages(manga, chapter))
    }

    async fn search_in_genre(
        &self,
        query: &str,
        page: u32,
        genre: Option<&str>,
    ) -> SourceResult<Vec<Manga>> {
        guarded!(self, self.inner.search_in_genre(query, page, genre))
    }

    /// Probe health: SELALU coba sumber asli, jangan di-gate. Hasilnya tetap
    /// dicatat supaya probe sukses bisa menutup breaker yang terbuka.
    async fn ping(&self) -> SourceResult<()> {
        let res = self.inner.ping().await;
        self.record(&res);
        res
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};

    /// Mock minimal: `search` bisa sukses/gagal/timeout; operasi lain kosong.
    struct Mock {
        id: SourceId,
        fail: AtomicBool,
        conclusive: AtomicBool,
        calls: AtomicUsize,
        delay_ms: AtomicU64,
    }

    impl Mock {
        fn new(id: &str) -> Self {
            Self {
                id: SourceId::from(id),
                fail: AtomicBool::new(false),
                conclusive: AtomicBool::new(false),
                calls: AtomicUsize::new(0),
                delay_ms: AtomicU64::new(0),
            }
        }
        fn calls(&self) -> usize {
            self.calls.load(Ordering::SeqCst)
        }
    }

    #[async_trait::async_trait]
    impl Source for Mock {
        fn id(&self) -> SourceId {
            self.id.clone()
        }
        async fn popular(&self, _p: u32) -> SourceResult<Vec<Manga>> {
            Ok(vec![])
        }
        async fn latest(&self, _p: u32) -> SourceResult<Vec<Manga>> {
            Ok(vec![])
        }
        async fn search(&self, _q: &str, _p: u32) -> SourceResult<Vec<Manga>> {
            self.calls.fetch_add(1, Ordering::SeqCst);
            let delay = self.delay_ms.load(Ordering::SeqCst);
            if delay > 0 {
                tokio::time::sleep(Duration::from_millis(delay)).await;
            }
            if self.fail.load(Ordering::SeqCst) {
                if self.conclusive.load(Ordering::SeqCst) {
                    return Err(classified(SourceError::Missing, "tidak ditemukan"));
                }
                return Err(classified(SourceError::Timeout, "timeout 6s"));
            }
            Ok(vec![])
        }
        async fn list(&self, _g: Option<&str>, _p: u32) -> SourceResult<Vec<Manga>> {
            Ok(vec![])
        }
        async fn genres(&self) -> SourceResult<Vec<(String, String)>> {
            Ok(vec![])
        }
        async fn series(&self, _id: &str) -> SourceResult<SeriesDetail> {
            Ok(SeriesDetail {
                manga: Manga::new(self.id.clone(), "1", "Mock"),
                chapters: vec![],
            })
        }
        async fn chapter_pages(&self, _m: &Manga, _c: &Chapter) -> SourceResult<ChapterPages> {
            Ok(ChapterPages {
                images: vec![],
                title: "Mock".into(),
                number: "1".into(),
                source: self.id.clone(),
            })
        }
    }

    /// Satu timeout membuka breaker; request kedua TIDAK menyentuh sumber.
    #[tokio::test]
    async fn timeout_membuka_breaker_dan_melewati_sumber() {
        let mock = Arc::new(Mock::new("komiku"));
        mock.fail.store(true, Ordering::SeqCst);
        let src = ResilientSource::new(
            mock.clone(),
            Duration::from_secs(60),
            Duration::from_secs(5),
        );

        let e1 = src.search("x", 1).await.unwrap_err();
        assert!(format!("{e1:#}").contains("timeout"));
        assert_eq!(mock.calls(), 1);

        let e2 = src.search("x", 1).await.unwrap_err();
        assert!(format!("{e2:#}").contains("cooldown"), "pesan: {e2:#}");
        assert_eq!(mock.calls(), 1, "sumber tidak boleh disentuh saat cooldown");
    }

    /// Cooldown habis -> trial half-open; sukses menutup breaker.
    #[tokio::test]
    async fn cooldown_habis_mencoba_lagi_dan_menutup_breaker() {
        let mock = Arc::new(Mock::new("komiku"));
        mock.fail.store(true, Ordering::SeqCst);
        let src = ResilientSource::new(
            mock.clone(),
            Duration::from_millis(30),
            Duration::from_secs(5),
        );
        assert!(src.search("x", 1).await.is_err());
        assert_eq!(mock.calls(), 1);

        mock.fail.store(false, Ordering::SeqCst);
        tokio::time::sleep(Duration::from_millis(40)).await;
        assert!(src.search("x", 1).await.is_ok());
        assert_eq!(mock.calls(), 2, "trial half-open harus menyentuh sumber");

        // Sudah tertutup: request berikutnya tetap jalan.
        assert!(src.search("x", 1).await.is_ok());
        assert_eq!(mock.calls(), 3);
    }

    /// Timeout DI DALAM wrapper harus tercatat (bukan cuma dibatalkan timeout
    /// luar aggregator). Tanpa ini, breaker tidak pernah terbuka.
    #[tokio::test]
    async fn timeout_internal_membuka_breaker() {
        let mock = Arc::new(Mock::new("komiku"));
        mock.delay_ms.store(200, Ordering::SeqCst);
        let src = ResilientSource::new(
            mock.clone(),
            Duration::from_secs(60),
            Duration::from_millis(30),
        );

        let e1 = src.search("x", 1).await.unwrap_err();
        assert!(format!("{e1:#}").contains("timeout"), "pesan: {e1:#}");
        assert_eq!(mock.calls(), 1);

        let e2 = src.search("x", 1).await.unwrap_err();
        assert!(format!("{e2:#}").contains("cooldown"), "pesan: {e2:#}");
        assert_eq!(
            mock.calls(),
            1,
            "request kedua tidak boleh menyentuh sumber"
        );
    }

    /// Galat "tidak ada" = sumber HIDUP; jangan buka breaker.
    #[tokio::test]
    async fn galat_conclusive_tidak_membuka_breaker() {
        let mock = Arc::new(Mock::new("komiku"));
        mock.fail.store(true, Ordering::SeqCst);
        mock.conclusive.store(true, Ordering::SeqCst);
        let src = ResilientSource::new(
            mock.clone(),
            Duration::from_secs(60),
            Duration::from_secs(5),
        );

        assert!(src.search("x", 1).await.is_err());
        assert!(src.search("x", 1).await.is_err());
        assert_eq!(mock.calls(), 2, "missing bukan alasan short-circuit");
    }

    /// Timeout dalam HARUS lebih pendek dari timeout luar, kalau tidak
    /// `record()` tak pernah jalan dan breaker tidak pernah terbuka.
    /// Dikunci di sini karena dua konstanta ini mudah diubah terpisah.
    #[test]
    fn timeout_dalam_lebih_pendek_dari_luar() {
        let luar = Duration::from_secs(SOURCE_TIMEOUT_SECS);
        assert!(
            SOURCE_INNER_TIMEOUT < luar,
            "SOURCE_INNER_TIMEOUT ({:?}) harus < SOURCE_TIMEOUT_SECS ({:?})",
            SOURCE_INNER_TIMEOUT,
            luar
        );
    }

    /// Nilai 15 s dipilih dari pengukuran, bukan tebakan: TTFB
    /// index.komikid.org median 5.0 s / p90 5.4 s / maks 9.6 s.
    /// Test ini memaku keputusan itu supaya tidak turun diam-diam.
    #[test]
    fn timeout_cukup_untuk_komiku_yang_lambat() {
        assert_eq!(SOURCE_TIMEOUT_SECS, 15);
        assert_eq!(SOURCE_INNER_TIMEOUT, Duration::from_millis(14_500));
    }
}
