//! Route `/api/unified/*` — pembungkus tipis `komik-core` (4 sumber manga:
//! komiku/mangaku/shinigami/kiryuu) untuk frontend. Route Komiku existing
//! (`/api/*` lain) TIDAK disentuh — file ini hanya menambah.
//!
//! Kontrak JSON (frontend + CLI memakai bentuk yang sama):
//! - GET /api/unified/search?q=&page= -> {items:[MangaOut], failed_sources:[string]}
//! - GET /api/unified/popular?page=   -> sama
//! - GET /api/unified/latest?page=    -> sama
//! - GET /api/unified/genres          -> {items:[{slug,name,sources:[string]}]}
//! - GET /api/unified/series/{handle} -> {manga:MangaOut, chapters:[ChapterRow], source:string, failed_sources:[]}
//!   handle = "sumber:native_id" (URL-encoded oleh klien, mis. "komiku%3A6426")
//! - GET /api/unified/chapter/{handle}/{number}
//!   -> {title, number, source, images:[url], prev:{number,source,handle}|null,
//!       next:{...}|null, switched_from: sumber|null, note: string|null}
//!   (fallback lintas sumber: kalau chapter tidak ada di sumber handle, core
//!   ambil dari sumber lain berjudul sama — cross-source chapter fallback)
//! - GET /api/unified/series/{handle}?last_source=kiryuu (opsional)
//!   -> sumber terakhir dibaca dicoba LEBIH DULU (sticky source)
//! - GET /api/unified/health
//!   -> {total, healthy, checked_at_ms,
//!       sources:[{source,label,ok,latency_ms,error}]}
//!   Liveness PER SUMBER, bukan liveness server: SELALU 200 selama ada
//!   baris (sumber mati = DATA, bukan galat). `label` dipetakan sisi SERVER;
//!   probe jalan lewat `komik_core::probe` (kiryuu = Cloudflare DoH internal).
//!
//! Model core (model.rs) sengaja tanpa Serialize, jadi bentuk keluar dibentuk
//! via DTO di file ini — file core tidak diubah. Aggregator core sudah punya
//! timeout per sumber + cache memory TTL 10 menit; di sini hanya dipakai.

use axum::{
    body::Body,
    extract::{Path, Query},
    http::{header, HeaderMap},
    response::Response,
    routing::{get, post},
    Json, Router,
};
use serde::Deserialize;
use serde_json::{json, Value};

use komik_core::aggregator::Aggregator;
use komik_core::adapters::all_sources;
use komik_core::model::{title_key, Chapter, Manga};
use komik_core::source::{Source, PER_SOURCE_TIMEOUT_SECS};

use crate::downloads::{self, DownloadEntry, DownloadStore};
use crate::pdf;
use crate::routes::{AppError, Res};
use crate::user::{require_user, users_dir};

/// UA Android: adapter komiku/mangaku/shinigami WAJIB UA mobile (kalau tidak,
/// host balas halaman/error tanpa data). Adapter kiryuu membuat client
/// pinned DoH sendiri secara internal, jadi client ini cukup untuk 3 sumber.
const UA_MOBILE: &str = "Mozilla/5.0 (Linux; Android 13; SM-S908B) AppleWebKit/537.36 \
                          (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36";
/// Batas panjang daftar chapter yang di-fetch (dan di-cache core) supaya
/// navigasi prev/next tetap jalan untuk manga panjang (One Piece dst).
const SERIES_CHAPTER_LIMIT: u32 = 2000;

// ------------------------------------------------------------------ agregator

/// Satu instance Aggregator untuk seluruh proses (pola OnceCell seperti
/// `api::CLIENT` — client & cache dipakai bersama semua request).
fn aggregator() -> &'static Aggregator {
    static AGG: std::sync::OnceLock<Aggregator> = std::sync::OnceLock::new();
    AGG.get_or_init(|| {
        let client = reqwest::Client::builder()
            .user_agent(UA_MOBILE)
            .timeout(std::time::Duration::from_secs(2 * PER_SOURCE_TIMEOUT_SECS))
            .build()
            .unwrap_or_default();
        Aggregator::new(all_sources(client))
    })
}

// ------------------------------------------------------------------ DTO

/// Kartu manga lintas sumber. Persis kontrak frontend.
///
/// `title_key` DITAMBAH (kontrak lane rak-buku): judul ternormalisasi supaya
/// web bisa bikin favorit/sejarah lintas sumber tanpa reimplement normalisasi
/// di JS.
#[derive(serde::Serialize)]
pub struct MangaOut {
    pub source: String,
    pub native_id: String,
    pub handle: String,
    pub title: String,
    pub title_key: String,
    pub cover_url: Option<String>,
    pub author: Option<String>,
    pub status: Option<String>,
    pub manga_type: Option<String>,
    pub rating: Option<String>,
    pub last_chapter: Option<String>,
    pub updated_at: Option<i64>,
    pub url: Option<String>,
}

impl From<&Manga> for MangaOut {
    fn from(m: &Manga) -> Self {
        MangaOut {
            source: m.source.as_str().to_string(),
            native_id: m.native_id.clone(),
            handle: m.handle(),
            title: m.title.clone(),
            title_key: m.title_key.clone(),
            cover_url: m.cover_url.clone(),
            author: m.author.clone(),
            status: m.status.clone(),
            manga_type: m.manga_type.clone(),
            rating: m.rating.clone(),
            last_chapter: m.last_chapter.clone(),
            updated_at: m.updated_at,
            url: m.url.clone(),
        }
    }
}

/// Baris daftar chapter di respons series (urut sesuai sumber: terbaru dulu).
#[derive(serde::Serialize)]
pub struct ChapterRow {
    pub number: String,
    pub title: String,
    pub native_id: String,
    pub updated_at: Option<i64>,
}

impl From<&Chapter> for ChapterRow {
    fn from(c: &Chapter) -> Self {
        ChapterRow {
            number: c.number.clone(),
            title: c.title.clone(),
            native_id: c.native_id.clone(),
            updated_at: c.updated_at,
        }
    }
}

/// Respons daftar merged lintas sumber + laporan partial failure.
#[derive(serde::Serialize)]
pub struct ListOut {
    pub items: Vec<MangaOut>,
    pub failed_sources: Vec<String>,
    pub from_cache: bool,
}

