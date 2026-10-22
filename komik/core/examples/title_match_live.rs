//! Validasi LIVE title-matching kanonik: dua judul seri sama beda tata kata
//! (komiku vs shinigami) di-fetch beneran lalu di-merge lewat
//! dedup_rank_ceiling. Cetak jumlah hasil + pemenang.
//! Jalankan: cargo run --example title_match_live
use komik_core::adapters::all_sources;
use komik_core::aggregator::dedup_rank_ceiling;
use komik_core::model::Manga;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let client = reqwest::Client::builder().user_agent("komik-hub/title-match").build()?;
    let sources = all_sources(client);

    // Cari di tiap sumber, ambil yang judulnya mengandung "disaster class".
    let mut found: Vec<Manga> = Vec::new();
    for src in &sources {
        match src.search("disaster class hero", 1).await {
            Ok(hits) => {
                for m in hits {
                    if m.title.to_lowercase().contains("disaster") && m.title.to_lowercase().contains("class") {
                        found.push(m);
                    }
                }
            }
            Err(e) => println!("[{}] search GAGAL: {e}", src.id()),
        }
    }

    println!("entri disaster-class ditemukan: {}", found.len());
    for m in &found {
        println!(
            "   {} | title={} | last_ch={}",
            m.source.as_str(),
            m.title,
            m.last_chapter.as_deref().unwrap_or("-"),
        );
    }

    if found.len() < 2 {
        anyhow::bail!("butuh >=2 sumber untuk menguji merge");
    }

    let out = dedup_rank_ceiling(found);
    println!("\nSETELAH ceiling-merge: {} kartu", out.len());
    for m in &out {
        println!(
            "   pemenang: {} | title={} | last_ch={}",
            m.source.as_str(),
            m.title,
            m.last_chapter.as_deref().unwrap_or("-"),
        );
    }
    Ok(())
}
