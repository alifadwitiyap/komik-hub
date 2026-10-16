//! komik — CLI unified multi-sumber.
//!
//! Bentuk subcommand (clap) sama dengan skeleton; lane ini hanya menambah
//! flag global `--source` / `--no-cache` dan mengisi handler.
//!
//! Format baris mengikuti CLI Python lama:
//! `sumber:native_id  Judul  [Ch N | Tipe | Status | *rating]`
//!
//! Keputusan desain `list`: kalau ada `query` TANPA `--genre`, pakai
//! `search` (sumber punya index judul); kalau ada `--genre`, pakai
//! `Source::list(genre)` paralel + filter status/judul client-side (Manga
//! tidak membawa daftar genre, jadi filter genre tak mungkin client-side).
mod pdf;

use clap::{Parser, Subcommand};
use komik_core::adapters::all_sources;
use komik_core::aggregator::{http_client, Aggregator, HttpClient, Merged};
use komik_core::cache::{Cache, DEFAULT_TTL};
use komik_core::model::{title_key, Manga, SOURCE_PRIORITY};
use komik_core::source::Source;
use std::path::{Path, PathBuf};
use std::sync::Arc;

#[derive(Parser)]
#[command(name = "komik", about = "Baca komik multi-sumber via CLI")]
struct Cli {
    #[command(subcommand)]
    cmd: Cmd,
    /// Batasi ke satu sumber (komiku|mangaku|shinigami|kiryuu)
    #[arg(long, global = true)]
    source: Option<String>,
    /// Nonaktifkan disk cache (default: TTL 10 menit)
    #[arg(long, global = true)]
    no_cache: bool,
}

#[derive(Subcommand)]
enum Cmd {
    /// ranking populer
    Popular {
        #[arg(short = 'n', long, default_value_t = 24)]
        limit: u32,
        #[arg(short, long, default_value_t = 1)]
        page: u32,
    },
    /// update terbaru
    Latest {
        #[arg(short = 'n', long, default_value_t = 24)]
        limit: u32,
        #[arg(short, long, default_value_t = 1)]
        page: u32,
    },
    /// cari judul
    Search {
        query: String,
        #[arg(short, long, default_value_t = 1)]
        page: u32,
        #[arg(short = 'n', long, default_value_t = 24)]
        limit: u32,
    },
    /// daftar genre
    Genres,
    /// katalog + filter
    List {
        query: Option<String>,
        #[arg(short, long)]
        genre: Option<String>,
        #[arg(short, long)]
        status: Option<String>,
        #[arg(long)]
        sort: Option<String>,
        #[arg(short, long, default_value_t = 1)]
        page: u32,
        #[arg(short = 'n', long, default_value_t = 24)]
        limit: u32,
    },
    /// detail + chapter
    Series {
        id: String,
        #[arg(short = 'n', long, default_value_t = 30)]
        limit: u32,
        /// Coba sumber ini lebih dulu (sticky source); default: sumber
        /// terakhir yang dibaca dari disk cache (TTL 10 menit).
        #[arg(long)]
        last_source: Option<String>,
    },
    /// gambar chapter
    Read {
        id: String,
        chapter: String,
        #[arg(short, long)]
        out: Option<String>,
        #[arg(long)]
        pdf: bool,
    },
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let cli = Cli::parse();

    if let Some(s) = &cli.source {
        if !SOURCE_PRIORITY.contains(&s.as_str()) {
            anyhow::bail!(
                "sumber '{s}' tidak dikenal; pilih salah satu: {}",
                SOURCE_PRIORITY.join(", ")
            );
        }
    }

    let client: HttpClient = http_client();
    let sources: Vec<Arc<dyn Source>> = all_sources(client.clone());
    let mut agg = Aggregator::with_cache(
        sources,
        if cli.no_cache {
            Cache::memory(DEFAULT_TTL)
        } else {
            Cache::default_disk(DEFAULT_TTL)
        },
    );
    if cli.no_cache {
        agg = agg.without_cache();
    }
    let src = cli.source.as_deref();