impl From<komik_core::aggregator::Merged<Manga>> for ListOut {
    fn from(m: komik_core::aggregator::Merged<Manga>) -> Self {
        ListOut {
            items: m.items.iter().map(MangaOut::from).collect(),
            failed_sources: m.failures.iter().map(|(s, _)| s.as_str().to_string()).collect(),
            from_cache: m.from_cache,
        }
    }
}

// ------------------------------------------------------------------ handler lintas sumber

#[derive(Deserialize)]
pub struct ListQuery {
    page: Option<u32>,
    /// batas jumlah item (default 48; 0 = tanpa batas)
    limit: Option<u32>,
}

/// Query `GET /api/unified/catalogue` — katalog (bukan search) + filter
/// tipe/status/genre. TIDAK ada `q` (catalogue = jelajah, bukan pencarian).
#[derive(Deserialize)]
pub struct CatalogueQuery {
    page: Option<u32>,
    limit: Option<u32>,
    tipe: Option<String>,
    status: Option<String>,
    /// slug/nama genre dari union `/genres`. SUMBER HANYA MENYARING SEBAGIAN:
    /// lihat `genre_coverage` — setiap respons membawa laporan jujur.
    genre: Option<String>,
}

#[derive(Deserialize)]
pub struct SearchQuery {
    q: Option<String>,
    page: Option<u32>,
    /// batas jumlah item (default 48; 0 = tanpa batas)
    limit: Option<u32>,
    /// filter tipe server-side (Manga|Manhwa|Manhua, case-insensitive)
    tipe: Option<String>,
    /// filter status server-side (Ongoing|Completed, case-insensitive)
    status: Option<String>,
    /// filter genre server-side — slug/nama dari union `/genres`. Aktif:
    /// diteruskan ke tiap adapter lewat `search_in_genre`.
    genre: Option<String>,
}

/// Filter tipe/status SERVER-SIDE (setelah merge 4 sumber). Fungsi murni
/// (tanpa I/O) supaya bisa diuji tanpa jaringan.
///
/// - Kedua filter `None` = tidak memfilter (katalog polos).
/// - Item tanpa `manga_type`/`status` (None) GUGUR kalau filter itu aktif —
///   jangan pura-pura cocok; web lane pakai chip sebagai tanda ketersediaan.
/// - Perbandingan case-insensitive di nilai (mis. "MANHWA" == "Manhwa").
fn match_filters(m: &Manga, tipe: Option<&str>, status: Option<&str>) -> bool {
    let eq_ci = |field: &Option<String>, want: Option<&str>| match want {
        Some(w) => field
            .as_deref()
            .is_some_and(|v| v.eq_ignore_ascii_case(w)),
        None => true,
    };
    eq_ci(&m.manga_type, tipe) && eq_ci(&m.status, status)
}

/// Batas fan-out internal: core `search`/`list` SUDAH merge+dedup 4 sumber;
/// di sini kita ambil lebih banyak dari yang ditampilkan supaya filter
/// tipe/status + rank relevansi bisa jalan pada set yang cukup (kalau hanya
/// sebesar `limit`, filter bisa menyisakan sangat sedikit). Murni konstanta
/// internal — `limit` respons tetap menghormati parameter client.
const FILTER_FANOUT_CAP: u32 = 240;

/// Paketkan hasil ke `ListOut` SETELAH rank (kalau ada kueri) + filter
/// tipe/status, lalu potong ke `limit` yang diminta client. `max` = cap
/// hilang: `None` = "semua yang lolos". Jumlah item yang dikembalikan JUJUR
/// terhadap filter (bukan jumlah pra-filter).
fn list_out_filtered(
    merged: komik_core::aggregator::Merged<Manga>,
    query: Option<&str>,
    tipe: Option<&str>,
    status: Option<&str>,
    max: Option<usize>,
) -> ListOut {
    // rank_by_query dengan kueri kosong = no-op (urut recency dari core).
    let items: Vec<Manga> = match query {
        Some(q) => komik_core::aggregator::rank_by_query(merged.items, q),
        None => merged.items,
    }
    .into_iter()
    .filter(|m| match_filters(m, tipe, status))
    .collect();
    let mut out = ListOut::from(komik_core::aggregator::Merged {
        items,
        ..merged
    });
    if let Some(max) = max {
        out.items.truncate(max);
    }
    out
}

async fn u_search(Query(q): Query<SearchQuery>) -> Res<ListOut> {
    let query = q.q.unwrap_or_default();
    if query.trim().is_empty() {
        return Err(AppError::bad_request("parameter q wajib diisi"));
    }
    let query = query.trim().to_string();
    let genre = q
        .genre
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string());
    // Over-fetch: rank relevansi + filter tipe/status bekerja pada set yang
    // lebih besar dari `limit` tampilan, supaya "30 hasil" tidak diam-diam
    // menyusut jadi 6 (bug chip client-side yang direncanakan diganti).
    let merged = match &genre {
        // Filter genre aktif: satu panggilan per adapter yang menerima
        // genre + judul bersamaan (bukan menyaring sisa halaman di client).
        Some(g) => {
            aggregator()
                .search_in_genre(&query, g, q.page.unwrap_or(1).max(1), FILTER_FANOUT_CAP, None)
                .await
        }
        None => {
            aggregator()
                .search(&query, q.page.unwrap_or(1).max(1), FILTER_FANOUT_CAP, None)
                .await
        }
    };
    let limit = q.limit.unwrap_or(48);
    Ok(Json(list_out_filtered(
        merged,
        Some(&query),
        q.tipe.as_deref(),
        q.status.as_deref(),
        Some(limit as usize),
    )))
}

/// Katalog: `Aggregator::list` (katalog LEBIH LUAS dari search) + filter
/// tipe/status server-side. Tanpa kueri: urutan recency core apa adanya.
///
/// `genre` (kalau ada) diteruskan ke `list()` — SAMA dengan mode search,
/// jadi filternya menyaring sungguhan, bukan cuma menyediakan daftar.
async fn u_catalogue(Query(q): Query<CatalogueQuery>) -> Res<ListOut> {
    let genre = q
        .genre
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty());
    let merged = aggregator()
        .list(genre, q.page.unwrap_or(1).max(1), FILTER_FANOUT_CAP, None)
        .await;
    let limit = q.limit.unwrap_or(48);
    Ok(Json(list_out_filtered(
        merged,
        None,
        q.tipe.as_deref(),
        q.status.as_deref(),
        Some(limit as usize),
    )))
}

