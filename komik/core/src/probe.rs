//! Probe liveness per-sumber: panggil `Source::ping` (bukan HTTP langsung) di
//! setiap sumber secara paralel dengan timeout PER-SUMBER, lalu ringkas jadi
//! `Vec<SourceHealth>` yang siap dirender CLI/server.
//!
//! Kenapa lewat trait, bukan reqwest ke base URL: setiap adapter memegang
//! client-nya sendiri (UA, header seed, retry). Kiryuu resolve host via
//! Cloudflare DoH karena `*.kiryuu.to` DNS-block di jaringan ID — probe HTTP
//! langsung ke host itu akan lapor MATI padahal sumbernya hidup.
use crate::model::SourceId;
use crate::source::Source;
use std::sync::Arc;
use std::time::Duration;

/// Timeout per sumber untuk probe (detik). Lebih pendek dari
/// [`crate::source::PER_SOURCE_TIMEOUT_SECS`] karena probe hanya menjawab
/// hidup/mati — tak ada payload besar. Tetap dibatasi supaya satu sumber
/// menggantung tak menahan seluruh vektor probe sampai timeout aggregator penuh.
pub const PROBE_TIMEOUT_SECS: u64 = 5;

/// Klasifikasi hasil probe.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Health {
    /// Sumber menjawab sukses dalam batas waktu.
    Alive,
    /// Sumber tak bisa diakses (jaringan / 429 / timeout / parse).
    Degraded,
}

/// Ringkasan kesehatan satu sumber — siap dirender satu baris.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SourceHealth {
    pub source: SourceId,
    pub health: Health,
    /// Rincian galat (kosong kalau `Alive`).
    pub detail: String,
}

impl SourceHealth {
    pub fn alive(source: SourceId) -> Self {
        SourceHealth {
            source,
            health: Health::Alive,
            detail: String::new(),
        }
    }

    pub fn degraded(source: SourceId, detail: impl Into<String>) -> Self {
        SourceHealth {
            source,
            health: Health::Degraded,
            detail: detail.into(),
        }
    }

    /// `komiku alive` / `kiryuu down: timeout 5s`.
    pub fn line(&self) -> String {
        match self.health {
            Health::Alive => format!("{} alive", self.source.as_str()),
            Health::Degraded => format!("{} down: {}", self.source.as_str(), self.detail),
        }
    }
}

/// Probe satu sumber dengan timeout eksplisit. Selalu mengembalikan
/// `SourceHealth` (tidak melempar): laporan kesehatan tak boleh menggagalkan
/// pemanggil.
///
/// Sengaja lewat [`Source::ping`] dan bukan request payload: satu round-trip
/// metadata, dan adapter tetap boleh memilih endpoint paling murah sendiri.
/// Tak menyentuh cache: hasil cache membuat probe selalu "alive" walau sumber
/// sudah mati.
pub async fn probe_source_with_timeout(src: Arc<dyn Source>, timeout: Duration) -> SourceHealth {
    let id = src.id();
    match tokio::time::timeout(timeout, src.ping()).await {
        Ok(Ok(())) => SourceHealth::alive(id),
        Ok(Err(e)) => SourceHealth::degraded(id, format!("{e:#}")),
        Err(_) => SourceHealth::degraded(id, format!("timeout {}", fmt_timeout(timeout))),
    }
}

/// `Duration` -> "5s" / "250ms" supaya timeout sub-detik (test) tidak
/// dilaporkan sebagai "0s".
fn fmt_timeout(d: Duration) -> String {
    if d.as_secs() > 0 && d.subsec_millis() == 0 {
        format!("{}s", d.as_secs())
    } else if d.as_secs() > 0 {
        format!("{}.{:03}s", d.as_secs(), d.subsec_millis())
    } else {
        format!("{}ms", d.subsec_millis())
    }
}

/// Probe satu sumber dengan timeout default [`PROBE_TIMEOUT_SECS`].
pub async fn probe_source(src: Arc<dyn Source>) -> SourceHealth {
    probe_source_with_timeout(src, Duration::from_secs(PROBE_TIMEOUT_SECS)).await
}