    match cli.cmd {
        Cmd::Popular { limit, page } => {
            print_list(&agg.popular(page, limit, src).await, limit);
        }
        Cmd::Latest { limit, page } => {
            print_list(&agg.latest(page, limit, src).await, limit);
        }
        Cmd::Search { query, page, limit } => {
            print_list(&agg.search(&query, page, limit, src).await, limit);
        }
        Cmd::Genres => {
            let merged = agg.genres(src).await;
            if merged.items.is_empty() {
                eprintln!("(tidak ada genre)");
            }
            for row in &merged.items {
                println!(
                    "{:<20} {:<24} [{}]",
                    row.slug,
                    if row.name.is_empty() { &row.slug } else { &row.name },
                    row.sources.join(", ")
                );
            }
            report_failures(&merged);
        }
        Cmd::List {
            query,
            genre,
            status,
            sort,
            page,
            limit,
        } => {
            // judul saja -> search; ada --genre -> katalog per sumber.
            let mut merged = match (&query, &genre) {
                (Some(q), None) => agg.search(q, page, limit, src).await,
                _ => agg.list(genre.as_deref(), page, limit, src).await,
            };
            if let Some(q) = &query {
                let key = title_key(q);
                merged.items.retain(|m| m.title_key.contains(&key));
            }
            if let Some(st) = &status {
                merged.items.retain(|m| {
                    m.status.as_deref().map(|s| s.eq_ignore_ascii_case(st)) == Some(true)
                });
            }
            sort_items(&mut merged.items, sort.as_deref())?;
            merged.items.truncate(limit as usize);
            print_list(&merged, limit);
        }
        Cmd::Series {
            id,
            limit,
            last_source,
        } => {
            // Sticky source: flag eksplisit > disk cache (sumber terakhir
            // dibaca, TTL 10 menit). Sumber tak dikenal diabaikan.
            let last = match last_source {
                Some(s) if SOURCE_PRIORITY.contains(&s.as_str()) => Some(s),
                Some(s) => anyhow::bail!(
                    "sumber '{s}' tidak dikenal; pilih salah satu: {}",
                    SOURCE_PRIORITY.join(", ")
                ),
                None => agg
                    .cache()
                    .and_then(|c| c.fresh_json::<String>(&last_source_key(&id)))
                    .filter(|s| SOURCE_PRIORITY.contains(&s.as_str())),
            };
            let out = agg
                .series_resolve_pref(&id, limit, src, last.as_deref())
                .await?;
            let d = &out.detail;
            print_manga(&d.manga);
            if let Some(a) = d.manga.author.as_deref().filter(|s| !s.is_empty()) {
                println!("  Penulis: {a}");
            }
            if let Some(u) = d.manga.url.as_deref().filter(|s| !s.is_empty()) {
                println!("  URL: {u}");
            }
            if let Some(l) = &last {
                let served = d.manga.source.as_str();
                if l != served {
                    eprintln!(
                        "(menampilkan chapter dari {served} — sumber terakhir kamu baca)"
                    );
                }
            }
            if d.chapters.is_empty() {
                println!("  (tidak ada chapter)");
            } else {
                // sebagian sumber (kiryuu) balik urutan halaman, bukan numeric-desc;
                // sort di sini biar "terbaru" & saran `baca:` selalu benar
                let mut chs = d.chapters.clone();
                chs.sort_by(|a, b| {
                    let na = a.number.parse::<f64>().unwrap_or(0.0);
                    let nb = b.number.parse::<f64>().unwrap_or(0.0);
                    nb.partial_cmp(&na).unwrap_or(std::cmp::Ordering::Equal)
                });
                println!("  Chapter ({} terbaru):", chs.len());
                for c in chs.iter().take(limit as usize) {
                    println!("    {:<8} {}", c.number, c.title);
                }
                println!("baca: komik read {} {}", d.manga.handle(), chs[0].number);
            }
            if out.from_cache {
                eprintln!("(cache)");
            }
        }
        Cmd::Read { id, chapter, out, pdf } => {
            // Resolver lintas-sumber: komiku primary, pindah otomatis kalau
            // chapter tidak ada / gambarnya kosong; prev/next mengikuti
            // sumber yang benar-benar melayani.
            //
            // Workaround bug Lane-1: penanda negatif atas `id` ("chapter ini
            // absen di primary", TTL 60s) bikin percobaan berikutnya
            // MELEWATI primary sebelum judul aslinya diketahui — sumber lain
            // lalu dicari pakai slug id ("1308") dan selalu miss, sehingga
            // chapter yang ADA dilaporkan "tidak ditemukan". Kalau percobaan
            // pertama gagal, coba lagi dengan JUDUL (resolve lintas sumber
            // selalu berbasis judul). Hanya di jalur gagal, 1 request lagi.
            let read = match agg.read_chapter_any(&id, &chapter, src, 5000).await {
                Ok(r) => r,
                Err(first_err) => {
                    let retried = async {
                        let by_id = agg.series_resolve(&id, 1, src).await.ok()?;
                        let title = by_id.detail.manga.title;
                        if title.is_empty() || title_key(&title) == title_key(&id) {
                            return None;
                        }
                        agg.read_chapter_any(&title, &chapter, src, 5000).await.ok()
                    }
                    .await;
                    match retried {
                        Some(r) => r,
                        None => return Err(first_err),
                    }
                }
            };

            // Sticky source: catat sumber yang benar-benar melayani supaya
            // `komik series` berikutnya membuka dari sumber yang sama.
            if let Some(cache) = agg.cache() {
                let key = last_source_key(&id);
                if let Err(e) = cache.set_json(&key, &read.pages.source.as_str().to_string()) {
                    eprintln!("⚠ cache gagal ditulis ({key}): {e}");
                }
            }

            if let Some(note) = &read.note {
                eprintln!("note: {note}");
            }
            for url in &read.pages.images {
                println!("{url}");
            }

            if let Some(target) = out {
                let dir = pdf_target_dir(&target, pdf)?;
                let base = file_base(&id, &chapter);
                std::fs::create_dir_all(&dir)?;
                if pdf {
                    let path = pdf_path(&target)
                        .unwrap_or_else(|| dir.join(format!("{base}.pdf")));
                    let mut pages = Vec::with_capacity(read.pages.images.len());
                    for (i, url) in read.pages.images.iter().enumerate() {
                        eprint!("  [{}/{}] {url}", i + 1, read.pages.images.len());
                        let bytes = fetch_image(&client, url)
                            .await
                            .map_err(|e| anyhow::anyhow!("halaman {}: {e}", i + 1))?;
                        eprintln!(" ✓");
                        pages.push(pdf::Page { url: url.clone(), bytes });
                    }
                    let report = pdf::write_pdf(&pages, &path)?;
                    eprintln!(
                        "✓ PDF {} ({} halaman, {} lossless, {} re-encode, {} byte)",
                        path.display(),
                        report.pages,
                        report.passthrough,
                        report.reencoded,
                        report.bytes
                    );
                } else {
                    for (i, url) in read.pages.images.iter().enumerate() {
                        let bytes = fetch_image(&client, url).await?;
                        let ext = pdf::sniff_format(&bytes)
                            .map(|f| f.label().to_lowercase())
                            .unwrap_or_else(|| "jpg".into());
                        let name = format!("{base}-{:03}.{ext}", i + 1);
                        std::fs::write(dir.join(&name), &bytes)?;
                        eprintln!("✓ {name}");
                    }
                }
            }

            // Navigasi: sumber & handle dari sumber PELAYAN, jadi "lanjut
            // baca" lintas sumber tetap jalan (keputusan 4 & 7).
            if let Some(n) = &read.next {
                eprintln!("next: komik read {} {}", n.handle, n.number);
            }
            if let Some(p) = &read.prev {
                eprintln!("prev: komik read {} {}", p.handle, p.number);
            }
        }
    }
    Ok(())
}

