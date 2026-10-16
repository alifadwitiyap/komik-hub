//! Smoke LIVE adapter Shinigami (api.shngm.io/v1).
//!
//! Jalankan:  cargo run --example shinigami_smoke
//! (dari D:\project\komik; sementara task scheduler:
//!  scripts\scheduled_build.bat shinigami run --example shinigami_smoke)
//!
//! Alur: popular(1) -> search("one piece",1) -> series(uuid hasil search) ->
//! chapter_pages(chapter terbaru). Semua output NYATA dari API. Bukan unit test
//! (butuh jaringan); hentikan non-zero kalau salah satu langkah kosong.
use komik_core::adapters::shinigami::ShinigamiSource;
use komik_core::source::Source;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let client = reqwest::Client::new();
    let src = ShinigamiSource::new(client);
    println!("== shinigami smoke: {} ==\n", src.id());

    // --- 1. popular(1) ---
    let pop = src.popular(1).await?;
    println!("[popular] page 1 -> {} manga", pop.len());
    for m in pop.iter().take(5) {
        println!(
            "  {}  {}  [{} | {} | rating {} | Ch {}]",
            m.handle(),
            m.title,
            m.manga_type.as_deref().unwrap_or("-"),
            m.status.as_deref().unwrap_or("-"),
            m.rating.as_deref().unwrap_or("-"),
            m.last_chapter.as_deref().unwrap_or("-"),
        );
    }
    println!();
    if pop.is_empty() {
        anyhow::bail!("populer kosong");
    }

    // --- 2. search("one piece", 1) ---
    let hits = src.search("one piece", 1).await?;
    println!("[search] 'one piece' page 1 -> {} manga", hits.len());
    for m in hits.iter().take(5) {
        println!("  {}  {}  [Ch {}]", m.handle(), m.title, m.last_chapter.as_deref().unwrap_or("-"));
    }
    println!();
    let picked = hits
        .iter()
        .find(|m| m.title.to_lowercase().contains("one piece"))
        .or_else(|| hits.first())
        .ok_or_else(|| anyhow::anyhow!("search 'one piece' kosong"))?;

    // --- 3. series(uuid dari search) ---
    let detail = src.series(&picked.native_id).await?;
    let mg = &detail.manga;
    println!("[series] {} ({})", mg.title, mg.handle());
    println!(
        "  author={} type={} status={} rating={} cover={} updated_at={:?}",
        mg.author.as_deref().unwrap_or("-"),
        mg.manga_type.as_deref().unwrap_or("-"),
        mg.status.as_deref().unwrap_or("-"),
        mg.rating.as_deref().unwrap_or("-"),
        mg.cover_url.as_deref().unwrap_or("-"),
        mg.updated_at,
    );
    println!("  chapter: {} (terbaru dulu)", detail.chapters.len());
    for c in detail.chapters.iter().take(3) {
        println!("    {}  {}  updated_at={:?}", c.native_id, c.title, c.updated_at);
    }
    println!();
    if detail.chapters.is_empty() {
        anyhow::bail!("series {} tidak punya chapter", mg.handle());
    }

    // --- 4. chapter_pages(chapter terbaru) ---
    let newest = &detail.chapters[0];
    let pages = src.chapter_pages(mg, newest).await?;
    println!(
        "[chapter_pages] {} -> {} gambar (title: {}, number {})",
        newest.native_id,
        pages.images.len(),
        pages.title,
        pages.number
    );
    for u in pages.images.iter().take(3) {
        println!("  {u}");
    }
    println!();

    // --- 5. genre filter (verifikasi live filter benar-benar berlaku) ---
    let list = src.list(Some("Romance"), 1).await?;
    println!("[list genre=Romance] -> {} manga", list.len());
    for m in list.iter().take(3) {
        println!("  {}  {}", m.handle(), m.title);
    }
    // genre berspasi -> di-slugify (nama mentah -> HTTP 404 di server)
    let list2 = src.list(Some("Slice of Life"), 1).await?;
    println!("[list genre='Slice of Life'] -> {} manga", list2.len());
    for m in list2.iter().take(3) {
        println!("  {}  {}", m.handle(), m.title);
    }
    let genres = src.genres().await?;
    println!("[genres] -> {} entri (5 pertama):", genres.len());
    for (slug, name) in genres.iter().take(5) {
        println!("  {name}  ({slug})");
    }

    println!("\n== SMOKE OK ==");
    Ok(())
}
