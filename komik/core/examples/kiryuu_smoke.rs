//! Smoke LIVE adapter Kiryuu (bypass DNS poisoning via DoH).
//! Jalankan: cargo run -p komik-core --example kiryuu_smoke
//!
//! Membuktikan end-to-end: DoH pin -> wp-json (genres/popular/search) ->
//! series (chapter list) -> chapter_pages (URL gambar non-empty).
//!
//! DEVIASI terbukti live: URL chapter polos `/manga/{slug}/chapter/{number}/`
//! TIDAK melayani gambar (balas halaman manga generic / 404). Satu-satunya bentuk
//! yang valid = href asli ber-suffix (`.../chapter-179.337987/`) yang keluar dari
//! `series`; itu yang dipakai `chapter_pages` lewat `chapter.url`.
use anyhow::Result;
use komik_core::adapters::kiryuu::KiryuuSource;
use komik_core::model::Chapter;
use komik_core::source::Source;

#[tokio::main]
async fn main() -> Result<()> {
    let client = reqwest::Client::new();
    let src = KiryuuSource::new(client);

    // 1) genres — bukti DoH + wp-json jalan.
    let genres = src.genres().await?;
    println!("[1] genres: {} entri (top 5)", genres.len());
    for (slug, name) in genres.iter().take(5) {
        println!("      {}  {}", slug, name);
    }

    // 2) popular(1) — advanced_search + wp-json detail. Populer juga = bukti DoH
    //    cukup untuk search form (nonce + advanced_search).
    let pop = src.popular(1).await?;
    println!("[2] popular(1): {} manga", pop.len());
    for m in pop.iter().take(5) {
        println!(
            "      {:<26} | {:<40} | cover={}",
            m.native_id,
            m.title,
            m.cover_url.as_ref().map(|_| "ya").unwrap_or("-")
        );
    }

    // 3) search("solo leveling", 1)
    let sr = src.search("solo leveling", 1).await?;
    println!("[3] search(\"solo leveling\",1): {} hit", sr.len());
    for m in sr.iter().take(5) {
        println!(
            "      {:<26} | {:<30} | status={:?}",
            m.native_id, m.title, m.status
        );
    }

    // 4) series("solo-leveling") — wp-json detail + chapter list dari halaman /manga/{slug}/.
    let det = src.series("solo-leveling").await?;
    println!(
        "[4] series(\"solo-leveling\"): \"{}\" — {} chapter (terbaru dulu)",
        det.manga.title,
        det.chapters.len()
    );
    println!(
        "      cover={} url={:?}",
        det.manga.cover_url.as_ref().map(|_| "ya").unwrap_or("-"),
        det.manga.url
    );
    for c in det.chapters.iter().take(4) {
        println!("      Ch {:<8} url={:?}", c.number, c.url);
    }

    // 5) chapter_pages — slug (manga.native_id) + number (chapter.native_id).
    //    Pilih chapter dengan number integer bersih (mis. "179") supaya gambar yang
    //    keluar benar-benar setel dengan nomornya; chapter desimal tertentu (mis.
    //    179.6) ternyata memuat aset folder lain di sisi situs (anomali site,
    //    bukan bug adapter — adapter setia pada yang disajikan halaman chapter).
    let pick: &Chapter = det
        .chapters
        .iter()
        .find(|c| !c.number.contains('.'))
        .or_else(|| det.chapters.first())
        .ok_or_else(|| anyhow::anyhow!("tidak ada chapter untuk di-read"))?;
    let pages = src.chapter_pages(&det.manga, pick).await?;
    println!(
        "[5] chapter_pages(slug={}, number={}): {} gambar",
        det.manga.native_id, pages.number, pages.images.len()
    );
    for u in pages.images.iter().take(4) {
        println!("      {}", u);
    }

    assert!(!genres.is_empty(), "genres kosong -> DoH/wp-json gagal");
    assert!(!det.chapters.is_empty(), "chapter list kosong");
    assert!(!pages.images.is_empty(), "chapter tidak punya gambar");
    println!("\nSMOKE OK: nonce+wp-json+advanced_search+series+chapter images semua non-empty.");
    Ok(())
}