// ------------------------------------------------------------------ output

fn print_list(merged: &Merged<Manga>, limit: u32) {
    if merged.all_failed() {
        report_failures(merged);
        eprintln!("semua sumber gagal — tidak ada hasil");
        std::process::exit(1);
    }
    if merged.items.is_empty() {
        eprintln!("(tidak ada hasil)");
    } else {
        for m in &merged.items {
            print_manga(m);
        }
        if merged.items.len() < limit as usize {
            eprintln!("({} hasil)", merged.items.len());
        }
    }
    report_failures(merged);
}

fn report_failures<T>(merged: &Merged<T>) {
    if let Some(w) = merged.warning() {
        eprintln!("{w}");
    }
    if merged.from_cache {
        eprintln!("(cache)");
    }
}

/// `sumber:native_id  Judul  [Ch N | Tipe | Status | *rating]`
fn print_manga(m: &Manga) {
    let mut meta: Vec<String> = Vec::new();
    if let Some(c) = m.last_chapter.as_deref().filter(|s| !s.is_empty()) {
        meta.push(format!("Ch {c}"));
    }
    if let Some(t) = m.manga_type.as_deref().filter(|s| !s.is_empty()) {
        meta.push(t.to_string());
    }
    if let Some(s) = m.status.as_deref().filter(|s| !s.is_empty()) {
        meta.push(s.to_string());
    }
    if let Some(r) = m.rating.as_deref().filter(|s| !s.is_empty()) {
        meta.push(format!("*{r}"));
    }
    let tail = if meta.is_empty() {
        String::new()
    } else {
        format!("  [{}]", meta.join(" | "))
    };
    println!("{}  {}{}", m.handle(), m.title, tail);
}