async fn u_popular(Query(q): Query<ListQuery>) -> Res<ListOut> {
    let merged = aggregator()
        .popular(q.page.unwrap_or(1).max(1), q.limit.unwrap_or(48), None)
        .await;
    Ok(Json(merged.into()))
}

async fn u_latest(Query(q): Query<ListQuery>) -> Res<ListOut> {
    let merged = aggregator()
        .latest(q.page.unwrap_or(1).max(1), q.limit.unwrap_or(48), None)
        .await;
    Ok(Json(merged.into()))
}

/// Union genre semua sumber: {items:[{slug,name,sources}]}.
async fn u_genres() -> Res<Value> {
    let merged = aggregator().genres(None).await;
    Ok(Json(json!({
        "items": merged.items,
        "failed_sources": merged.failures.iter().map(|(s, _)| s.as_str().to_string()).collect::<Vec<_>>(),
    })))
}

/// Label tampilan per sumber. PEMETAAN SISI SERVER (kontrak lane web):
/// `komik_core::model` sengaja tidak tahu nama tampilan. Sumber di luar
/// daftar dibawa apa adanya supaya sumber baru tidak hilang dari laporan.
fn source_label(source: &str) -> String {
    let label = match source {
        "komiku" => "Komiku",
        "mangaku" => "Mangaku",
        "shinigami" => "Shinigami",
        "kiryuu" => "Kiryuu",
        other => other,
    };
    label.to_string()
}

/// Baris health satu sumber. Urutan field DECLARATION = urutan JSON (serde
/// struct) = kontrak web lane (lane web baca: source, label, ok, latency_ms,
/// error — `komiku-web/src/types.ts::SourceHealthRow`).
#[derive(serde::Serialize)]
pub struct HealthRow {
    pub source: String,
    pub label: String,
    pub ok: bool,
    pub latency_ms: u64,
    /// `null` saat sehat; pesan galat sumber saat mati.
    pub error: Option<String>,
}

/// Payload `GET /api/unified/health`.
#[derive(serde::Serialize)]
pub struct HealthOut {
    pub total: usize,
    pub healthy: usize,
    pub checked_at_ms: i64,
    pub sources: Vec<HealthRow>,
}

/// Probe SATU sumber: core `probe_source_with_timeout` (lewat `Source::ping`
/// = jalur adapter asli, jadi kiryuu tetap lewat Cloudflare DoH internal;
/// tidak menyentuh cache daftar), lalu latensi diukur di server karena
/// `probe.rs` sengaja tidak mengembalikannya.
async fn probe_one(src: std::sync::Arc<dyn Source>) -> HealthRow {
    let source = src.id().as_str().to_string();
    let started = std::time::Instant::now();
    let h = komik_core::probe::probe_source_with_timeout(
        src,
        std::time::Duration::from_secs(komik_core::probe::PROBE_TIMEOUT_SECS),
    )
    .await;
    let ok = h.health == komik_core::probe::Health::Alive;
    HealthRow {
        label: source_label(&source),
        source,
        ok,
        latency_ms: started.elapsed().as_millis() as u64,
        // `detail` core kosong saat hidup -> `null` (kontrak web: `error`
        // null saat sehat); mati -> pesan galat core apa adanya.
        error: if ok { None } else { Some(h.detail.clone()) },
    }
}

/// Bentuk payload health dari baris hasil probe. FUNGSI MURNI (tanpa I/O)
/// supaya bisa diuji tanpa jaringan; handler hanya memanggilnya sekali.
///
/// Sumber MATI adalah DATA, bukan galat server: baris tetap keluar dengan
/// `ok:false` sehingga `healthy < total` (endpoint tetap 200). Nol baris =
/// agregator tanpa sumber sama sekali = kegagalan internal TOTAL — itu
/// yang jadi error di handler, bukan fungsi ini.
fn health_payload(rows: &[HealthRow], checked_at_ms: i64) -> HealthOut {
    let sources: Vec<HealthRow> = rows
        .iter()
        .map(|r| HealthRow {
            source: r.source.clone(),
            label: r.label.clone(),
            ok: r.ok,
            latency_ms: r.latency_ms,
            error: r.error.clone(),
        })
        .collect();
    HealthOut {
        total: rows.len(),
        healthy: sources.iter().filter(|r| r.ok).count(),
        checked_at_ms,
        sources,
    }
}

/// GET /api/unified/health — liveness PER SUMBER (bukan liveness server).
///
/// Probe paralel (`JoinSet`) semua sumber tiap request: SATU probe per
/// sumber, tanpa fan-out tambahan, tanpa cache (core `probe.rs` sengaja tak
/// menyentuh cache supaya "alive" bukan artefak cache lama). Urutan keluaran
/// = urutan `all_sources()` = `SOURCE_PRIORITY` (JoinSet selesai tak berurut).
///
/// Status: SELALU 200 selama ada baris — partial health (sebagian sumber
/// mati) tetap 200 dengan `healthy < total`. Sumber mati BUKAN 502. Hanya
/// nol baris yang error.
async fn u_health() -> Res<HealthOut> {
    let sources = aggregator().sources.clone();
    let mut set = tokio::task::JoinSet::new();
    for src in sources {
        set.spawn(probe_one(src));
    }
    let mut by_source: std::collections::HashMap<String, HealthRow> =
        std::collections::HashMap::new();
    while let Some(joined) = set.join_next().await {
        match joined {
            Ok(row) => {
                by_source.insert(row.source.clone(), row);
            }
            Err(e) => tracing::warn!("task probe health gagal: {e}"),
        }
    }
    // Kembalikan ke urutan `all_sources()` supaya payload stabil antar request.
    let rows: Vec<HealthRow> = aggregator()
        .sources
        .iter()
        .filter_map(|s| by_source.remove(s.id().as_str()))
        .collect();
    if rows.is_empty() {
        return Err(AppError::new(anyhow::anyhow!(
            "tidak ada baris health: agregator tanpa sumber"
        )));
    }
    Ok(Json(health_payload(&rows, now_millis())))
}