/// Probe semua sumber secara paralel dengan timeout eksplisit. Urutan output
/// mengikuti `sources` (`all_sources` = urutan `SOURCE_PRIORITY`), bukan urutan
/// selesai, supaya tampilan stabil.
pub async fn probe_sources_with_timeout(
    sources: &[Arc<dyn Source>],
    timeout: Duration,
) -> Vec<SourceHealth> {
    let mut set = tokio::task::JoinSet::new();
    for src in sources {
        let src = Arc::clone(src);
        set.spawn(async move { probe_source_with_timeout(src, timeout).await });
    }
    let mut out = Vec::with_capacity(sources.len());
    while let Some(joined) = set.join_next().await {
        match joined {
            Ok(h) => out.push(h),
            Err(e) => out.push(SourceHealth::degraded(
                SourceId::from("?"),
                format!("probe task gagal: {e}"),
            )),
        }
    }
    // JoinSet mengembalikan urutan selesai; kembalikan ke urutan `sources`
    // supaya tampilan stabil. Cocokkan id ke slot sumber yang belum terisi.
    if out.len() == sources.len() {
        let mut ordered: Vec<Option<SourceHealth>> = (0..sources.len()).map(|_| None).collect();
        for h in out.drain(..) {
            let slot = sources
                .iter()
                .enumerate()
                .find(|(i, s)| s.id() == h.source && ordered[*i].is_none())
                .map(|(i, _)| i)
                .or_else(|| ordered.iter().position(|s| s.is_none()));
            if let Some(i) = slot {
                ordered[i] = Some(h);
            }
        }
        if let Some(done) = ordered.into_iter().collect::<Option<Vec<_>>>() {
            return done;
        }
    }
    out
}

/// Probe semua sumber dengan timeout default [`PROBE_TIMEOUT_SECS`].
pub async fn probe_sources(sources: &[Arc<dyn Source>]) -> Vec<SourceHealth> {
    probe_sources_with_timeout(sources, probe_timeout()).await
}