fn sort_items(items: &mut [Manga], sort: Option<&str>) -> anyhow::Result<()> {
    match sort.map(|s| s.to_ascii_lowercase()).as_deref() {
        None | Some("updated") => Ok(()), // sudah recency desc dari aggregator
        Some("title") => {
            items.sort_by(|a, b| a.title.to_lowercase().cmp(&b.title.to_lowercase()));
            Ok(())
        }
        Some(s) => anyhow::bail!("sort '{s}' tidak dikenal; pakai updated|title"),
    }
}

// ----------------------------------------------------------------- download

/// `-o <dir>` normal; `-o x.pdf --pdf` = x.pdf adalah file PDF hasil.
fn pdf_target_dir(target: &str, pdf: bool) -> anyhow::Result<PathBuf> {
    if pdf && target.to_lowercase().ends_with(".pdf") {
        let p = PathBuf::from(target);
        Ok(p.parent()
            .filter(|d| !d.as_os_str().is_empty())
            .map(Path::to_path_buf)
            .unwrap_or_else(|| PathBuf::from(".")))
    } else {
        Ok(PathBuf::from(target))
    }
}

fn pdf_path(target: &str) -> Option<PathBuf> {
    target.to_lowercase().ends_with(".pdf").then(|| PathBuf::from(target))
}

fn file_base(label: &str, chapter: &str) -> String {
    let safe = |s: &str| -> String {
        s.chars()
            .map(|c| {
                if c.is_ascii_alphanumeric() || c == '-' || c == '_' {
                    c
                } else {
                    '-'
                }
            })
            .collect()
    };
    // ponytail: nama file dari argumen id APA ADANYA (handle atau judul)
    // supaya resolver cross-source tak perlu lempar Manga ke sini. Nama
    // lama "sumber-native_id-chN" tetap didapat untuk id berbentuk handle.
    format!("{}-ch{}", safe(label), safe(chapter))
}

/// Kunci disk cache sumber-terakhir-dibaca, per judul/handle. `title_key`
/// menormalkan huruf besar kecil + tanda baca supaya "Solo Leveling" dan
/// "solo leveling" memakai entri yang sama.
fn last_source_key(id: &str) -> String {
    format!("last-source:{}", title_key(id))
}

/// Ambil satu gambar dengan 1x retry; tolak body non-gambar (HTML 200 senyap).
async fn fetch_image(client: &HttpClient, url: &str) -> anyhow::Result<Vec<u8>> {
    let mut attempt = 0u8;
    loop {
        attempt += 1;
        match try_fetch(client, url).await {
            Ok(bytes) => return Ok(bytes),
            Err(e) if attempt < 2 => eprintln!("⚠ {url}: {e} — retry 1x"),
            Err(e) => return Err(anyhow::anyhow!("gagal unduh {url}: {e}")),
        }
    }
}

async fn try_fetch(client: &HttpClient, url: &str) -> anyhow::Result<Vec<u8>> {
    let resp = tokio::time::timeout(std::time::Duration::from_secs(30), client.get(url).send())
        .await
        .map_err(|_| anyhow::anyhow!("timeout 30s"))??;
    if !resp.status().is_success() {
        anyhow::bail!("HTTP {}", resp.status());
    }
    let bytes = resp.bytes().await?.to_vec();
    match pdf::sniff_format(&bytes) {
        Some(_) => Ok(bytes),
        None => anyhow::bail!(pdf::reject_reason(&bytes)),
    }
}