/// epoch millis sekarang (0 kalau jam sistem sebelum UNIX_EPOCH).
fn now_millis() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// Validasi bentuk handle "sumber:id" SEBELUM panggil adapter: handle salah
/// bentuk = galat klien (400), bukan sumber mati (502). QA batch a1a095e3.
fn validate_handle(handle: &str) -> Result<(), AppError> {
    let (src, rest) = handle.split_once(':').ok_or_else(|| {
        AppError::bad_request(format!("handle '{handle}' harus format sumber:id"))
    })?;
    if rest.is_empty() {
        return Err(AppError::bad_request(format!(
            "handle '{handle}': id sumber kosong"
        )));
    }
    if src == "komiku" && rest.parse::<i64>().is_err() {
        return Err(AppError::bad_request(format!(
            "id komiku harus integer, dapat '{rest}'"
        )));
    }
    Ok(())
}

/// Detail series + daftar chapter. `handle` = "sumber:native_id".
/// Query opsional `last_source` (mis. "kiryuu") = sumber terakhir yang dibaca
/// client: dicoba LEBIH DULU sebelum sumber dari handle (sticky source,
/// keputusan Q4/8 plan cross-source fallback) — core `series_resolve_pref`.
#[derive(Deserialize)]
pub struct SeriesQuery {
    last_source: Option<String>,
}

async fn u_series(Path(handle): Path<String>, Query(q): Query<SeriesQuery>) -> Res<Value> {
    validate_handle(&handle)?;
    let outcome = aggregator()
        .series_resolve_pref(
            &handle,
            SERIES_CHAPTER_LIMIT,
            None,
            q.last_source.as_deref(),
        )
        .await
        .map_err(classify_core_err)?;
    let detail = outcome.detail;
    let manga = MangaOut::from(&detail.manga);
    let chapters: Vec<ChapterRow> = detail.chapters.iter().map(ChapterRow::from).collect();
    Ok(Json(json!({
        "manga": manga,
        "chapters": chapters,
        "source": detail.manga.source.as_str(),
        // series bukan fan-out: tidak ada partial-failure lintas sumber
        "failed_sources": [],
        "from_cache": outcome.from_cache,
    })))
}

/// Klasifikasi galat core: "tidak ditemukan"/"tidak ada" = entitas absen
/// (404), sisanya upstream (502). JANGAN balas 502 untuk yang tidak ada
/// (plan cross-source A4: kegagalan jaringan ≠ chapter hilang).
fn classify_core_err(e: anyhow::Error) -> AppError {
    let msg = format!("{e:#}");
    if msg.contains("tidak ditemukan") || msg.contains("tidak ada") {
        AppError::not_found(msg)
    } else {
        AppError::new(anyhow::anyhow!(msg))
    }
}

/// Halaman chapter lintas sumber: {title, number, source, images, prev, next,
/// switched_from, note}. SATU panggilan `read_chapter_any`: kalau chapter
/// tidak ada di sumber handle (atau gambarnya kosong), core ambil dari sumber
/// lain yang punya judul sama; `prev`/`next` objek {number,source,handle}
/// selalu dari sumber yang MELAYANI.
async fn u_chapter(Path((handle, number)): Path<(String, String)>) -> Res<Value> {
    validate_handle(&handle)?;
    // title_key SERIES (bukan judul chapter): web pakai utk favorit dan
    // sejarah lintas sumber. Series di-resolve lebih dulu supaya cache
    // aggregator (diisi halaman series) bisa dipakai ulang; kalau resolve
    // gagal, jangan gagalkan baca chapter — pakai kunci judul chapter.
    let series = aggregator()
        .series_resolve(&handle, SERIES_CHAPTER_LIMIT, None)
        .await
        .ok()
        .map(|o| (o.detail.manga.title_key.clone(), o.detail.manga.title.clone()));
    let out = aggregator()
        .read_chapter_any(&handle, &number, None, SERIES_CHAPTER_LIMIT)
        .await
        .map_err(classify_core_err)?;
    let (key, series_title) = match &series {
        Some((k, t)) if !k.is_empty() => (k.clone(), Some(t.clone())),
        _ => (title_key(&out.pages.title), None),
    };
    Ok(Json(json!({
        "title": out.pages.title,
        "number": out.pages.number,
        "source": out.pages.source.as_str(),
        "title_key": key,
        "series_title": series_title,
        "images": out.pages.images,
        "prev": out.prev,
        "next": out.next,
        "switched_from": out.switched_from.as_ref().map(|s| s.as_str()),
        "note": out.note,
    })))
}

// --------------------------------------------------- unduhan PDF (rak buku)

/// Direktori unduhan: default `<users_dir>/downloads` (relatif ke CWD server =
/// D:/project/komiku-server), bisa dioverride lewat env `KOMIKU_DOWNLOADS_DIR`.
/// Di bawah `users_dir()` supaya state per-akun (index/evictions/settings)
/// hidup berdampingan dengan `users/<username>.json`.
fn download_dir() -> std::path::PathBuf {
    std::env::var_os("KOMIKU_DOWNLOADS_DIR")
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|| users_dir().join("downloads"))
}

/// Satu instance store untuk seluruh proses (pola sama seperti `aggregator()`).
fn store() -> anyhow::Result<&'static std::sync::Arc<DownloadStore>> {
    static STORE: std::sync::OnceLock<anyhow::Result<std::sync::Arc<DownloadStore>, String>> =
        std::sync::OnceLock::new();
    STORE
        .get_or_init(|| {
            DownloadStore::open(download_dir()).map_err(|e| {
                tracing::error!("store unduhan gagal dibuka: {e:#}");
                e.to_string()
            })
        })
        .as_ref()
        .map_err(|e| anyhow::anyhow!("store unduhan tidak tersedia: {e}"))
}

/// Konkurensi pengambilan gambar per chapter (chapter biasanya 10-60 halaman).
const PAGE_CONCURRENCY: usize = 6;

#[derive(Deserialize)]
struct DownloadPdfReq {
    handle: String,
    number: String,
}

#[derive(Deserialize)]
struct LimitReq {
    limit_bytes: u64,
}

/// Referer paling generik untuk host gambar: `https://host/`. Adapter sumber
/// (shinigami) sudah pakai pola ini; gambar komiku/mangaku/kiryuu tidak
/// memverifikasi nilai spesifik.
fn referer_for(url: &str) -> String {
    match url.find("://").and_then(|i| url[i + 3..].find('/')) {
        Some(rel) => {
            let end = url.find("://").unwrap() + 3 + rel;
            format!("{}/", &url[..end])
        }
        None => format!("{url}/"),
    }
}

