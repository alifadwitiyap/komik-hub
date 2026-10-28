//! Uji failover dua fase dengan remember_title.
//!
//! Fase 1: resolve dengan SEMUA 4 sumber -> mengisi remember_title(handle->judul).
//! Fase 2: resolve TANPA komiku (simulasi komiku mati) -> harus failover
//!          ke sumber lain memakai judul yang diingat.

use komik_core::adapters::{kiryuu::KiryuuSource, mangaku::MangakuSource, shinigami::ShinigamiSource};
use komik_core::adapters::komiku::KomikuSource;
use komik_core::aggregator::Aggregator;
use komik_core::cache::Cache;
use komik_core::source::Source;
use std::sync::Arc;

fn make_agg(sources: Vec<Arc<dyn Source>>) -> Aggregator {
    // Disk cache BERSAMA: kedua fase baca/tulis cache yang sama, jadi
    // remember_title fase 1 terbaca fase 2 (persist juga lintas restart).
    Aggregator::with_cache(sources, Cache::default_disk(komik_core::cache::DEFAULT_TTL))
}

const UA_MOBILE: &str = "Mozilla/5.0 (Linux; Android 13; SM-S908B) AppleWebKit/537.36 \
                         (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36";

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let handle = "komiku:1160"; // My Exclusive Tower Guide (komiku 141, shinigami 142)
    let client = reqwest::Client::builder().user_agent(UA_MOBILE).build()?;

    println!("=== FASE 1: resolve dengan 4 sumber (ingat judul) ===");
    {
        let sources: Vec<Arc<dyn Source>> = vec![
            Arc::new(KomikuSource::new(client.clone())),
            Arc::new(MangakuSource::new(client.clone())),
            Arc::new(ShinigamiSource::new(client.clone())),
            Arc::new(KiryuuSource::new(client.clone())),
        ];
        let agg = make_agg(sources);
        match agg.series_merged(handle, 2000, None, None).await {
            Ok(m) => println!("  OK: title={} chapters={} rep={:?}", m.manga.title, m.chapters.len(),
                              m.representative_source.map(|s| s.as_str().to_string())),
            Err(e) => println!("  GAGAL: {e:#}"),
        }
    }

    println!("\n=== FASE 2: komiku MATI (tanpa KomikuSource) -> failover? ===");
    {
        let sources: Vec<Arc<dyn Source>> = vec![
            Arc::new(MangakuSource::new(client.clone())),
            Arc::new(ShinigamiSource::new(client.clone())),
            Arc::new(KiryuuSource::new(client)),
        ];
        let agg = make_agg(sources);
        println!("  sumber: mangaku, shinigami, kiryuu (komiku mati)");
        match agg.series_merged(handle, 2000, None, None).await {
            Ok(m) => println!("  OK: title={} chapters={} rep={:?}", m.manga.title, m.chapters.len(),
                              m.representative_source.map(|s| s.as_str().to_string())),
            Err(e) => println!("  GAGAL: {e:#}"),
        }

        match agg.read_chapter_any(handle, "141", None, 2000).await {
            Ok(o) => println!("  chapter 141 dilayani: {} images={} switched={:?}", o.pages.source.as_str(),
                              o.pages.images.len(), o.switched_from.map(|s| s.as_str().to_string())),
            Err(e) => println!("  chapter 141 GAGAL: {e:#}"),
        }
    }

    Ok(())
}