/// Timeout default probe: [`PROBE_TIMEOUT_SECS`]. Pemanggil yang butuh nilai
/// default (mis. CLI mau menampilkannya) ambil dari sini, bukan hardcode.
pub fn probe_timeout() -> Duration {
    Duration::from_secs(PROBE_TIMEOUT_SECS)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{Chapter, ChapterPages, Manga, SeriesDetail};
    use crate::source::{classified, SourceError, SourceResult};

    struct Stub {
        id: &'static str,
        /// `Some(Ok)` = hidup, `Some(Err(msg))` = degradasi, `None` = menggantung.
        behavior: Option<Result<(), &'static str>>,
    }

    impl Stub {
        fn alive(id: &'static str) -> Self {
            Stub {
                id,
                behavior: Some(Ok(())),
            }
        }
        fn degraded(id: &'static str, msg: &'static str) -> Self {
            Stub {
                id,
                behavior: Some(Err(msg)),
            }
        }
        fn hanging(id: &'static str) -> Self {
            Stub { id, behavior: None }
        }
    }

    #[async_trait::async_trait]
    impl Source for Stub {
        fn id(&self) -> SourceId {
            SourceId::from(self.id)
        }
        async fn popular(&self, _p: u32) -> SourceResult<Vec<Manga>> {
            Ok(vec![])
        }
        async fn latest(&self, _p: u32) -> SourceResult<Vec<Manga>> {
            Ok(vec![])
        }
        async fn search(&self, _q: &str, _p: u32) -> SourceResult<Vec<Manga>> {
            Ok(vec![])
        }
        async fn list(&self, _g: Option<&str>, _p: u32) -> SourceResult<Vec<Manga>> {
            Ok(vec![])
        }
        async fn genres(&self) -> SourceResult<Vec<(String, String)>> {
            Ok(vec![])
        }
        async fn series(&self, _id: &str) -> SourceResult<SeriesDetail> {
            unimplemented!("probe tidak memakai series")
        }
        async fn chapter_pages(&self, _m: &Manga, _c: &Chapter) -> SourceResult<ChapterPages> {
            unimplemented!("probe tidak memakai chapter_pages")
        }
        async fn ping(&self) -> SourceResult<()> {
            match self.behavior {
                Some(Ok(())) => Ok(()),
                Some(Err(msg)) => Err(classified(SourceError::Timeout, msg.to_string())),
                // Lebih lama dari PROBE_TIMEOUT_SECS supaya probe menyerah.
                None => {
                    tokio::time::sleep(Duration::from_secs(PROBE_TIMEOUT_SECS + 30)).await;
                    Ok(())
                }
            }
        }
    }

    #[tokio::test]
    async fn probe_reports_alive_and_timeout() {
        let fast = Duration::from_millis(250);
        let out = probe_sources_with_timeout(
            &[
                Arc::new(Stub::alive("komiku")) as Arc<dyn Source>,
                Arc::new(Stub::hanging("kiryuu")) as Arc<dyn Source>,
            ],
            fast,
        )
        .await;
        assert_eq!(out.len(), 2);
        assert_eq!(out[0], SourceHealth::alive(SourceId::from("komiku")));
        assert_eq!(out[1].health, Health::Degraded);
        assert_eq!(out[1].line(), "kiryuu down: timeout 250ms");
    }

    /// Timeout default ikut konstannya (bukan angka yang di-hardcode di sana-sini).
    #[tokio::test]
    async fn probe_default_timeout_matches_constant() {
        assert_eq!(
            probe_timeout(),
            Duration::from_secs(PROBE_TIMEOUT_SECS),
            "timeout default harus tetap sama dengan konstannya"
        );
    }

    /// `probe_sources` (tanpa timeout eksplisit) memakai default dan tetap
    /// mengembalikan satu status per sumber yang hidup.
    #[tokio::test]
    async fn probe_sources_default_path_reports_alive() {
        let out = probe_sources(&[Arc::new(Stub::alive("komiku")) as Arc<dyn Source>]).await;
        assert_eq!(out[0].line(), "komiku alive");
    }

    /// Pesan timeout sub-detik dilaporkan sebagai ms, bukan "0s".
    #[tokio::test]
    async fn timeout_message_formats_seconds_and_millis() {
        assert_eq!(fmt_timeout(Duration::from_secs(5)), "5s");
        assert_eq!(fmt_timeout(Duration::from_millis(250)), "250ms");
        assert_eq!(fmt_timeout(Duration::from_millis(1500)), "1.500s");
    }

    #[tokio::test]
    async fn probe_surfaces_adapters_own_error_detail() {
        let bad = Arc::new(Stub::degraded(
            "mangaku",
            "HTTP 503 dari https://mangaku.lol",
        )) as Arc<dyn Source>;
        let out = probe_sources_with_timeout(&[bad], Duration::from_secs(2)).await;
        assert_eq!(out[0].health, Health::Degraded);
        assert_eq!(out[0].detail, "HTTP 503 dari https://mangaku.lol");
        assert_eq!(
            out[0].line(),
            "mangaku down: HTTP 503 dari https://mangaku.lol"
        );
    }

    #[tokio::test]
    async fn probe_keeps_source_order_regardless_of_completion_order() {
        // Sumber menggantung selesai PALING AKHIR, tapi output tetap urutan input.
        let out = probe_sources_with_timeout(
            &[
                Arc::new(Stub::hanging("kiryuu")) as Arc<dyn Source>,
                Arc::new(Stub::alive("komiku")) as Arc<dyn Source>,
            ],
            Duration::from_millis(250),
        )
        .await;
        assert_eq!(out[0].source.as_str(), "kiryuu");
        assert_eq!(out[1].source.as_str(), "komiku");
    }

    /// Semua sumber hidup: output utuh dan urut (bukan potong JoinSet).
    #[tokio::test]
    async fn probe_all_alive_reports_every_source_in_order() {
        let out = probe_sources_with_timeout(
            &[
                Arc::new(Stub::alive("komiku")) as Arc<dyn Source>,
                Arc::new(Stub::alive("mangaku")) as Arc<dyn Source>,
                Arc::new(Stub::alive("shinigami")) as Arc<dyn Source>,
                Arc::new(Stub::alive("kiryuu")) as Arc<dyn Source>,
            ],
            Duration::from_secs(2),
        )
        .await;
        assert_eq!(
            out.iter().map(|h| h.source.as_str()).collect::<Vec<_>>(),
            vec!["komiku", "mangaku", "shinigami", "kiryuu"]
        );
        assert!(out.iter().all(|h| h.health == Health::Alive));
    }

    #[tokio::test]
    async fn probe_empty_source_list_is_empty() {
        assert!(probe_sources_with_timeout(&[], Duration::from_secs(1))
            .await
            .is_empty());
    }
}