/// Ambil satu gambar chapter server-side. Host WAJIB di allowlist `img.rs`
/// (guard SSRF yang sama dengan proxy `/img`) + UA mobile + Referer host.
async fn fetch_image(url: &str) -> anyhow::Result<Vec<u8>> {
    if !crate::img::host_allowed(url) {
        anyhow::bail!("host gambar tidak diizinkan ({url})");
    }
    let client = reqwest::Client::builder()
        .user_agent(UA_MOBILE)
        .timeout(std::time::Duration::from_secs(30))
        .build()?;
    // Referer di header REQUEST (bukan client): ClientBuilder tanpa fitur
    // default tidak punya `header`.
    let resp = client
        .get(url)
        .header(reqwest::header::REFERER, referer_for(url))
        .send()
        .await?;
    if !resp.status().is_success() {
        anyhow::bail!("HTTP {}", resp.status());
    }
    Ok(resp.bytes().await?.to_vec())
}

/// Ambil semua gambar chapter (konkuren per batch, urutan dipertahankan).
async fn fetch_pages(urls: &[String]) -> anyhow::Result<Vec<pdf::Page>> {
    let mut slots: Vec<Option<Vec<u8>>> = vec![None; urls.len()];
    for (batch, chunk) in urls.chunks(PAGE_CONCURRENCY).enumerate() {
        let mut set = tokio::task::JoinSet::new();
        for (i, url) in chunk.iter().enumerate() {
            let url = url.clone();
            let idx = batch * PAGE_CONCURRENCY + i;
            set.spawn(async move { (idx, fetch_image(&url).await) });
        }
        while let Some(joined) = set.join_next().await {
            let (idx, res) = joined.map_err(|e| anyhow::anyhow!("task gambar gagal: {e}"))?;
            let bytes = res.map_err(|e| anyhow::anyhow!("halaman {}: {e}", idx + 1))?;
            slots[idx] = Some(bytes);
        }
    }
    let mut pages = Vec::with_capacity(urls.len());
    for (url, slot) in urls.iter().zip(slots) {
        pages.push(pdf::Page {
            url: url.clone(),
            bytes: slot.ok_or_else(|| anyhow::anyhow!("gambar halaman {} hilang", pages.len() + 1))?,
        });
    }
    Ok(pages)
}

/// Orkestrasi generate+simpan PDF: resolve chapter lintas sumber via
/// `read_chapter_any` (gambar = `outcome.pages.images`), judul series dari
/// `series_resolve` (untuk `series_title` + `title_key`), tulis PDF ke store.
async fn generate_pdf(username: &str, handle: &str, number: &str) -> Result<DownloadEntry, AppError> {
    let series = aggregator()
        .series_resolve(handle, SERIES_CHAPTER_LIMIT, None)
        .await
        .map_err(classify_core_err)?;
    let series_title = series.detail.manga.title.clone();
    let series_key = series.detail.manga.title_key.clone();

    let out = aggregator()
        .read_chapter_any(handle, number, None, SERIES_CHAPTER_LIMIT)
        .await
        .map_err(classify_core_err)?;
    if out.pages.images.is_empty() {
        return Err(AppError::bad_request(format!(
            "chapter {number} tidak punya gambar"
        )));
    }
    if out.pages.images.len() > downloads::MAX_PAGES {
        return Err(AppError::bad_request(format!(
            "chapter {number} punya {} halaman — terlalu banyak (maks {})",
            out.pages.images.len(),
            downloads::MAX_PAGES
        )));
    }
    let pages = fetch_pages(&out.pages.images).await.map_err(AppError::new)?;
    let (bytes, report) = pdf::write_pdf_bytes(&pages).map_err(AppError::new)?;
    let entry = store()
        .map_err(AppError::new)?
        .store_pdf(
            username,
            handle,
            number,
            &out.pages.title,
            &series_title,
            &series_key,
            bytes,
        )
        .await
        .map_err(AppError::new)?;
    tracing::info!(
        "unduhan {} {} selesai: {} halaman ({} lossless, {} re-encode), {} byte",
        series_title,
        number,
        report.pages,
        report.passthrough,
        report.reencoded,
        entry.size_bytes
    );
    Ok(entry)
}

/// POST /api/unified/download-pdf {handle, number}
/// -> {id, filename, title, series_title, size_bytes} (+title_key)
///
/// Butuh akun: file PDF dibagi, tapi entri index masuk ke akun pemanggil.
async fn u_download_pdf(headers: HeaderMap, Json(req): Json<DownloadPdfReq>) -> Res<Value> {
    let username = require_user(&headers)?;
    validate_handle(&req.handle)?;
    let number = req.number.trim();
    if number.is_empty() {
        return Err(AppError::bad_request("parameter number wajib diisi"));
    }
    let entry = generate_pdf(&username, &req.handle, number).await?;
    Ok(Json(json!({
        "id": entry.id,
        "filename": entry.filename,
        "title": entry.title,
        "series_title": entry.series_title,
        "size_bytes": entry.size_bytes,
        // tambahan (aditif): web pakai untuk kunci rak lintas sumber
        "title_key": entry.title_key,
        "handle": entry.handle,
        "number": entry.number,
    })))
}

/// GET /api/unified/downloads
/// -> {items:[...], total_bytes, limit_bytes} MILIK akun.
async fn u_downloads(headers: HeaderMap) -> Res<Value> {
    let username = require_user(&headers)?;
    let (items, total, limit) = store()?.list(&username).await;
    Ok(Json(json!({
        "items": items,
        "total_bytes": total,
        "limit_bytes": limit,
    })))
}

