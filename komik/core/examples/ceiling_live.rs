//! Validasi LIVE feed "Update terbaru" lintas sumber: bandingkan dedup lama
//! (recency) vs baru (ceiling) pakai data NYATA dari 4 sumber.
//!
//! Jalankan:  cargo run --example ceiling_live
//! (butuh jaringan; keluar non-zero kalau semua sumber gagal)
use komik_core::adapters::all_sources;
use komik_core::aggregator::{dedup_rank, dedup_rank_ceiling};
use komik_core::model::Manga;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let client = reqwest::Client::builder()
        .user_agent("komik-hub/ceiling-live")
        .build()?;
    let sources = all_sources(client);

    // Ambil latest(1) dari tiap sumber.
    let mut all: Vec<Manga> = Vec::new();
    let mut per_source: Vec<(String, Vec<Manga>)> = Vec::new();
    for src in &sources {
        match src.latest(1).await {
            Ok(list) => {
                println!(
                    "[{}] latest(1) = {} manga (e.g. {}... ch {})",
                    src.id(),
                    list.len(),
                    list.first().map(|m| m.title.as_str()).unwrap_or("-"),
                    list.first()
                        .and_then(|m| m.last_chapter.as_deref())
                        .unwrap_or("-"),
                );
                per_source.push((src.id().to_string(), list.clone()));
                all.extend(list);
            }
            Err(e) => println!("[{}] GAGAL: {e}", src.id()),
        }
    }
    println!();

    if all.is_empty() {
        anyhow::bail!("semua sumber gagal diambil");
    }

    let old = dedup_rank(all.clone());
    let new = dedup_rank_ceiling(all.clone());
    println!(
        "TOTAL raw={}  | dedup lama(recency)={}  | dedup baru(ceiling)={}  | ditekan ceiling={}",
        all.len(),
        old.len(),
        new.len(),
        old.len().saturating_sub(new.len()),
    );
    println!();

    // Grup judul yang muncul di >1 sumber -> tampilkan last_chapter tiap sumber.
    let mut by_key: std::collections::HashMap<String, Vec<&Manga>> = Default::default();
    for m in &all {
        by_key.entry(m.title_key.clone()).or_default().push(m);
    }

    let mut dup: Vec<_> = by_key.into_iter().filter(|(_, v)| v.len() > 1).collect();
    dup.sort_by(|a, b| a.0.cmp(&b.0));

    println!("== Judul yang muncul di >1 sumber ({} judul) ==", dup.len());
    for (key, ms) in dup {
        let old_win = old.iter().find(|o| o.title_key == key);
        let new_win = new.iter().find(|o| o.title_key == key);
        for m in &ms {
            println!(
                "  {:<10} ch={:<6} | title={}",
                m.source.as_str(),
                m.last_chapter.as_deref().unwrap_or("-"),
                m.title,
            );
        }
        println!(
            "   -> pemenang LAMA={} | pemenang BARU={}",
            old_win.map(|w| w.source.as_str()).unwrap_or("-"),
            new_win.map(|w| w.source.as_str()).unwrap_or("-"),
        );
        println!();
    }
    Ok(())
}
