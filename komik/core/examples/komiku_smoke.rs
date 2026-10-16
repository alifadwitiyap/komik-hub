//! Smoke LIVE adapter Komiku (index.komikid.org + content.komikid.org).
//! Jalankan: cargo run -p komik-core --example komiku_smoke
//!
//! Membuktikan end-to-end dengan header x-secure-seeds: genres -> popular
//! (seksi HOT) -> latest -> search -> list(genre) -> series (blob chapter AES
//! didekripsi) -> chapter_pages (blob image AES didekripsi).
use anyhow::Result;
use komik_core::adapters::komiku::KomikuSource;
use komik_core::model::Chapter;
use komik_core::source::Source;

#[tokio::main]
async fn main() -> Result<()> {
    let client = reqwest::Client::new();
    let src = KomikuSource::new(client);

    // 1) genres — grup `categorylist` ber-id "genre".
    let genres = src.genres().await?;
    println!("[1] genres: {} entri (top 5)", genres.len());
    for (slug, name) in genres.iter().take(5) {
        println!("      {:<20} {}", slug, name);
    }

    // 2) popular(1) — seksi HOT (`?other=hot`).
    let pop = src.popular(1).await?;
    println!("[2] popular(1): {} manga", pop.len());
    for m in pop.iter().take(4) {
        println!(
            "      {:<10} | {:<38} | score={:?} | last_ch={:?}",
            m.native_id,
            m.title,
            m.rating,
            m.last_chapter
        );
    }

    // 3) latest(1) — katalog manga/page/1/ (urut update_date desc).
    let lat = src.latest(1).await?;
    println!("[3] latest(1): {} manga", lat.len());
    for m in lat.iter().take(4) {
        println!(
            "      {:<10} | {:<38} | updated_at={:?}",
            m.native_id,
            m.title,
            m.updated_at
        );
    }

    // 4) search("one piece", 1) — key hasil `manga`, bukan `data`.
    let sr = src.search("one piece", 1).await?;
    println!("[4] search(\"one piece\", 1): {} hit", sr.len());
    for m in sr.iter().take(4) {
        println!(
            "      {:<10} | {:<38} | status={:?}",
            m.native_id, m.title, m.status
        );
    }

    // 5) list(genre "action", 1) — slug genre (bukan nama tampilan).
    let lst = src.list(Some("action"), 1).await?;
    println!("[5] list(Some(\"action\"), 1): {} manga", lst.len());
    for m in lst.iter().take(4) {
        println!("      {:<10} | {}", m.native_id, m.title);
    }

    // 6) series("6426") — One Piece; daftar chapter = blob AES.
    let det = src.series("6426").await?;
    println!(
        "[6] series(\"6426\"): \"{}\" — {} chapter (terbaru dulu)",
        det.manga.title,
        det.chapters.len()
    );
    println!(
        "      author={:?} status={:?} type={:?} rating={:?}",
        det.manga.author, det.manga.status, det.manga.manga_type, det.manga.rating
    );
    println!(
        "      cover={}",
        det.manga.cover_url.as_ref().map(|_| "ya").unwrap_or("-")
    );
    for c in det.chapters.iter().take(4) {
        println!(
            "      Ch {:<8} id={:<9} updated_at={:?}",
            c.number, c.native_id, c.updated_at
        );
    }

    // 7) chapter_pages — chapter terbaru (native_id integer), URL gambar = blob AES.
    let first: &Chapter = det
        .chapters
        .first()
        .ok_or_else(|| anyhow::anyhow!("One Piece tanpa chapter"))?;
    let pages = src.chapter_pages(&det.manga, first).await?;
    println!(
        "[7] chapter_pages({}, Ch {}): {} gambar",
        det.manga.native_id,
        pages.number,
        pages.images.len()
    );
    for u in pages.images.iter().take(4) {
        println!("      {}", u);
    }

    assert!(!genres.is_empty(), "genres kosong");
    assert!(!pop.is_empty(), "popular kosong");
    assert!(!lat.is_empty(), "latest kosong");
    assert!(!sr.is_empty(), "search kosong");
    assert!(!lst.is_empty(), "list(genre) kosong");
    assert!(!det.chapters.is_empty(), "chapter list kosong (blob gagal?)");
    assert!(!pages.images.is_empty(), "chapter tanpa gambar (blob gagal?)");

    println!("\nSMOKE OK: seeds+index+content+dekripsi blob chapter & image semua non-empty.");
    Ok(())
}