/// GET /api/unified/downloads/{id} -> byte PDF + Content-Disposition
/// attachment; SEKALIGUS update last_opened_at (LRU).
///
/// ## Seam: browser navigation tidak mengirim header
/// Kartu Rak membuka file ini via `<a href>` (bukan fetch ber-header), jadi
/// request itu TIDAK membawa `X-Komik-User`. Aturannya:
/// - Header akun VALID  -> hanya id yang ADA di index akun itu (isolasi; id
///   akun lain -> 404 walau filenya masih dipakai orang lain).
/// - Tanpa header valid -> file PDF content-addressed dan dibagi, jadi boleh
///   dilayani selama masih direferensikan minimal satu akun (`refs[id] > 0`);
///   id yang tak lagi dipakai (refcount 0) tetap 404.
/// Cabang kedua menjaga tombol Baca/Unduh-lagi tetap bekerja.
async fn u_download_file(
    headers: HeaderMap,
    Path(id): Path<String>,
) -> Result<Response, AppError> {
    let store = store().map_err(AppError::new)?;
    let not_found = || AppError::not_found(format!("unduhan {id} tidak ditemukan"));
    match require_user(&headers) {
        // akun valid: hanya boleh melihat unduhannya sendiri
        Ok(username) => {
            if store.get(&username, &id).await.is_none() {
                return Err(not_found());
            }
        }
        // navigasi tanpa header valid: file dibagi, batasi lewat refcount
        Err(_) => {
            if store.refcount(&id).await == 0 {
                return Err(not_found());
            }
        }
    }
    let entry = store.get_any(&id).await.ok_or_else(not_found)?;
    let bytes = tokio::fs::read(store.pdf_path(&id))
        .await
        .map_err(|_| AppError::not_found(format!("file unduhan {id} tidak ada di disk")))?;
    // LRU update (best-effort: gagal update tidak boleh gagalkan unduhan).
    if let Ok(username) = require_user(&headers) {
        let _ = store.touch(&username, &id).await;
    }
    Response::builder()
        .header(header::CONTENT_TYPE, "application/pdf")
        .header(
            header::CONTENT_DISPOSITION,
            format!("attachment; filename=\"{}\"", entry.filename.replace('"', "")),
        )
        .header(header::CONTENT_LENGTH, bytes.len())
        .body(Body::from(bytes))
        .map_err(|e| AppError::new(anyhow::anyhow!("gagal membentuk respons PDF: {e}")))
}

/// DELETE /api/unified/downloads/{id} -> {deleted:true}
/// Menghapus entri MILIK akun; file fisik hilang hanya saat refcount 0.
async fn u_download_delete(headers: HeaderMap, Path(id): Path<String>) -> Res<Value> {
    let username = require_user(&headers)?;
    let store = store().map_err(AppError::new)?;
    if store.delete(&username, &id).await {
        Ok(Json(json!({ "deleted": true })))
    } else {
        Err(AppError::not_found(format!("unduhan {id} tidak ditemukan")))
    }
}

/// DELETE /api/unified/downloads -> hapus SEMUA MILIK akun (modal settings).
async fn u_download_delete_all(headers: HeaderMap) -> Res<Value> {
    let username = require_user(&headers)?;
    let store = store().map_err(AppError::new)?;
    let before = store.list(&username).await.0.len();
    let changed = store.clear_all(&username).await;
    Ok(Json(json!({ "deleted": if changed { before } else { 0 } })))
}

/// GET /api/unified/evictions -> {items:[...]} MILIK akun.
async fn u_evictions(headers: HeaderMap) -> Res<Value> {
    let username = require_user(&headers)?;
    Ok(Json(json!({ "items": store()?.evictions(&username).await })))
}

/// POST /api/unified/evictions/dismiss -> {ok:true} (log MILIK akun).
async fn u_evictions_dismiss(headers: HeaderMap) -> Res<Value> {
    let username = require_user(&headers)?;
    store()?.dismiss_evictions(&username).await;
    Ok(Json(json!({ "ok": true })))
}

/// GET /api/unified/settings/downloads -> {limit_bytes} MILIK akun.
async fn u_settings_get(headers: HeaderMap) -> Res<Value> {
    let username = require_user(&headers)?;
    let s = store()?.settings(&username).await;
    Ok(Json(json!({ "limit_bytes": s.limit_bytes })))
}

/// PUT /api/unified/settings/downloads {limit_bytes} -> {limit_bytes} MILIK akun.
async fn u_settings_put(headers: HeaderMap, Json(body): Json<LimitReq>) -> Res<Value> {
    let username = require_user(&headers)?;
    let (s, evicted) = store()?.set_limit(&username, body.limit_bytes).await;
    Ok(Json(json!({
        "limit_bytes": s.limit_bytes,
        // tambahan (aditif): berapa yang langsung dievict oleh limit baru
        "evicted": evicted,
    })))
}

// ------------------------------------------------------------------ router

/// Sub-router /api/unified. Handler tidak butuh state (aggregator & store
/// statis), jadi bisa langsung di-`.route()` di router utama tanpa mengubah
/// AppState.
pub fn unified_routes() -> Router<crate::routes::AppState> {
    Router::new()
        .route("/api/unified/health", get(u_health))
        .route("/api/unified/search", get(u_search))
        .route("/api/unified/catalogue", get(u_catalogue))
        .route("/api/unified/popular", get(u_popular))
        .route("/api/unified/latest", get(u_latest))
        .route("/api/unified/genres", get(u_genres))
        .route("/api/unified/series/:handle", get(u_series))
        .route("/api/unified/chapter/:handle/:number", get(u_chapter))
        // Rak buku: unduhan PDF + eviction + settings (kontrak lane rak-buku)
        .route(
            "/api/unified/download-pdf",
            post(u_download_pdf),
        )
        .route(
            "/api/unified/downloads",
            get(u_downloads).delete(u_download_delete_all),
        )
        .route(
            "/api/unified/downloads/:id",
            get(u_download_file).delete(u_download_delete),
        )
        .route("/api/unified/evictions", get(u_evictions))
        .route("/api/unified/evictions/dismiss", post(u_evictions_dismiss))
        .route(
            "/api/unified/settings/downloads",
            get(u_settings_get).put(u_settings_put),
        )
}

#[cfg(test)]
mod tests {
    use super::*;

    /// ChapterRef harus keluar sebagai objek {number,source,handle} — kontrak
    /// prev/next cross-source (plan keputusan 7).
    #[test]
    fn chapter_ref_json_bentuk_objek() {
        let r = komik_core::aggregator::ChapterRef {
            number: "179.5".into(),
            source: komik_core::model::SourceId::from("kiryuu"),
            handle: "kiryuu:slug-judul".into(),
        };
        let v = serde_json::to_value(&r).unwrap();
        assert_eq!(v["number"], "179.5");
        assert_eq!(v["source"], "kiryuu");
        assert_eq!(v["handle"], "kiryuu:slug-judul");
    }

