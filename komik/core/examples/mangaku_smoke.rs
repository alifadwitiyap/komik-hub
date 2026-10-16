//! Smoke live adapter Mangaku (mangaku.lol). Butuh jaringan.
//!   cargo run -p komik-core --example mangaku_smoke
//! Semua output di bawah adalah data live yang benar-benar ter-parse dari
//! atribut `data-page` (Laravel/Inertia), bukan fixture.
use komik_core::adapters::mangaku::MangakuSource;
use komik_core::source::Source;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let src = MangakuSource::new(reqwest::Client::new());

    let pop = src.popular(1).await?;
    println!("popular(1): {} item", pop.len());
    for m in pop.iter().take(3) {
        println!(
            "  {} | {} | Ch {:?} | {} | {}",
            m.native_id, m.title, m.last_chapter, m.manga_type.as_deref().unwrap_or("?"),
            m.status.as_deref().unwrap_or("?")
        );
    }
    assert!(!pop.is_empty(), "popular kosong");
    assert!(pop.iter().all(|m| !m.native_id.is_empty()), "native_id (slug) kosong");

    let lat = src.latest(1).await?;
    println!("latest(1): {} item, pertama {}", lat.len(), lat[0].title);

    let hits = src.search("batsu", 1).await?;
    println!("search(\"batsu\",1): {} hit", hits.len());
    for m in hits.iter().take(3) {
        println!("  {} | {}", m.native_id, m.title);
    }
    assert!(!hits.is_empty(), "search batsu kosong");
    assert!(
        hits.iter().any(|m| m.native_id == "batsu-harembatsu-harem"),
        "batsu-harembatsu-harem tidak ada di hasil search"
    );

    let gs = src.genres().await?;
    println!("genres(): {} genre, 3 pertama {:?}", gs.len(), &gs[..3.min(gs.len())]);
    assert!(gs.len() >= 50, "genre terlalu sedikit: {}", gs.len());
    assert!(gs.iter().any(|(s, _)| s == "action"), "slug genre 'action' tidak ada");

    // list dengan filter genre + status (kombinasi)
    let action = src.list_filtered(Some("action"), Some("Ongoing"), None, None, 1).await?;
    println!("list(genre=action, status=Ongoing, 1): {} item", action.len());
    assert!(!action.is_empty(), "list genre=action kosong");
    let action_any = src.list(None, 1).await?;
    println!("list(tanpa filter, 1): {} item", action_any.len());

    // series: chapters inline (208 live saat ini)
    let slug = "batsu-harembatsu-harem";
    let detail = src.series(slug).await?;
    println!(
        "series({slug}): {} | {} chapter | last_ch {:?} | rating {:?}",
        detail.manga.title,
        detail.chapters.len(),
        detail.manga.last_chapter,
        detail.manga.rating
    );
    for c in detail.chapters.iter().take(3) {
        println!("  ch {} ({})", c.number, c.native_id);
    }
    assert_eq!(detail.chapters.len(), 208, "jumlah chapter Batsu Harem bukan 208");
    assert_eq!(detail.chapters[0].number, "210", "chapter terbaru bukan 210");
    assert_eq!(
        detail.chapters.last().map(|c| c.number.as_str()),
        Some("1.1"),
        "chapter terlama bukan 1.1 (desimal)"
    );

    // series slug tidak cocok -> error, bukan data manga lain
    match src.series("slug-yang-tidak-ada-bosku").await {
        Err(e) => println!("series(slug ngawur): error -> {e}"),
        Ok(_) => panic!("series dengan slug ngawur seharusnya gagal"),
    }

    // chapter pages: 210 (bilangan bulat) dan 1.1 (desimal)
    let ch = detail
        .chapters
        .iter()
        .find(|c| c.number == "210")
        .expect("chapter 210 tidak ada di daftar");
    let pages = src.chapter_pages(&detail.manga, ch).await?;
    println!("chapter_pages({slug}, 210): {} gambar", pages.images.len());
    println!("  pertama: {}", pages.images[0]);
    assert!(pages.images.len() >= 5, "gambar terlalu sedikit: {}", pages.images.len());
    assert!(
        pages.images.iter().all(|u| u.starts_with("http")),
        "ada URL gambar non-http: {:?}", pages.images
    );

    let ch11 = detail
        .chapters
        .iter()
        .find(|c| c.number == "1.1")
        .expect("chapter 1.1 tidak ada di daftar");
    let pages11 = src.chapter_pages(&detail.manga, ch11).await?;
    println!("chapter_pages({slug}, 1.1): {} gambar", pages11.images.len());
    assert!(!pages11.images.is_empty(), "chapter 1.1 tanpa gambar");

    // chapter yang tidak ada -> error, bukan kosong diam-diam
    let bogus = komik_core::model::Chapter {
        source: src.id(),
        native_id: "999999".to_string(),
        title: "ngawur".to_string(),
        number: "999999".to_string(),
        updated_at: None,
        url: None,
    };
    match src.chapter_pages(&detail.manga, &bogus).await {
        Err(e) => println!("chapter_pages(slug, 999999): error -> {e}"),
        Ok(_) => panic!("chapter ngawur seharusnya gagal"),
    }

    println!("SMOKE OK");
    Ok(())
}
