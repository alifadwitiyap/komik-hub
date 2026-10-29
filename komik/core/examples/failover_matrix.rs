//! Simulasi KEMATIAN SUMBER: buktikan sumber lain take over.
//!
//! Cara "mematikan" sumber: cukup JANGAN daftarkan adapter-nya ke Aggregator.
//! Ini simulasi yang jujur untuk kasus "sumber down total" (DNS mati, host
//! hilang) — jalur kode yang dieksekusi sama dengan produksi: fallback_order()
//! melewati sumber yang tidak ada, dan resolve-by-title mencari sumber lain.
//!
//! Skenario (dari ringan ke ekstrem):
//!   0. Baseline: 4 sumber hidup
//!   1. komiku mati
//!   2. shinigami mati (sumber yang paling banyak datanya)
//!   3. mangaku + kiryuu mati
//!   4. HANYA shinigami hidup (3 mati)
//!   5. HANYA kiryuu hidup (3 mati)
//!   6. HANYA mangaku hidup (3 mati)
//!   7. SEMUA mati (harus gagal dengan pesan jelas, bukan hang/panic)
//!
//! Yang dinilai tiap skenario:
//!   - series_merged: dapat judul + jumlah chapter, sumber representative
//!   - read_chapter_any: chapter benar-benar dilayani + jumlah gambar
//!   - waktu (detik) supaya kelihatan apakah failover membuat request menggantung

use komik_core::adapters::{
    kiryuu::KiryuuSource, komiku::KomikuSource, mangaku::MangakuSource, shinigami::ShinigamiSource,
};
use komik_core::aggregator::Aggregator;
use komik_core::cache::Cache;
use komik_core::source::Source;
use std::sync::Arc;
use std::time::Instant;

const UA_MOBILE: &str = "Mozilla/5.0 (Linux; Android 13; SM-S908B) AppleWebKit/537.36 \
                         (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36";

/// Handle & chapter uji. Dipilih yang punya padanan di beberapa sumber,
/// supaya failover punya sesuatu untuk diambil alih.
const HANDLE: &str = "komiku:1160"; // My Exclusive Tower Guide
const CHAPTER: &str = "141";

type Src = Arc<dyn Source>;

fn build(names: &[&str], client: &reqwest::Client) -> Vec<Src> {
    let mut out: Vec<Src> = Vec::new();
    for n in names {
        match *n {
            "komiku" => out.push(Arc::new(KomikuSource::new(client.clone())) as Src),
            "mangaku" => out.push(Arc::new(MangakuSource::new(client.clone())) as Src),
            "shinigami" => out.push(Arc::new(ShinigamiSource::new(client.clone())) as Src),
            "kiryuu" => out.push(Arc::new(KiryuuSource::new(client.clone())) as Src),
            other => panic!("sumber tak dikenal: {other}"),
        }
    }
    out
}

async fn jalankan(label: &str, hidup: &[&str], mati: &[&str], client: &reqwest::Client) {
    println!("\n=== {label} ===");
    println!("  hidup: {:?}", hidup);
    println!("  MATI : {:?}", mati);

    // Cache MEMORY-ONLY dan baru tiap fase: kalau memakai disk cache, fase
    // "SEMUA MATI" tetap menjawab OK dari cache dan hasilnya menyesatkan.
    let agg = Aggregator::with_cache(
        build(hidup, client),
        Cache::memory(komik_core::cache::DEFAULT_TTL),
    );

    // --- series ---
    let t0 = Instant::now();
    match agg.series_merged(HANDLE, 2000, None, None).await {
        Ok(m) => println!(
            "  series  : OK {:.1}s title={:?} chapters={} rep={:?} failed={:?}",
            t0.elapsed().as_secs_f64(),
            m.manga.title,
            m.chapters.len(),
            m.representative_source.map(|s| s.as_str().to_string()),
            m.failed
                .iter()
                .map(|(s, _e)| s.as_str().to_string())
                .collect::<Vec<_>>(),
        ),
        Err(e) => println!(
            "  series  : GAGAL {:.1}s err={}",
            t0.elapsed().as_secs_f64(),
            format!("{e:#}").chars().take(160).collect::<String>()
        ),
    }

    // --- chapter (bukti nyata halaman bisa dibaca) ---
    let t1 = Instant::now();
    match agg.read_chapter_any(HANDLE, CHAPTER, None, 2000).await {
        Ok(o) => println!(
            "  chapter : OK {:.1}s dilayani={} images={} switched_from={:?}",
            t1.elapsed().as_secs_f64(),
            o.pages.source.as_str(),
            o.pages.images.len(),
            o.switched_from.map(|s| s.as_str().to_string()),
        ),
        Err(e) => println!(
            "  chapter : GAGAL {:.1}s err={}",
            t1.elapsed().as_secs_f64(),
            format!("{e:#}").chars().take(160).collect::<String>()
        ),
    }
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let client = reqwest::Client::builder()
        .user_agent(UA_MOBILE)
        .timeout(std::time::Duration::from_secs(25))
        .build()?;

    let semua = ["komiku", "mangaku", "shinigami", "kiryuu"];

    // FASE 0: isi cache/ingatan judul dulu dengan SEMUA sumber hidup.
    println!("=== FASE 0: baseline 4 sumber hidup (mengisi ingatan judul; cache DISK sengaja) ===");
    let agg = Aggregator::with_cache(
        build(&semua, &client),
        Cache::default_disk(komik_core::cache::DEFAULT_TTL),
    );
    match agg.series_merged(HANDLE, 2000, None, None).await {
        Ok(m) => println!(
            "  OK title={:?} chapters={} rep={:?}",
            m.manga.title,
            m.chapters.len(),
            m.representative_source.map(|s| s.as_str().to_string())
        ),
        Err(e) => println!("  GAGAL: {e:#}"),
    }
    if let Ok(o) = agg.read_chapter_any(HANDLE, CHAPTER, None, 2000).await {
        println!(
            "  chapter {CHAPTER}: dilayani={} images={}",
            o.pages.source.as_str(),
            o.pages.images.len()
        );
    }

    // FASE 1..7: satu per satu sumber dimatikan.
    jalankan(
        "FASE 1: komiku MATI",
        &["mangaku", "shinigami", "kiryuu"],
        &["komiku"],
        &client,
    )
    .await;
    jalankan(
        "FASE 2: shinigami MATI",
        &["komiku", "mangaku", "kiryuu"],
        &["shinigami"],
        &client,
    )
    .await;
    jalankan(
        "FASE 3: mangaku + kiryuu MATI",
        &["komiku", "shinigami"],
        &["mangaku", "kiryuu"],
        &client,
    )
    .await;
    jalankan(
        "FASE 4: hanya SHINIGAMI hidup",
        &["shinigami"],
        &["komiku", "mangaku", "kiryuu"],
        &client,
    )
    .await;
    jalankan(
        "FASE 5: hanya KIRYUU hidup",
        &["kiryuu"],
        &["komiku", "mangaku", "shinigami"],
        &client,
    )
    .await;
    jalankan(
        "FASE 6: hanya MANGAKU hidup",
        &["mangaku"],
        &["komiku", "shinigami", "kiryuu"],
        &client,
    )
    .await;
    jalankan(
        "FASE 7: hanya KOMIKU hidup",
        &["komiku"],
        &["mangaku", "shinigami", "kiryuu"],
        &client,
    )
    .await;
    jalankan("FASE 8: SEMUA MATI", &[], &semua, &client).await;

    println!("\n=== selesai ===");
    Ok(())
}