    /// handle kanonik "sumber:id" yang dipakai frontend sebagai URL.
    #[test]
    fn manga_out_handle_dan_field() {
        let mut m = komik_core::model::Manga::new(
            komik_core::model::SourceId::from("komiku"),
            "6426",
            "One Piece",
        );
        m.rating = Some("9".into());
        let out = MangaOut::from(&m);
        assert_eq!(out.handle, "komiku:6426");
        assert_eq!(out.source, "komiku");
        assert_eq!(out.title, "One Piece");
        assert_eq!(out.rating.as_deref(), Some("9"));
    }

    /// Kontrak error: "tidak ditemukan"/"tidak ada" -> 404 (entitas absen);
    /// sisanya -> 502 (upstream). JANGAN 502 untuk yang tidak ada.
    #[test]
    fn classify_core_err_status() {
        use axum::response::IntoResponse;
        let nf = classify_core_err(anyhow::anyhow!(
            "chapter 179.6 tidak ditemukan di sumber mana pun untuk komiku:1308"
        ));
        assert_eq!(nf.into_response().status(), 404);
        let miss = classify_core_err(anyhow::anyhow!("gagal ambil series komiku:6426 (komiku: tidak ada)"));
        assert_eq!(miss.into_response().status(), 404);
        let upstream = classify_core_err(anyhow::anyhow!(
            "gagal memuat chapter 9 untuk komiku:6426 (semua sumber gagal diakses): kiryuu=timeout"
        ));
        assert_eq!(upstream.into_response().status(), 502);
    }

    /// Kontrak rak-buku: `MangaOut` membawa `title_key` ternormalisasi dari
    /// core (web pakai utk favorit/sejarah lintas sumber).
    #[test]
    fn manga_out_membawa_title_key() {
        let m = komik_core::model::Manga::new(
            komik_core::model::SourceId::from("komiku"),
            "6426",
            "One Piece: Romance Dawn!",
        );
        let out = MangaOut::from(&m);
        assert_eq!(out.title_key, komik_core::model::title_key("One Piece: Romance Dawn!"));
        assert_eq!(out.title_key, "one piece romance dawn");
    }

    /// Referer per-host: `https://host/path/img.jpg` -> `https://host/`.
    #[test]
    fn referer_for_host() {
        assert_eq!(referer_for("https://img.komiku.org/a/b.jpg"), "https://img.komiku.org/");
        assert_eq!(referer_for("https://cdn.jsdelivr.net/x.jpg"), "https://cdn.jsdelivr.net/");
        assert_eq!(referer_for("https://host"), "https://host/");
    }

    /// Gambar chapter hanya boleh dari host di allowlist `img.rs` (SSRF).
    #[test]
    fn host_gambar_di_allowlist() {
        assert!(crate::img::host_allowed("https://image2.komiku.to/a.jpg"));
        assert!(!crate::img::host_allowed("https://127.0.0.1/a.jpg"));
        assert!(!crate::img::host_allowed("https://evil.example.com/a.jpg"));
        assert!(!crate::img::host_allowed("http://image2.komiku.to/a.jpg"), "bukan https");
    }

    // ------------------------------------------------------- health per sumber

    /// Label tampilan dipetakan SISI SERVER (bukan dikirim core): 4 sumber
    /// punya label tetap, sumber tak dikenal dibawa apa adanya supaya sumber
    /// baru tidak hilang dari laporan.
    #[test]
    fn health_label_pemetaan_server_side() {
        assert_eq!(source_label("komiku"), "Komiku");
        assert_eq!(source_label("mangaku"), "Mangaku");
        assert_eq!(source_label("shinigami"), "Shinigami");
        assert_eq!(source_label("kiryuu"), "Kiryuu");
        // sumber di luar daftar: jangan invent label — pakai id mentah
        assert_eq!(source_label("sumber-baru"), "sumber-baru");
    }

    /// `healthy` = jumlah baris `ok`, `total` = semua baris. Partial health
    /// (sebagian sumber mati) HARUS menghasilkan `healthy < total` — endpoint
    /// tetap 200, bukan 502.
    #[test]
    fn health_payload_hitung_total_dan_healthy() {
        let rows = vec![
            HealthRow {
                source: "komiku".into(),
                label: "Komiku".into(),
                ok: true,
                latency_ms: 812,
                error: None,
            },
            HealthRow {
                source: "kiryuu".into(),
                label: "Kiryuu".into(),
                ok: false,
                latency_ms: 5001,
                error: Some("timeout 5s".into()),
            },
        ];
        let out = health_payload(&rows, 1_760_000_000_000);
        assert_eq!(out.total, 2);
        assert_eq!(out.healthy, 1);
        assert_eq!(out.checked_at_ms, 1_760_000_000_000);
        // urutan & isi baris dipertahankan (server sudah urut SOURCE_PRIORITY)
        assert_eq!(out.sources[0].source, "komiku");
        assert_eq!(out.sources[0].label, "Komiku");
        assert_eq!(out.sources[1].label, "Kiryuu");
        assert_eq!(out.sources[1].error.as_deref(), Some("timeout 5s"));
    }

    /// Semua sumber mati = data, bukan galat: nol `healthy` tetap punya
    /// `total` penuh, dan `error` tiap baris ikut keluar.
    #[test]
    fn health_payload_semua_mati_masih_data() {
        let rows = vec![HealthRow {
            source: "mangaku".into(),
            label: "Mangaku".into(),
            ok: false,
            latency_ms: 430,
            error: Some("gagal konek".into()),
        }];
        let out = health_payload(&rows, 0);
        assert_eq!(out.total, 1);
        assert_eq!(out.healthy, 0);
        assert!(out.sources[0].error.is_some());
    }

    /// Kontrak JSON persis yang dibaca lane web (`types.ts::SourceHealthRow` +
    /// `SourceHealth`): `total`, `healthy`, `checked_at_ms`, `sources[]` dengan
    /// `source`, `label`, `ok`, `latency_ms`, `error`. Seam rule repo: nama
    /// field yang di-emit server harus sama dengan yang dibaca client.
    #[test]
    fn health_payload_kontrak_json_web() {
        let row = HealthRow {
            source: "komiku".into(),
            label: "Komiku".into(),
            ok: true,
            latency_ms: 812,
            error: None,
        };
        let v = serde_json::to_value(&HealthOut {
            total: 4,
            healthy: 4,
            checked_at_ms: 1_760_000_000_000,
            sources: vec![row],
        })
        .unwrap();
        assert_eq!(v["total"], 4);
        assert_eq!(v["healthy"], 4);
        assert_eq!(v["checked_at_ms"], 1_760_000_000_000_i64);
        let src = &v["sources"][0];
        assert_eq!(src["source"], "komiku");
        assert_eq!(src["label"], "Komiku");
        assert_eq!(src["ok"], true);
        assert_eq!(src["latency_ms"], 812);
        // sehat -> `error` null (bukan string kosong): web baca `error == null`
        assert!(src["error"].is_null());
    }

    // ------------------------------------------------- filter tipe/status

    /// Manga sintetis untuk filter (manga_type/status diatur eksplisit).
    fn sample(tag: &str, tipe: Option<&str>, status: Option<&str>) -> Manga {
        let mut m = komik_core::model::Manga::new(
            komik_core::model::SourceId::from("komiku"),
            tag,
            tag,
        );
        m.manga_type = tipe.map(|s| s.to_string());
        m.status = status.map(|s| s.to_string());
        m
    }

    /// Tanpa filter = semua lolos.
    #[test]
    fn match_filters_tanpa_filter_semua_lolos() {
        let a = sample("a", Some("Manga"), Some("Ongoing"));
        let b = sample("b", Some("Manhwa"), None);
        assert!(match_filters(&a, None, None));
        assert!(match_filters(&b, None, None));
    }

    /// Filter tipe CASE-INSENSITIVE pasang nilai; status ikut diuji.
    #[test]
    fn match_filters_tipe_status_case_insensitive() {
        let a = sample("a", Some("Manhwa"), Some("Completed"));
        assert!(match_filters(&a, Some("MANHWA"), None));
        assert!(match_filters(&a, Some("manhwa"), Some("COMPLETED")));
        assert!(match_filters(&a, Some("Manhua"), None) == false, "tipe beda gugur");
        assert!(match_filters(&a, None, Some("Ongoing")) == false, "status beda gugur");
    }

    /// Item dengan field None GUGUR saat filter itu aktif — jangan pura-pura
    /// cocok (chip web = penanda ketersediaan, bukan janji isi).
    #[test]
    fn match_filters_field_none_gugur_saat_filter_aktif() {
        let m = sample("m", None, Some("Ongoing"));
        assert!(!match_filters(&m, Some("Manga"), None));
        assert!(match_filters(&m, None, Some("Ongoing")));
        let s = sample("s", Some("Manhua"), None);
        assert!(!match_filters(&s, None, Some("Ongoing")));
        assert!(match_filters(&s, Some("Manhua"), None));
    }

    /// Kedua filter aktif sekaligus = AND. Yang lolos harus keduanya cocok.
    #[test]
    fn match_filters_dua_duanya_and() {
        let hit = sample("hit", Some("Manga"), Some("Ongoing"));
        let miss_tipe = sample("mt", Some("Manhua"), Some("Ongoing"));
        let miss_status = sample("ms", Some("Manga"), Some("Completed"));
        assert!(match_filters(&hit, Some("Manga"), Some("Ongoing")));
        assert!(!match_filters(&miss_tipe, Some("Manga"), Some("Ongoing")));
        assert!(!match_filters(&miss_status, Some("Manga"), Some("Ongoing")));
    }

    /// Payload count JUJUR terhadap filter: item dikembalikan = jumlah yang
    /// lolos filter (bukan pra-filter), dan `failed_sources`/`from_cache`
    /// diteruskan apa adanya. Ini yang membuat chip tipe tidak lagi
    /// "30 hasil -> 6".
    #[test]
    fn list_out_filtered_hitung_jujur() {
        let merged = komik_core::aggregator::Merged {
            items: vec![
                sample("a", Some("Manga"), Some("Ongoing")),
                sample("b", Some("Manhwa"), Some("Ongoing")),
                sample("c", Some("Manga"), Some("Completed")),
                sample("d", Some("Manhwa"), None),
            ],
            failures: vec![(komik_core::model::SourceId::from("kiryuu"), "timeout".into())],
            sources_total: 4,
            sources_ok: 3,
            from_cache: false,
        };
        // Filter tipe=Manga -> 2 item (a, c), status Ongoing -> ya.
        let out = list_out_filtered(merged.clone(), None, Some("Manga"), None, None);
        assert_eq!(out.items.len(), 2, "count harus jujur terhadap filter");
        assert!(out.items.iter().all(|i| i.manga_type.as_deref() == Some("Manga")));
        // partial failure diteruskan apa adanya (bukan disembunyikan filter)
        assert_eq!(out.failed_sources, vec!["kiryuu".to_string()]);

        // Tanpa filter = semua item (recency core apa adanya, tidak di-rank).
        let all = list_out_filtered(merged.clone(), None, None, None, None);
        assert_eq!(all.items.len(), 4);

        // AND: tipe=Manga + status=Ongoing -> 1 item.
        let both = list_out_filtered(merged.clone(), None, Some("manga"), Some("ongoing"), None);
        assert_eq!(both.items.len(), 1);
        assert_eq!(both.items[0].native_id, "a");

        // `max` memotong HASIL terfilter, bukan input.
        let capped = list_out_filtered(merged.clone(), None, None, None, Some(2));
        assert_eq!(capped.items.len(), 2);
    }

    /// `from_cache` diteruskan dari merge (search/catalogue yang dilayani dari
    /// cache tetap jujur melaporkannya setelah filter).
    #[test]
    fn list_out_filtered_teruskan_from_cache() {
        let merged = komik_core::aggregator::Merged {
            items: vec![sample("a", Some("Manga"), Some("Ongoing"))],
            failures: vec![],
            sources_total: 4,
            sources_ok: 4,
            from_cache: true,
        };
        let out = list_out_filtered(merged, None, Some("Manga"), None, None);
        assert!(out.from_cache);
        assert_eq!(out.items.len(), 1);

        // Filter yang menyisakan 0 TETAP 200 (data, bukan galat).
        let out0 = list_out_filtered(
            komik_core::aggregator::Merged {
                items: vec![sample("a", Some("Manhua"), Some("Ongoing"))],
                failures: vec![],
                sources_total: 4,
                sources_ok: 4,
                from_cache: false,
            },
            None,
            Some("Manga"),
            None,
            None,
        );
        assert_eq!(out0.items.len(), 0);
    }
}
