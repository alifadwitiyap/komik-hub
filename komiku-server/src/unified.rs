//! Route `/api/unified/*` — pembungkus tipis `komik-core` (4 sumber manga:
//! komiku/mangaku/shinigami/kiryuu) untuk frontend. Route Komiku existing
//! (`/api/*` lain) TIDAK disentuh — file ini hanya menambah.
//!
//! Kontrak JSON (frontend + CLI memakai bentuk yang sama):
//! - GET /api/unified/search?q=&page= -> {items:[MangaOut], failed_sources:[string]}
//! - GET /api/unified/popular?page=   -> sama
//! - GET /api/unified/latest?page=    -> sama
//! - GET /api/unified/genres          -> {items:[{slug,name,sources:[string]}]}
//! - GET /api/unified/series/{handle} -> {manga:MangaOut, chapters:[ChapterRow],
//!   source:string, representative_source:string|null, failed_sources:[string],
//!   from_cache:bool}
//!   `representative_source` = sumber dengan chapter numerik utama terbesar
//!   (tie-break SOURCE_PRIORITY); null kalau tak ada chapter numerik.
//!   CATATAN `from_cache`: hanya melacak cache DETAIL PRIMARY.
//!   dari sumber lain punya cache sendiri (kunci "series-union:{title_key}")
//!   yang status hit-nya tidak diekspos — jadi `from_cache:true` tak
//!   menjamin seluruh respons dari cache, dan `false` tak berarti seluruh
//!   respons fresh. Jangan pakai field ini sebagai proxy efektivitas cache
//!   tanpa memakai `failed_sources` juga.
//!   handle = "sumber:native_id" (URL-encoded oleh klien, mis. "komiku%3A6426")
//!   `chapters` = UNION lintas sumber: semua episode dari semua sumber yang
//!   punya series dengan judul sama (episode eksklusif sumber lain ikut).
//!   Tiap ChapterRow += `source` + `handle` (sumber + handle series PEMILIK
//!   chapter itu, bisa beda dari sumber manga primary).
//! - GET /api/unified/chapter/{handle}/{number}
//!   -> {title, number, source, images:[url],
//!   prev:{number,source,handle}|null, next:{...}|null,
//!   switched_from: sumber|null, note: string|null}
//!   (fallback lintas sumber: kalau chapter tidak ada di sumber handle, core
//!   ambil dari sumber lain berjudul sama — cross-source chapter fallback)
//! - GET /api/unified/series/{handle}?last_source=kiryuu (opsional)
//!   -> sumber terakhir dibaca dicoba LEBIH DULU (sticky source)
//! - GET /api/unified/health
//!   -> {total, healthy, checked_at_ms,
//!   sources:[{source,label,ok,latency_ms,error}]}
//!   Liveness PER SUMBER, bukan liveness server: SELALU 200 selama ada
//!   baris (sumber mati = DATA, bukan galat). `label` dipetakan sisi SERVER;
//!   probe jalan lewat `komik_core::probe` (kiryuu = Cloudflare DoH internal).
//!   Di-cache dengan stale-while-revalidate (TTL 30 detik, single-flight) —
//!   lihat tradeoff di doc `u_health`; `checked_at_ms` tetap waktu probe
//!   ASLI, bukan waktu cache hit. `?force=1` = probe inline (tombol refresh).
//!
//! Model core (model.rs) sengaja tanpa Serialize, jadi bentuk keluar dibentuk
//! via DTO di file ini — file core tidak diubah. Aggregator core sudah punya
//! timeout per sumber + cache memory TTL 10 menit; di sini hanya dipakai.

use axum::{
    body::Body,
    extract::{Path, Query, State},
    http::{header, HeaderMap},
    response::Response,
    routing::{get, post},
    Json, Router,
};
use serde::Deserialize;
use serde_json::{json, Value};
use std::sync::Arc;

use komik_core::adapters::all_sources;
use komik_core::aggregator::{Aggregator, SortMode};
use komik_core::cache::Cache;
use komik_core::model::{title_key, Manga};
use komik_core::source::Source;

use crate::downloads::{self, DownloadEntry, DownloadStore, PdfMeta};
use crate::pdf;
use crate::routes::{AppError, Res};
use crate::user::{require_user, users_dir};

/// UA Android: adapter komiku/mangaku/shinigami WAJIB UA mobile (kalau tidak,
/// host balas halaman/error tanpa data). Adapter kiryuu membuat client
/// pinned DoH sendiri secara internal, jadi client ini cukup untuk 3 sumber.
pub(crate) const UA_MOBILE: &str = "Mozilla/5.0 (Linux; Android 13; SM-S908B) AppleWebKit/537.36 \
                          (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36";
/// Batas panjang daftar chapter yang di-fetch (dan di-cache core) supaya
/// navigasi prev/next tetap jalan untuk manga panjang (One Piece dst).
const SERIES_CHAPTER_LIMIT: u32 = 2000;

// ------------------------------------------------------------------ agregator

/// Batas total satu request unified yang punya fallback berurutan
/// (series/chapter). Fan-out daftar sudah dibatasi timeout per sumber;
/// angka ini mencegah fallback 4 sumber × 6 s menahan koneksi user ~24 s.
const UNIFIED_REQUEST_BUDGET: std::time::Duration = std::time::Duration::from_secs(15);

/// Bangun satu instance Aggregator (pola OnceCell seperti `api::CLIENT` —
/// client & cache dipakai bersama semua request).
///
/// Sumber dibungkus [`crate::resilience::ResilientSource`] supaya sumber yang
/// timeout tidak ditembak ulang setiap request (cache core sengaja tidak
/// menyimpan hasil yang sebagian gagal). Timeout per sumber 6 s, bukan 10 s
/// default core: satu sumber mati tidak boleh menahan request user lama.
fn build_aggregator() -> Aggregator {
    let client = reqwest::Client::builder()
        .user_agent(UA_MOBILE)
        .timeout(std::time::Duration::from_secs(
            2 * crate::resilience::SOURCE_TIMEOUT_SECS,
        ))
        .build()
        .unwrap_or_default();
    let sources = crate::resilience::ResilientSource::wrap_all(
        all_sources(client),
        crate::resilience::SOURCE_COOLDOWN,
        crate::resilience::SOURCE_INNER_TIMEOUT,
    );
    Aggregator::with_cache(
        sources,
        Cache::with_disk(
            komik_core::cache::DEFAULT_TTL,
            users_dir().join("cache"),
        ),
    )
    .with_timeout(std::time::Duration::from_secs(
        crate::resilience::SOURCE_TIMEOUT_SECS,
    ))
}

/// State terpusat untuk semua handler `/api/unified/*`. Dulu tiap resource
/// (aggregator, cache, gerbang, semaphore, store) hidup sebagai OnceLock
/// statis — state bocor lintas test dan handler sulit diuji. Sekarang semua
/// dipegang di sini dan di-inject via axum `State` extractor.
pub struct UnifiedState {
    pub aggregator: Aggregator,
    pub search_cache: SearchCache,
    pub search_gate: tokio::sync::Mutex<()>,
    pub health_cache: tokio::sync::Mutex<Option<(std::time::Instant, HealthOut)>>,
    pub health_refresh_gate: tokio::sync::Mutex<()>,
    pub series_cache: std::sync::Mutex<SeriesCache>,
    pub series_gates: std::sync::Mutex<std::collections::HashMap<String, Arc<tokio::sync::Mutex<()>>>>,
    pub series_fanout_permits: tokio::sync::Semaphore,
    /// Single-flight PER CHAPTER (`handle` + nomor ternormalisasi) untuk
    /// `/api/unified/chapter/*`. Terpisah dari `series_gates`: request chapter
    /// TIDAK boleh ikut mengantre di gerbang series (fan-out series jauh lebih
    /// mahal dan sudah punya semaphore sendiri).
    pub chapter_gates: ChapterGates,
    pub chapter_cache: std::sync::Mutex<ChapterCache>,
    pub image_client: reqwest::Client,
    pub download_store: anyhow::Result<Arc<DownloadStore>, String>,
}

impl UnifiedState {
    pub fn new() -> Self {
        // Anti-pola: sekali init, tiap request baca dari state (bukan static).
        let download_store = DownloadStore::open(download_dir()).map_err(|e| {
            tracing::error!("store unduhan gagal dibuka: {e:#}");
            e.to_string()
        });
        let st = UnifiedState {
            aggregator: build_aggregator(),
            search_cache: std::sync::Mutex::new(std::collections::HashMap::new()),
            search_gate: tokio::sync::Mutex::new(()),
            health_cache: tokio::sync::Mutex::new(None),
            health_refresh_gate: tokio::sync::Mutex::new(()),
            series_cache: std::sync::Mutex::new(std::collections::HashMap::new()),
            series_gates: std::sync::Mutex::new(std::collections::HashMap::new()),
            series_fanout_permits: tokio::sync::Semaphore::new(3),
            chapter_gates: ChapterGates::default(),
            chapter_cache: std::sync::Mutex::new(std::collections::HashMap::new()),
            image_client: reqwest::Client::builder()
                .user_agent(UA_MOBILE)
                .pool_idle_timeout(std::time::Duration::from_secs(90))
                .build()
                .unwrap_or_default(),
            download_store,
        };
        // Sapu TTL store: spawn sekali (setiap proses bikin state sekali).
        // Hanya bila runtime tokio aktif (di luar runtime, mis. test sinkron,
        // tak perlu sapu — biar tidak panic).
        if let Ok(store) = st.download_store.as_ref() {
            if tokio::runtime::Handle::try_current().is_ok() {
                let store = store.clone();
                tokio::spawn(async move {
                    let mut ticker = tokio::time::interval(SWEEP_INTERVAL);
                    ticker.tick().await;
                    loop {
                        let n = store.sweep_expired().await;
                        if n > 0 {
                            tracing::info!("sweep unduhan: {n} entri kedaluwarsa dibuang");
                        }
                        ticker.tick().await;
                    }
                });
            }
        }
        st
    }
}

impl Default for UnifiedState {
    fn default() -> Self {
        Self::new()
    }
}

/// Pre-fetch health + feed latest/popular saat startup. Urutan sengaja:
/// health DULU dan sendirian — probe health adalah pintu pertama (poll
/// container/bench), jadi jangan berebut sumber dengan warm-up feed yang bisa
/// memperlambat request /health pertama. Setelah health, feed latest/popular
/// dipanaskan untuk user pertama (cache hit alih-alih fan-out dingin 2-5s).
/// Semua async & non-blocking — dipanggil via `tokio::spawn` dari main
/// supaya TIDAK menunda bind/`serve`.
pub async fn warm_up(state: std::sync::Arc<UnifiedState>) {
    let t0 = std::time::Instant::now();
    match probe_health_and_store(&state).await {
        Ok(out) => tracing::info!(
            "warm-up health: {}/{} sehat dalam {:?}",
            out.healthy, out.total, t0.elapsed()
        ),
        Err(e) => tracing::warn!("warm-up health gagal: {e:#}"),
    }

    let t1 = std::time::Instant::now();
    let m = state.aggregator.latest(1, 48, None, SortMode::Latest).await;
    tracing::info!(
        "warm-up latest: {} item dalam {:?}",
        m.items.len(),
        t1.elapsed()
    );
    // Popular juga dipanaskan: endpoint ini tidak di-warm sebelumnya sehingga
    // user pertama popular membayar fan-out dingin penuh (~5s) sama seperti
    // latest sebelum warm-up ada. Cache disk menahan hasil lintas restart,
    // tapi warm-up ini menutup kasus disk kosong pertama kali.
    let t2 = std::time::Instant::now();
    let p = state.aggregator.popular(1, 48, None, SortMode::Latest).await;
    tracing::info!(
        "warm-up popular: {} item dalam {:?}",
        p.items.len(),
        t2.elapsed()
    );
}

// ------------------------------------------------------------------ DTO

/// Kartu manga lintas sumber. Persis kontrak frontend.
///
/// `title_key` DITAMBAH (kontrak lane rak-buku): judul ternormalisasi supaya
/// web bisa bikin favorit/sejarah lintas sumber tanpa reimplement normalisasi
/// di JS.
#[derive(serde::Serialize, Clone)]
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
///
/// `source` + `handle` (DITAMBAH, lane union chapter): chapter bisa datang
/// dari sumber BERBEDA dari manga primary, jadi client perlu tahu handle
/// series di sumber pemilik chapter itu untuk membacanya.
#[derive(serde::Serialize)]
pub struct ChapterRow {
    pub number: String,
    pub title: String,
    pub native_id: String,
    pub updated_at: Option<i64>,
    /// Sumber yang benar-benar punya chapter ini.
    pub source: String,
    /// Handle series di sumber itu ("shinigami:3b1eab91").
    pub handle: String,
}

impl From<&komik_core::union::MergedChapter> for ChapterRow {
    fn from(c: &komik_core::union::MergedChapter) -> Self {
        ChapterRow {
            number: c.number.clone(),
            title: c.title.clone(),
            native_id: c.native_id.clone(),
            updated_at: c.updated_at,
            source: c.source.as_str().to_string(),
            handle: c.handle.clone(),
        }
    }
}

/// Respons daftar merged lintas sumber + laporan partial failure.
#[derive(serde::Serialize, Clone)]
pub struct ListOut {
    pub items: Vec<MangaOut>,
    pub failed_sources: Vec<String>,
    pub from_cache: bool,
    /// Jumlah sumber yang digabung server pada panggilan ini. Dikirim supaya
    /// client TIDAK perlu hardcode `TOTAL_SOURCES = 4` — tambah sumber ke-5
    /// di Rust dan chip "n/m sumber gagal" di web tetap benar.
    pub sources_total: usize,
    /// Berapa sumber yang berhasil. `failed_sources.len()` + ini = total.
    pub sources_ok: usize,
    /// Apakah masih ada item berikutnya setelah `limit` yang diminta.
    /// Server yang menghitung (bukan `items.len() < 20` di client — itu
    /// patah kalau limit != 20). Dikirim supaya tombol "Berikutnya" mati
    /// hanya ketika memang sudah habis.
    #[serde(default)]
    pub has_more: bool,
    /// Sumber yang BELUM selesai saat respons ini dikirim (mode dua fase).
    /// Kosong = semua sumber sudah dilaporkan. Client boleh memanggil ulang
    /// dengan kunci sama; hasil lengkap biasanya sudah ada di cache.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub pending: Vec<String>,
}

impl From<komik_core::aggregator::Merged<Manga>> for ListOut {
    fn from(m: komik_core::aggregator::Merged<Manga>) -> Self {
        ListOut {
            pending: Vec::new(),
            items: m.items.iter().map(MangaOut::from).collect(),
            failed_sources: m
                .failures
                .iter()
                .map(|(s, _)| s.as_str().to_string())
                .collect(),
            from_cache: m.from_cache,
            sources_total: m.sources_total,
            sources_ok: m.sources_ok,
            has_more: false,
        }
    }
}

// ------------------------------------------------------------------ handler lintas sumber

#[derive(Deserialize)]
pub struct ListQuery {
    page: Option<u32>,
    /// batas jumlah item (default 48; 0 = tanpa batas)
    limit: Option<u32>,
    /// filter sumber tunggal (komiku|mangaku|shinigami|kiryuu); kosong = semua
    source: Option<String>,
    /// mode urutan: latest|rating|trending (default latest)
    sort: Option<String>,
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
    /// filter sumber tunggal; kosong = semua
    source: Option<String>,
    /// mode urutan: latest|rating|trending (default latest)
    sort: Option<String>,
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
    /// filter sumber tunggal; kosong = semua
    source: Option<String>,
    /// mode urutan: latest|rating|trending (default latest)
    sort: Option<String>,
}

/// Normalisasi param `?source=`: trim, kosong / tak dikenal -> None (semua).
fn norm_source(s: Option<&str>) -> Option<&str> {
    s.map(str::trim).filter(|s| !s.is_empty())
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
        Some(w) => field.as_deref().is_some_and(|v| v.eq_ignore_ascii_case(w)),
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
    sort: SortMode,
    max: Option<usize>,
) -> ListOut {
    // Jumlah item SEBELUM filter relevansi. Dipakai untuk `has_more`: setelah
    // `rank_by_query` membuang NoMatch, `items.len()` menyusut dan halaman bisa
    // terlihat "terakhir" padahal upstream masih punya halaman berikutnya
    // (terukur: "one piece" hal.1 = 27 item mentah -> 15 relevan; tanpa ini
    // tombol "Berikutnya" mati di halaman 1 dan hal.2 tak pernah terjangkau).
    let pre_filter_len = merged.items.len();
    // rank_by_query dengan kueri kosong = no-op (urut recency dari core).
    // Sort diterapkan SETELAH rank relevansi supaya `?sort=rating` tidak
    // ditimpa urutan tier relevansi.
    let items: Vec<Manga> = match query {
        Some(q) => komik_core::aggregator::rank_by_query(merged.items, q),
        None => merged.items,
    }
    .into_iter()
    .filter(|m| match_filters(m, tipe, status))
    .collect();
    let items = komik_core::aggregator::apply_sort(items, sort);
    let mut out = ListOut::from(komik_core::aggregator::Merged { items, ..merged });
    if let Some(max) = max {
        // Heuristik standar infinite-scroll: halaman penuh (=limit) berarti
        // kemungkinan besar masih ada isi. Bukan kebenaran mutlak (server
        // over-fetch bisa membuat halaman terakhir tetap penuh), tapi jauh
        // lebih baik daripada membandingkan dengan konstanta ajaib di client.
        //
        // Diukur dari jumlah SEBELUM filter relevansi, supaya pembuangan
        // NoMatch tidak memalsukan "sudah habis".
        out.has_more = pre_filter_len.max(out.items.len()) >= max;
        out.items.truncate(max);
    }
    out
}

// ------------------------------------------------------- cache pencarian (SWR)

/// TTL hasil pencarian. Cukup pendek: katalog sumber berubah lambat, tapi
/// query yang sama berulang (klik chip, back/forward, retry) tak perlu
/// menembak upstream 3-4 detik lagi. Diukur: cold 3.6 s, cache-hit 0.005 s.
/// Deadline fase 1 pencarian dua fase. Sumber yang belum selesai dalam
/// waktu ini dilaporkan lewat `pending` dan diselesaikan di background.
/// 1.5 s: di atas latensi shinigami (~1 s) dan komiku (~1.6 s) yang
/// memberi mayoritas item; mangaku (~3.2 s) & kiryuu (~2.8 s) menunggu
/// fase 2. Diukur: sumber cepat selesai <1.6 s (lihat [perf] log).
const SEARCH_PHASE1_MILLIS: u64 = 1500;

const SEARCH_CACHE_TTL: std::time::Duration = std::time::Duration::from_secs(120);
/// Batas jumlah query yang disimpan (LRU kasar: buang yang paling lama dipakai
/// saat penuh). Pencarian = kunci tak terbatas, jadi cap wajib.
const SEARCH_CACHE_MAX: usize = 128;

type SearchCache = std::sync::Mutex<std::collections::HashMap<String, (std::time::Instant, ListOut)>>;

fn search_key(
    query: &str,
    genre: Option<&str>,
    page: u32,
    limit: u32,
    source: Option<&str>,
    sort: SortMode,
) -> String {
    format!(
        "{query}\u{1}{}\u{1}{page}\u{1}{limit}\u{1}{}\u{1}{}",
        genre.unwrap_or(""),
        source.unwrap_or("*"),
        sort.as_str()
    )
}

/// Ambil hasil dari cache kalau masih segar. `None` = harus fetch upstream.
fn search_cache_get(cache: &SearchCache, key: &str) -> Option<ListOut> {
    let guard = cache.lock().ok()?;
    let (at, out) = guard.get(key)?;
    if at.elapsed() < SEARCH_CACHE_TTL {
        Some(out.clone())
    } else {
        None
    }
}

fn search_cache_put(cache: &SearchCache, key: String, out: ListOut) {
    if let Ok(mut guard) = cache.lock() {
        // Cap kasar: buang satu entri paling tua kalau sudah penuh. HashMap
        // tak berurutan, jadi cari min-by-instant (N kecil = 128, murah).
        if guard.len() >= SEARCH_CACHE_MAX && !guard.contains_key(&key) {
            if let Some(old) = guard
                .iter()
                .min_by_key(|(_, (at, _))| *at)
                .map(|(k, _)| k.clone())
            {
                guard.remove(&old);
            }
        }
        guard.insert(key, (std::time::Instant::now(), out));
    }
}

async fn u_search(State(state): State<Arc<crate::routes::AppState>>, Query(q): Query<SearchQuery>) -> Res<ListOut> {
    let state = &state.unified;
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
    let source = norm_source(q.source.as_deref());
    let sort = SortMode::parse(q.sort.as_deref());
    let page = q.page.unwrap_or(1).max(1);
    let limit = q.limit.unwrap_or(48);
    let key = search_key(&query, genre.as_deref(), page, limit, source, sort);
    if let Some(hit) = search_cache_get(&state.search_cache, &key) {
        return Ok(Json(hit));
    }
    // Cache kosong: satu request per key yang menembak upstream, sisanya
    // menunggu gerbang lalu membaca cache.
    let _gate = state.search_gate.lock().await;
    if let Some(hit) = search_cache_get(&state.search_cache, &key) {
        return Ok(Json(hit));
    }
    // Over-fetch: rank relevansi + filter tipe/status bekerja pada set yang
    // lebih besar dari `limit` tampilan, supaya "30 hasil" tidak diam-diam
    // menyusut jadi 6 (bug chip client-side yang direncanakan diganti).
    // DUA FASE hanya untuk pencarian biasa (tanpa filter genre, yang butuh
    // satu panggilan per adapter dan tidak punya jalur fan-out yang sama).
    // Deadline 3 s: cukup untuk sumber cepat (shinigami ~60 ms, mangaku
    // ~1,3 s), sementara komiku (TTFB 5-9 s) diselesaikan di background.
    let (merged, pending) = match &genre {
        // Filter genre aktif: satu panggilan per adapter yang menerima
        // genre + judul bersamaan (bukan menyaring sisa halaman di client).
        Some(g) => (
            state
                .aggregator
                .search_in_genre(&query, g, page, FILTER_FANOUT_CAP, source, sort)
                .await,
            Vec::new(),
        ),
        None => {
            state
                .aggregator
                .search_dua_fase(
                    &query,
                    page,
                    FILTER_FANOUT_CAP,
                    source,
                    std::time::Duration::from_millis(SEARCH_PHASE1_MILLIS),
                    sort,
                )
                .await
        }
    };
    let mut out = list_out_filtered(
        merged,
        Some(&query),
        q.tipe.as_deref(),
        q.status.as_deref(),
        sort,
        Some(limit as usize),
    );
    out.pending = pending.iter().map(|s| s.as_str().to_string()).collect();
    // JANGAN cache kalau masih ada sumber pending: fase 2 yang akan mengisi
    // cache dengan hasil lengkap. Menyimpan hasil separuh di sini membuat
    // panggilan berikutnya menyajikan daftar tidak lengkap selama TTL.
    if out.pending.is_empty() {
        search_cache_put(&state.search_cache, key, out.clone());
    }
    Ok(Json(out))
}

/// Katalog: `Aggregator::list` (katalog LEBIH LUAS dari search) + filter
/// tipe/status server-side. Tanpa kueri: urutan recency core apa adanya.
///
/// `genre` (kalau ada) diteruskan ke `list()` — SAMA dengan mode search,
/// jadi filternya menyaring sungguhan, bukan cuma menyediakan daftar.
async fn u_catalogue(State(state): State<Arc<crate::routes::AppState>>, Query(q): Query<CatalogueQuery>) -> Res<ListOut> {
    let state = &state.unified;
    let genre = q.genre.as_deref().map(str::trim).filter(|s| !s.is_empty());
    let source = norm_source(q.source.as_deref());
    let sort = SortMode::parse(q.sort.as_deref());
    let merged = state
        .aggregator
        .list(genre, q.page.unwrap_or(1).max(1), FILTER_FANOUT_CAP, source, sort)
        .await;
    let limit = q.limit.unwrap_or(48);
    Ok(Json(list_out_filtered(
        merged,
        None,
        q.tipe.as_deref(),
        q.status.as_deref(),
        sort,
        Some(limit as usize),
    )))
}

async fn u_popular(State(state): State<Arc<crate::routes::AppState>>, Query(q): Query<ListQuery>, headers: HeaderMap) -> Response {
    let state = &state.unified;
    let source = norm_source(q.source.as_deref());
    let sort = SortMode::parse(q.sort.as_deref());
    let merged = state
        .aggregator
        .popular(q.page.unwrap_or(1).max(1), q.limit.unwrap_or(48), source, sort)
        .await;
    let mut out: ListOut = merged.into();
    // has_more jujur (sama seperti u_latest): hasil penuh = limit → masih ada
    // halaman berikutnya. `From<Merged>` hardcode false.
    let limit = q.limit.unwrap_or(48) as usize;
    out.has_more = limit > 0 && out.items.len() >= limit;
    crate::routes::json_with_etag(&out, "public, max-age=15", crate::routes::if_none_match(&headers))
}

async fn u_latest(State(state): State<Arc<crate::routes::AppState>>, Query(q): Query<ListQuery>, headers: HeaderMap) -> Response {
    let state = &state.unified;
    let source = norm_source(q.source.as_deref());
    let sort = SortMode::parse(q.sort.as_deref());
    let merged = state
        .aggregator
        .latest(q.page.unwrap_or(1).max(1), q.limit.unwrap_or(48), source, sort)
        .await;
    let mut out: ListOut = merged.into();
    // has_more jujur: kalau hasil penuh = limit, kemungkinan masih ada halaman
    // berikutnya (infinite-scroll butuh ini; `From<Merged>` hardcode false).
    let limit = q.limit.unwrap_or(48) as usize;
    out.has_more = limit > 0 && out.items.len() >= limit;
    crate::routes::json_with_etag(&out, "public, max-age=15", crate::routes::if_none_match(&headers))
}

/// Union genre semua sumber: {items:[{slug,name,sources}]}.
async fn u_genres(State(state): State<Arc<crate::routes::AppState>>) -> Res<Value> {
    let state = &state.unified;
    let merged = state.aggregator.genres(None).await;
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
#[derive(serde::Serialize, Clone)]
pub struct HealthRow {
    pub source: String,
    pub label: String,
    pub ok: bool,
    pub latency_ms: u64,
    /// `null` saat sehat; pesan galat sumber saat mati.
    pub error: Option<String>,
}

/// Payload `GET /api/unified/health`.
#[derive(serde::Serialize, Clone)]
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

/// TTL cache health (soft). KEPUTUSAN DESAIN yang diubah (dulu: sengaja TANPA
/// cache supaya "alive" bukan artefak cache).
///
/// Skema: **stale-while-revalidate**. Umur < TTL = segar (sajikan cache).
/// Umur >= TTL = basi TAPI masih disajikan seketika, sambil SATU refresh
/// latar dijalankan (single-flight) supaya request berikutnya dapat hasil
/// baru. Ini yang membuat latensi steady-state ~2 ms, bukan ~1 s: klien web
/// poll tiap 30 s (`useSourceHealth.ts::POLL_MS`) dan tidak pernah lagi
/// menunggu probe penuh, kecuali saat cache benar-benar dingin.
///
/// Kenapa TTL = 30 s (bukan 5 s seperti draft pertama): dengan poll klien
/// 30 s, TTL 5 s hampir selalu sudah basi saat poll berikutnya tiba, jadi
/// tiap poll tetap menunggu probe penuh (~1 s) — cache-nya nyaris tak
/// berguna untuk latensi (hanya meredam burst). SWR memutus tradeoff itu:
/// permintaan selalu dilayani dari cache seketika, dan probe tetap jalan di
/// latar, jadi kesegaran tidak dikorbankan demi kecepatan.
const HEALTH_CACHE_TTL: std::time::Duration = std::time::Duration::from_secs(30);

/// Batas keras staleness: kalau snapshot lebih tua dari ini (mis. server
/// baru bangun lalu tak ada request selama lama), JANGAN sajikan stale —
/// probe inline (blokir) supaya klien tak pernah melihat data sangat basi.
/// 10 menit ≫ TTL, jadi hanya terpicu pada kasus tepi (idle panjang).
const HEALTH_CACHE_MAX_STALE: std::time::Duration = std::time::Duration::from_secs(600);

/// Klasifikasi umur snapshot terhadap TTL/STALE (FUNGSI MURNI → mudah diuji).
#[derive(Debug, PartialEq, Eq)]
enum CacheAge {
    /// umur < TTL: sajikan langsung, tanpa refresh.
    Fresh,
    /// TTL <= umur < MAX_STALE: sajikan langsung + refresh latar (SWR).
    Stale,
    /// umur >= MAX_STALE: terlalu basi, probe inline (blokir).
    Expired,
}

/// Umur snapshot → [`CacheAge`] untuk batas TTL/MAX_STALE eksplisit. Murni
/// (durasi masuk) supaya batas bisa diuji tanpa jam/jaringan.
fn classify_age_with(
    age: std::time::Duration,
    ttl: std::time::Duration,
    max_stale: std::time::Duration,
) -> CacheAge {
    if age < ttl {
        CacheAge::Fresh
    } else if age < max_stale {
        CacheAge::Stale
    } else {
        CacheAge::Expired
    }
}

/// Umur snapshot → [`CacheAge`] memakai batas SEM health (SWR).
fn classify_age(age: std::time::Duration) -> CacheAge {
    classify_age_with(age, HEALTH_CACHE_TTL, HEALTH_CACHE_MAX_STALE)
}

/// Query `GET /api/unified/health`. `force=1` = lewati cache, probe inline
/// (dipakai tombol "periksa ulang" di badge supaya user dapat hasil segar
/// sekarang, bukan stale-while-revalidate).
#[derive(Deserialize)]
pub struct HealthQuery {
    #[serde(default)]
    force: Option<u8>,
}

/// Probe SEMUA sumber sekarang (JoinSet paralel) dan bentuk payload-nya.
/// Dipakai baik oleh jalur inline maupun refresh latar SWR — satu sumber
/// kebenaran, tak ada duplikasi logika probe.
async fn probe_health_now(state: &UnifiedState) -> anyhow::Result<HealthOut> {
    let sources = state.aggregator.sources.clone();
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
    let rows: Vec<HealthRow> = state
        .aggregator
        .sources
        .iter()
        .filter_map(|s| by_source.remove(s.id().as_str()))
        .collect();
    if rows.is_empty() {
        // Nol baris = kegagalan internal TOTAL (agregator tanpa sumber).
        anyhow::bail!("tidak ada baris health: agregator tanpa sumber");
    }
    Ok(health_payload(&rows, now_millis()))
}

/// Probe lalu simpan ke cache (waktu probe ASLI). Dipakai jalur inline.
async fn probe_health_and_store(state: &UnifiedState) -> anyhow::Result<HealthOut> {
    let out = probe_health_now(state).await?;
    *state.health_cache.lock().await = Some((std::time::Instant::now(), out.clone()));
    Ok(out)
}

/// Jalankan SATU refresh latar (single-flight): ambil gerbang, double-check
/// cache (request lain mungkin sudah me-refresh), lalu probe + simpan.
/// Kegagalan probe hanya di-log — pemanggil sudah melayani stale, jadi
/// endpoint tetap responsif; permintaan berikutnya akan mencoba lagi.
fn spawn_health_refresh(state: Arc<UnifiedState>) {
    tokio::spawn(async move {
        let _gate = state.health_refresh_gate.lock().await;
        {
            let cache = state.health_cache.lock().await;
            if let Some((at, _)) = cache.as_ref() {
                if classify_age(at.elapsed()) == CacheAge::Fresh {
                    return; // sudah di-refresh request lain saat menunggu gerbang
                }
            }
        }
        match probe_health_and_store(&state).await {
            Ok(_) => {}
            Err(e) => tracing::warn!("refresh health latar gagal: {e:#}"),
        }
    });
}

/// GET /api/unified/health — liveness PER SUMBER (bukan liveness server).
///
/// Probe paralel (`JoinSet`) semua sumber, SATU probe per sumber, tanpa
/// fan-out tambahan. DULU tanpa cache (core `probe.rs` sengaja tak menyentuh
/// cache supaya "alive" bukan artefak cache lama); sekarang payload di-cache
/// dengan **stale-while-revalidate** ([`HEALTH_CACHE_TTL`] /
/// [`HEALTH_CACHE_MAX_STALE`]) — lihat tradeoff di doc konstanta itu.
/// `probe.rs`/core tetap tak di-cache: yang di-cache adalah SNAPSHOT HASIL
/// PROBE di server, bukan liveness adapter. Urutan keluaran = urutan
/// `all_sources()` = `SOURCE_PRIORITY` (JoinSet selesai tak berurut).
///
/// Alur: cache SEGAR → sajikan langsung; cache BASI (≥ TTL) → sajikan stale
/// seketika + refresh latar (single-flight, dedupe lewat gerbang); cache
/// sangat basi (≥ MAX_STALE) atau kosong → probe inline (blokir) supaya klien
/// tak pernah melihat data tua. `?force=1` memaksa probe inline.
///
/// Status: SELALU 200 selama ada baris — partial health (sebagian sumber
/// mati) tetap 200 dengan `healthy < total`. Sumber mati BUKAN 502. Hanya
/// nol baris yang error.
async fn u_health(State(state): State<Arc<crate::routes::AppState>>, Query(q): Query<HealthQuery>) -> Res<HealthOut> {
    let state = state.unified.clone();
    let force = q.force.is_some_and(|v| v != 0);
    if !force {
        // Jalur cepat: baca cache sekali.
        let snapshot = {
            let cache = state.health_cache.lock().await;
            cache
                .as_ref()
                .map(|(at, out)| (classify_age(at.elapsed()), out.clone()))
        };
        match snapshot {
            Some((CacheAge::Fresh, out)) => return Ok(Json(out)),
            Some((CacheAge::Stale, out)) => {
                // Serve-stale: balas SEGERA, refresh di latar. Gerbang
                // single-flight mencegah N request basi = N probe.
                spawn_health_refresh(state);
                return Ok(Json(out));
            }
            // Expired atau belum ada: jatuh ke probe inline di bawah.
            _ => {}
        }
    }
    // Probe inline (blokir): cache kosong / sangat basi / `?force=1`.
    // Gerbang tetap dipakai supaya burst bersamaan tidak menumpuk probe.
    let _gate = state.health_refresh_gate.lock().await;
    if !force {
        let cache = state.health_cache.lock().await;
        if let Some((at, out)) = cache.as_ref() {
            if classify_age(at.elapsed()) != CacheAge::Expired {
                return Ok(Json(out.clone()));
            }
        }
    }
    match probe_health_and_store(&state).await {
        Ok(out) => Ok(Json(out)),
        Err(e) => Err(AppError::new(e)),
    }
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

/// Detail series + daftar chapter UNION lintas sumber. `handle` =
/// "sumber:native_id".
/// Query opsional `last_source` (mis. "kiryuu") = sumber terakhir yang dibaca
/// client: dicoba LEBIH DULU sebelum sumber dari handle (sticky source,
/// keputusan Q4/8 plan cross-source fallback) — core `series_resolve_pref`.
///
/// Daftar chapter = UNION semua sumber yang punya series dengan judul sama
/// (core `series_merged`), jadi episode eksklusif sumber lain ikut tampil.
/// Tiap baris membawa `source` + `handle` sumber PEMILIK chapter itu.
#[derive(Deserialize)]
pub struct SeriesQuery {
    last_source: Option<String>,
}

/// Cache respons `/api/unified/series/{handle}`.
///
/// Yang di-cache adalah **respons JSON final** (bukan potongan), jadi
/// `representative_source`, `manga.last_chapter` (ceiling), dan daftar union
/// tersimpan PERSIS seperti yang dihitung dari 4 sumber. Ceiling tetap
/// dipertahankan: nilai lama disajikan maksimal `SERIES_CACHE_TTL`, lalu
/// dihitung ulang penuh (union 4 sumber) saat refresh.
///
/// Kenapa perlu: `series_merged` = resolve primary (fase A) + fan-out 3 sumber
/// (fase B) berurutan. Di host kecil, 12 request bersamaan untuk handle sama
/// = 12 fan-out identik → semua saling rebut CPU → melewati budget 15 s → 502.
/// Dengan cache + single-flight, burst itu jadi SATU fan-out.
const SERIES_CACHE_TTL: std::time::Duration = std::time::Duration::from_secs(300);
/// Batas keras staleness: kalau snapshot lebih tua dari ini (mis. server baru
/// bangun lalu tak ada request selama lama), JANGAN sajikan stale — hitung
/// inline (blokir) supaya klien tak pernah melihat data sangat basi.
/// 10 menit ≫ TTL, jadi hanya terpicu pada kasus tepi (idle panjang).
const SERIES_CACHE_MAX_STALE: std::time::Duration = std::time::Duration::from_secs(600);
const SERIES_CACHE_MAX: usize = 256;

type SeriesCache = std::collections::HashMap<String, (std::time::Instant, serde_json::Value)>;

/// Kunci cache: handle + last_source (sticky source mengubah hasil union
/// primary, jadi tidak boleh berbagi entri).
fn series_key(handle: &str, last_source: Option<&str>) -> String {
    format!("{handle}\u{1}{}", last_source.unwrap_or(""))
}

/// Gerbang single-flight PER HANDLE: N request bersamaan pada handle sama
/// hanya menembak fan-out SEKALI; sisanya menunggu lalu membaca cache.
fn series_gate(
    gates: &std::sync::Mutex<std::collections::HashMap<String, Arc<tokio::sync::Mutex<()>>>>,
    key: &str,
) -> Arc<tokio::sync::Mutex<()>> {
    let mut guard = gates.lock().unwrap_or_else(|e| e.into_inner());
    guard
        .entry(key.to_string())
        .or_insert_with(|| std::sync::Arc::new(tokio::sync::Mutex::new(())))
        .clone()
}

/// Baca cache + klasifikasi umur (SWR). `None` = belum ada entri.
/// Miss memory → fallback disk (`epp-series/`): hit disk dipromosikan ke
/// memory (biaya berikutnya ~0) dan langsung dilayani (Fresh/Stale) — hanya
/// radioired/absen yang dipaksa hitung inline. Urutan: memory dulu (50x lebih
/// cepat dari fs), lalu disk.
fn series_cache_read(cache: &std::sync::Mutex<SeriesCache>, key: &str) -> Option<(CacheAge, serde_json::Value)> {
    {
        let guard = cache.lock().ok()?;
        if let Some((at, out)) = guard.get(key) {
            let age = classify_age_with(at.elapsed(), SERIES_CACHE_TTL, SERIES_CACHE_MAX_STALE);
            return Some((age, out.clone()));
        }
    }
    let (age, out) = series_disk_read(key)?;
    if let Ok(mut guard) = cache.lock() {
        guard.insert(key.to_string(), (std::time::Instant::now(), out.clone()));
    }
    Some((age, out))
}

/// Direktori persistensi disk respons series FINAL. Subdir sendiri (`epp-series/`)
/// supaya tidak bercampur file cache core (`series___...json`) yang dikelola
/// aggregator dengan format/umur berbeda. Tujuan: setelah restart server (cache
/// memory kosong), hit pertama sebuah handle dibalas dari disk (~ms) alih-alih
/// mengulang union 4-sumber penuh (2-5s).
fn series_disk_dir() -> std::path::PathBuf {
    users_dir().join("cache").join("epp-series")
}

fn series_disk_path(key: &str) -> std::path::PathBuf {
    let safe: String = key
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == '.' {
                c
            } else {
                '_'
            }
        })
        .collect();
    series_disk_dir().join(safe)
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Tulis respons series final ke disk (atomic tmp+rename). Best-effort:
/// kegagalan disk dibuang — cache memory tetap berfungsi tanpa itu.
fn series_disk_write(key: &str, out: &serde_json::Value) {
    let dir = series_disk_dir();
    if std::fs::create_dir_all(&dir).is_err() {
        return;
    }
    let path = series_disk_path(key);
    let tmp = dir.join(format!(".tmp-{}-{}", std::process::id(), now_ms()));
    let payload = (now_ms(), out);
    let r = std::fs::write(&tmp, serde_json::to_vec(&payload).unwrap_or_default())
        .and_then(|_| std::fs::rename(&tmp, &path));
    if r.is_err() {
        let _ = std::fs::remove_file(&tmp);
    }
}

/// Baca respons series dari disk. `None` = tidak ada / korup / terlalu basi
/// (Expired → biarkan hitung inline). Fresh/Stale dipromosikan ke memory.
fn series_disk_read(key: &str) -> Option<(CacheAge, serde_json::Value)> {
    let raw = std::fs::read_to_string(series_disk_path(key)).ok()?;
    let (at_ms, out): (u64, serde_json::Value) = serde_json::from_str(&raw).ok()?;
    let age = std::time::Duration::from_millis(now_ms().saturating_sub(at_ms));
    match classify_age_with(age, SERIES_CACHE_TTL, SERIES_CACHE_MAX_STALE) {
        CacheAge::Expired => None,
        a => Some((a, out)),
    }
}

fn series_cache_put(cache: &std::sync::Mutex<SeriesCache>, key: String, out: serde_json::Value) {
    if let Ok(mut guard) = cache.lock() {
        if guard.len() >= SERIES_CACHE_MAX && !guard.contains_key(&key) {
            if let Some(old) = guard
                .iter()
                .min_by_key(|(_, (at, _))| *at)
                .map(|(k, _)| k.clone())
            {
                guard.remove(&old);
            }
        }
        guard.insert(key.clone(), (std::time::Instant::now(), out.clone()));
    }
    series_disk_write(&key, &out);
}

// ------------------------------------------- single-flight PER CHAPTER (baca)

/// Gerbang single-flight per CHAPTER: `handle` + nomor ternormalisasi.
type ChapterGates =
    std::sync::Mutex<std::collections::HashMap<String, Arc<tokio::sync::Mutex<()>>>>;

/// Cache respons chapter FINAL per key. Tanpa ini single-flight hanya
/// mendedupe request yang TUMPANG WAKTU: request ke-17 yang datang 1 ms
/// setelah fan-out pertama selesai akan menghitung ulang. Cache pendek ini
/// yang membuat burst beruntun tetap satu fan-out, dan juga yang membuat
/// double-check setelah gerbang bermakna.
type ChapterCache =
    std::collections::HashMap<String, (std::time::Instant, serde_json::Value)>;

/// TTL respons chapter. Pendek dengan sengaja: halaman chapter nyaris statis
/// (gambar + prev/next), tapi chapter yang baru terbit bisa berubah susunan
/// halamannya dalam hitungan menit — 120 s cukup untuk meredam burst tanpa
/// membuat user melihat daftar gambar basi.
const CHAPTER_CACHE_TTL: std::time::Duration = std::time::Duration::from_secs(120);
const CHAPTER_CACHE_MAX: usize = 128;

/// Kunci gerbang/cache: handle series + nomor yang sudah dinormalkan
/// (`chapter_number_key`), supaya "04" dan "4" = SATU chapter. Handle ikut
/// jadi bagian kunci: series berbeda boleh punya nomor sama.
fn chapter_gate_key(handle: &str, number: &str) -> String {
    format!("{handle}\u{1}{}", komik_core::model::chapter_number_key(number))
}

/// Ambil gerbang untuk satu chapter — cermin `series_gate`.
fn chapter_gate(gates: &ChapterGates, handle: &str, number: &str) -> Arc<tokio::sync::Mutex<()>> {
    let key = chapter_gate_key(handle, number);
    let mut guard = gates.lock().unwrap_or_else(|e| e.into_inner());
    guard
        .entry(key)
        .or_insert_with(|| Arc::new(tokio::sync::Mutex::new(())))
        .clone()
}

fn chapter_cache_get(
    cache: &std::sync::Mutex<ChapterCache>,
    key: &str,
) -> Option<(CacheAge, serde_json::Value)> {
    let guard = cache.lock().ok()?;
    let (at, out) = guard.get(key)?;
    let age = classify_age_with(at.elapsed(), CHAPTER_CACHE_TTL, CHAPTER_CACHE_TTL);
    Some((age, out.clone()))
}

fn chapter_cache_put(
    cache: &std::sync::Mutex<ChapterCache>,
    key: String,
    out: serde_json::Value,
) {
    if let Ok(mut guard) = cache.lock() {
        if guard.len() >= CHAPTER_CACHE_MAX && !guard.contains_key(&key) {
            if let Some(old) = guard
                .iter()
                .min_by_key(|(_, (at, _))| *at)
                .map(|(k, _)| k.clone())
            {
                guard.remove(&old);
            }
        }
        guard.insert(key, (std::time::Instant::now(), out));
    }
}

/// Jalankan `fanout` SEKALI untuk N request paralel pada chapter yang sama.
///
/// Pola sama dengan `series_gate`: ambil gerbang per key, lock, lalu
/// double-check cache (request yang menunggu mungkin mendapat hasil dari
/// pemenang gerbang). Kegagalan tidak di-cache — gerbang dilepas oleh drop
/// guard sehingga request berikutnya boleh mencoba lagi.
///
/// Double-check WAJIB ada di DALAM helper ini, bukan hanya di closure
/// pemanggil: mutex hanya MENYERIALKAN, ia tidak mendedupe. Tanpa cek di sini,
/// 16 task yang menunggu gerbang akan tetap menjalankan `fanout` satu per satu
/// setelah gerbang bebas (terbukti: test `chapter_paralel_sama_hanya_satu_fanout`
/// membaca 16, bukan 1). Karena itu `cached` disuntikkan sebagai parameter:
/// helper membaca ulang cache setelah memperoleh gerbang, sebelum memutuskan
/// memanggil `fanout`.
async fn chapter_single_flight<F, Fut, C>(
    gates: &ChapterGates,
    handle: &str,
    number: &str,
    cached: C,
    fanout: F,
) -> Result<Value, AppError>
where
    C: Fn() -> Option<Value>,
    F: FnOnce() -> Fut,
    Fut: std::future::Future<Output = Result<Value, AppError>>,
{
    let gate = chapter_gate(gates, handle, number);
    let _guard = gate.lock().await;
    // Request yang menunggu gerbang: kalau pemenang sudah mengisi cache,
    // pakai hasilnya dan JANGAN fan-out lagi. Inilah dedup sesungguhnya.
    if let Some(hit) = cached() {
        return Ok(hit);
    }
    fanout().await
}

/// Bentuk JSON final respons series dari hasil union (dipakai jalur inline
/// dan refresh latar SWR — satu sumber kebenaran, tak ada duplikasi logika).
fn build_series_json(merged: &komik_core::aggregator::MergedSeries) -> serde_json::Value {
    let manga = MangaOut::from(&merged.manga);
    let chapters: Vec<ChapterRow> = merged.chapters.iter().map(ChapterRow::from).collect();
    json!({
        "manga": manga,
        "chapters": chapters,
        // Sumber manga PRIMARY (metadata tidak berubah oleh union).
        "source": merged.manga.source.as_str(),
        // Sumber representatif: chapter numerik utama terbesar (tie
        // SOURCE_PRIORITY); null kalau tak ada chapter numerik.
        "representative_source": merged
            .representative_source
            .as_ref()
            .map(|s| s.as_str().to_string()),
        // Sumber yang gagal saat pengumpulan union (partial failure).
        "failed_sources": merged
            .failed
            .iter()
            .map(|(s, _)| s.as_str().to_string())
            .collect::<Vec<_>>(),
        "from_cache": merged.from_cache,
    })
}

/// Hitung union 4 sumber dengan pagar budget total. Dipakai jalur inline
/// (Expired/kosong) dan refresh latar SWR.
async fn compute_series(
    state: &UnifiedState,
    handle: &str,
    last_source: Option<&str>,
) -> Result<serde_json::Value, AppError> {
    let merged = match tokio::time::timeout(
        UNIFIED_REQUEST_BUDGET,
        state.aggregator.series_merged(
            handle,
            SERIES_CHAPTER_LIMIT,
            None,
            last_source,
        ),
    )
    .await
    {
        Ok(r) => r.map_err(classify_core_err)?,
        Err(_) => return Err(budget_err("series")),
    };
    Ok(build_series_json(&merged))
}

/// Jalankan SATU refresh latar per handle (single-flight): ambil gerbang,
/// double-check (request lain mungkin sudah me-refresh), lalu hitung ulang
/// union + simpan ke cache. Kegagalan hanya di-log — pemanggil sudah
/// melayani stale, jadi endpoint tetap responsif.
fn spawn_series_refresh(state: Arc<UnifiedState>, handle: String, last_source: Option<String>, key: String) {
    tokio::spawn(async move {
        let gate = series_gate(&state.series_gates, &key);
        let _guard = gate.lock().await;
        {
            if let Some((CacheAge::Fresh, _)) = series_cache_read(&state.series_cache, &key) {
                return; // sudah di-refresh request lain saat menunggu gerbang
            }
        }
        let _permit = match state.series_fanout_permits.acquire().await {
            Ok(p) => p,
            Err(_) => return,
        };
        match compute_series(&state, &handle, last_source.as_deref()).await {
            Ok(out) => series_cache_put(&state.series_cache, key, out),
            Err(_) => tracing::warn!("refresh series latar gagal (dibiarkan, stale tetap dilayani)"),
        }
    });
}

/// GET /api/unified/series/{handle} — detail + daftar chapter UNION lintas
/// sumber. Respons di-cache (memory) dengan **stale-while-revalidate**:
/// umur < TTL → sajikan cache seketika; ≥ TTL dan < MAX_STALE → sajikan
/// stale seketika + refresh latar (single-flight); ≥ MAX_STALE / kosong →
/// hitung inline. Ini yang membuat kunjungan ulang series ~milidetik,
/// bukan 8-12 s (union 4 sumber, ~86% biaya untuk <1% chapter ekstra).
async fn u_series(State(state): State<Arc<crate::routes::AppState>>, Path(handle): Path<String>, Query(q): Query<SeriesQuery>) -> Res<Value> {
    validate_handle(&handle)?;
    let unified = state.unified.clone();
    let key = series_key(&handle, q.last_source.as_deref());

    // 1. SWR: segar -> seketika; basi -> sajikan stale + refresh latar;
    //    sangat basi / belum ada -> hitung inline di bawah.
    if let Some((age, hit)) = series_cache_read(&unified.series_cache, &key) {
        match age {
            CacheAge::Fresh => return Ok(Json(hit)),
            CacheAge::Stale => {
                spawn_series_refresh(unified, handle, q.last_source, key);
                return Ok(Json(hit));
            }
            CacheAge::Expired => {}
        }
    }

    // 2. Single-flight per handle: yang menang gerbang menghitung, sisanya
    //    menunggu lalu membaca cache yang baru diisi (bukan fan-out sendiri).
    let gate = series_gate(&unified.series_gates, &key);
    let _guard = gate.lock().await;

    // Double-check: bisa jadi request lain mengisi cache saat kita menunggu.
    if let Some((CacheAge::Fresh, hit)) = series_cache_read(&unified.series_cache, &key) {
        return Ok(Json(hit));
    }

    // 3. Batasi fan-out serentak lintas handle (antre, bukan tolak).
    let _permit = unified
        .series_fanout_permits
        .acquire()
        .await
        .map_err(|_| AppError::new(anyhow::anyhow!("gerbang fan-out series ditutup")))?;

    // 4. Hitung union penuh (budget total di dalam `compute_series`).
    let out = compute_series(&unified, &handle, q.last_source.as_deref()).await?;
    series_cache_put(&unified.series_cache, key, out.clone());
    Ok(Json(out))
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

/// Galat saat budget request unified habis. Sengaja 502 (upstream), bukan
/// 504: kontrak frontend sudah mengenal 502 + hint "sumber lambat".
fn budget_err(op: &str) -> AppError {
    AppError::new(anyhow::anyhow!(
        "permintaan {op} melebihi batas {} detik (sumber lambat/tidak merespons)",
        UNIFIED_REQUEST_BUDGET.as_secs()
    ))
}

/// Halaman chapter lintas sumber: {title, number, source, images, prev, next,
/// switched_from, note}. SATU panggilan `read_chapter_any`: kalau chapter
/// tidak ada di sumber handle (atau gambarnya kosong), core ambil dari sumber
/// lain yang punya judul sama; `prev`/`next` objek {number,source,handle}
/// selalu dari sumber yang MELAYANI.
/// Header `Link: rel=preload` sengaja DIHAPUS. A/B kontrol-valid di Chromium
/// membuktikan header pada respons `fetch()` JSON itu INERT: selisih
/// first-img-minus-API 43.5 ms (tanpa) vs 44 ms (dengan), semua `/img`
/// ber-initiator `img`. Kontrak handler kembali `Res<Value>` seperti lainnya.
async fn u_chapter(
    State(state): State<Arc<crate::routes::AppState>>,
    Path((handle, number)): Path<(String, String)>,
) -> Res<Value> {
    validate_handle(&handle)?;
    let state = state.unified.clone();
    // Budget total: series_resolve + read_chapter_any berurutan, masing-masing
    // bisa fallback antar sumber. Tanpa batas, dua jalur ini bisa menumpuk
    // timeout jauh melewati 6 s per sumber.
    match tokio::time::timeout(UNIFIED_REQUEST_BUDGET, u_chapter_inner(state, handle, number)).await {
        Ok(r) => r,
        Err(_) => Err(budget_err("chapter")),
    }
}


async fn u_chapter_inner(state: Arc<UnifiedState>, handle: String, number: String) -> Res<Value> {
    // TODO(BE-2): prefetch chapter N+1 — butuh kebijakan eviction + backpressure
    // sebelum aktif (risiko thundering herd).
    let key = chapter_gate_key(&handle, &number);

    // 1. Cache segar -> seketika. Burst beruntun (request ke-17 datang setelah
    //    fan-out pertama selesai) tetap satu fan-out karena cabang ini.
    if let Some((CacheAge::Fresh, hit)) = chapter_cache_get(&state.chapter_cache, &key) {
        return Ok(Json(hit));
    }

    // 2. Single-flight per chapter. Pemenang gerbang menghitung; sisanya
    //    menunggu, lalu `chapter_single_flight` membaca ulang cache SEBELUM
    //    memutuskan fan-out (itu dedup sesungguhnya — mutex hanya menyerialkan).
    //    Tanpa ini 16 request paralel = 16 fan-out: terukur komiku +32 /
    //    kiryuu +16 untuk satu chapter.
    let out = chapter_single_flight(
        &state.chapter_gates,
        &handle,
        &number,
        || {
            chapter_cache_get(&state.chapter_cache, &key)
                .filter(|(age, _)| matches!(age, CacheAge::Fresh))
                .map(|(_, hit)| hit)
        },
        || {
            let state = state.clone();
            let key = key.clone();
            let handle = handle.clone();
            let number = number.clone();
            async move {
                let out = fetch_chapter_payload(&state, &handle, &number).await?;
                chapter_cache_put(&state.chapter_cache, key, out.clone());
                Ok(out)
            }
        },
    )
    .await?;

    // `chapter_single_flight` mengembalikan `Value` MENTAH; handler yang
    // membungkusnya jadi `Json` (satu kali, di sini).
    Ok(Json(out))
}

/// Fan-out chapter sesungguhnya: SATU `read_chapter_any` + bentuk JSON final.
/// Dipisah dari `u_chapter_inner` supaya cache/gerbang di atasnya tidak
/// menduplikasi logika bentuk respons.
///
/// Mengembalikan `Value` MENTAH (bukan `Res<Value>` = `Result<Json<Value>, _>`)
/// karena pemanggilnya membungkus sendiri: lapisan cache menyimpan `Value` dan
/// handler membalas `Json`. Mengembalikan `Json` di sini membuat pemanggil
/// membungkus dua kali (`Json(Json(..))`) — itu error tipe yang sudah terjadi.
async fn fetch_chapter_payload(
    state: &UnifiedState,
    handle: &str,
    number: &str,
) -> Result<Value, AppError> {
    let out = state
        .aggregator
        .read_chapter_any(handle, number, None, SERIES_CHAPTER_LIMIT)
        .await
        .map_err(classify_core_err)?;
    // title_key + judul SERIES sudah diperoleh `read_chapter_any` saat resolve
    // (tanpa round-trip upstream tambahan). Sebelumnya kita `series_resolve`
    // dulu hanya untuk metadata ini — itu SATU resolve upstream penuh yang
    // redundan karena `read_chapter_any` resolve lagi di dalamnya. Kalau
    // gagal kosong, fallback ke judul chapter seperti sebelumnya.
    let key = match out.series_title_key.as_deref() {
        Some(k) if !k.is_empty() => k.to_string(),
        _ => title_key(&out.pages.title),
    };
    let series_title = out.series_title.as_deref().filter(|t| !t.is_empty());
    // `image_sizes` diisi dari cache /img yang sudah ada (BE-3): dimensi asli
    // direkam `img::resize_encode` saat encode sukses, keyed by upstream URL.
    // HIT → Some((w,h)); MISS → None (frontend fallback rasio 0.685). Ini
    // memperbaiki CLS residual tanpa biaya network (probe range-GET upstream
    // yang dulu sia-sia dihapus).
    let image_sizes: Vec<Option<[u32; 2]>> = out
        .pages
        .images
        .iter()
        .map(|u| crate::img::known_orig_dims(u).map(|(w, h)| [w, h]))
        .collect();
    Ok(json!({
        "title": out.pages.title,
        "number": out.pages.number,
        "source": out.pages.source.as_str(),
        "title_key": key,
        "series_title": series_title,
        "images": out.pages.images,
        "image_sizes": image_sizes,
        "prev": out.prev,
        "next": out.next,
        "switched_from": out.switched_from.as_ref().map(|s| s.as_str()),
        "note": out.note,
    }))
}

// --------------------------------------------------- unduhan PDF (rak buku)

/// Direktori unduhan: default `<users_dir>/downloads` (relatif ke CWD server =
/// D:/project/komiku-server), bisa dioverride lewat env `KOMIKU_DOWNLOADS_DIR`.
/// Di bawah `users_dir()` supaya state per-akun (`index/<username>.json`)
/// hidup berdampingan dengan `users/<username>.json`.
fn download_dir() -> std::path::PathBuf {
    std::env::var_os("KOMIKU_DOWNLOADS_DIR")
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|| users_dir().join("downloads"))
}

/// Selang sapu TTL: tiap 1 jam. Entri yang lebih tua dari 24 jam dibuang
/// (lihat `downloads::TTL_SECS`).
const SWEEP_INTERVAL: std::time::Duration = std::time::Duration::from_secs(60 * 60);

/// Satu instance store untuk seluruh proses (pola sama seperti `aggregator()`).
///
/// Tidak lagi OnceLock statis — store dipegang di [`UnifiedState`]. Sapu TTL
/// (TTL 24 jam) di-spawn sekali saat state dibuat (lihat [`UnifiedState::new`]).
fn store(state: &UnifiedState) -> anyhow::Result<Arc<DownloadStore>> {
    state
        .download_store
        .as_ref()
        .cloned()
        .map_err(|e| anyhow::anyhow!("store unduhan tidak tersedia: {e}"))
}

/// Cek boot: buka store unduhan sekali supaya direktori yang tidak bisa
/// ditulis ketahuan SAAT START, bukan saat user pertama menekan "Unduh PDF".
/// Galat dikembalikan apa adanya (tidak ditelan) agar log boot menunjuk path
/// penyebabnya. Sengaja TIDAK mematikan proses: gangguan disk unduhan tidak
/// boleh ikut mematikan fitur baca; endpoint unduhan akan membalas 500 jelas.
pub fn init_download_store(state: &UnifiedState) -> anyhow::Result<()> {
    store(state).map(|_| ())
}

/// Konkurensi pengambilan gambar per chapter (chapter biasanya 10-60 halaman).
/// Berapa gambar chapter diambil PARALEL saat merakit PDF. Kecil = puncak RAM
/// lebih rendah (byte in-flight sedikit) dengan tukar waktu. 6 → 3 menghemat
/// puncak ~separuh; di VPS kecil itu lebih berharga daripada beberapa detik.
const PAGE_CONCURRENCY: usize = 3;

/// Batas TOTAL satu unduhan PDF (resolve series + ambil semua gambar +
/// encode). Tanpa ini chapter 300 halaman bisa menahan request ~25 menit
/// (300/6 batch x 30 s); timeout per gambar tetap ada, ini pagar keseluruhan.
const DOWNLOAD_PDF_BUDGET: std::time::Duration = std::time::Duration::from_secs(120);

#[derive(Deserialize)]
struct DownloadPdfReq {
    handle: String,
    number: String,
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

/// Klien bersama untuk gambar chapter. Dulu satu Client dibuat PER GAMBAR
/// (10-60 halaman = 10-60 handshake + connection pool baru) — penyebab utama
/// PDF lambat (P1-4a). Satu client = keep-alive & pool dipakai ulang; timeout
/// tetap PER REQUEST supaya satu host macet tidak menahan seluruh batch.
/// Klien ini dipegang di [`UnifiedState::image_client`] (bukan OnceLock).
/// Batas satu gambar (termasuk baca body).
const IMAGE_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(30);

/// Ambil satu gambar chapter server-side. Host WAJIB di allowlist `hosts.rs`
/// (guard SSRF) + UA mobile + Referer host.
async fn fetch_image(client: &reqwest::Client, url: &str) -> anyhow::Result<Vec<u8>> {
    if !crate::hosts::host_allowed(url) {
        anyhow::bail!("host gambar tidak diizinkan ({url})");
    }
    // Reuse byte ASLI yang sudah ada di cache /img. Reader mengisi cache ini
    // untuk setiap halaman yang dibaca, jadi unduhan PDF chapter yang sudah
    // pernah dibuka tidak menyentuh CDN sama sekali (0 round-trip/halaman).
    // Byte-nya identik dengan yang dikirim /img, jadi PDF tetap lossless
    // untuk halaman JPEG.
    if let Some(bytes) = crate::img::cached_raw(url) {
        return Ok(bytes);
    }
    // Referer di header REQUEST (bukan client): ClientBuilder tanpa fitur
    // default tidak punya `header`.
    let resp = client
        .get(url)
        .timeout(IMAGE_TIMEOUT)
        .header(reqwest::header::REFERER, referer_for(url))
        .send()
        .await?;
    if !resp.status().is_success() {
        anyhow::bail!("HTTP {}", resp.status());
    }
    Ok(resp.bytes().await?.to_vec())
}

/// Ukuran asli (width×height) satu gambar chapter. Dibaca dari byte pertama
/// (range GET), tanpa decode penuh — murah untuk semua CDN. Dipakai reader
/// untuk reserve tinggi halaman SEBELUM decode (perbaikan CLS). `None` kalau
/// gagal dibaca (mis. host tidak diizinkan / bukan gambar).
async fn probe_image_dim(client: &reqwest::Client, url: &str) -> Option<(u32, u32)> {
    // Reuse byte mentah cache /img kalau halaman ini pernah diminta reader —
    // nol round-trip ke CDN. Kalau belum, range GET kecil.
    if let Some(bytes) = crate::img::cached_raw(url) {
        return parse_img_dims(&bytes);
    }
    if !crate::hosts::host_allowed(url) {
        return None;
    }
    let resp = client
        .get(url)
        .timeout(IMAGE_TIMEOUT)
        .header(reqwest::header::REFERER, referer_for(url))
        .header(reqwest::header::RANGE, "bytes=0-255")
        .send()
        .await
        .ok()?;
    if !resp.status().is_success() {
        return None;
    }
    parse_img_dims(&resp.bytes().await.ok()?)
}

/// Parse dimensi dari header gambar (tanpa decode penuh). Mendukung JPEG
/// (SOF0/1/2), PNG (IHDR), WebP (VP8X), dan GIF.
fn parse_img_dims(b: &[u8]) -> Option<(u32, u32)> {
    if b.starts_with(b"\xff\xd8") {
        // JPEG: scan marker sampai SOF; skip panjang segmen lain.
        let mut i = 2usize;
        while i + 9 <= b.len() {
            if b[i] != 0xff {
                i += 1;
                continue;
            }
            let m = b[i + 1];
            if (0xc0..=0xcf).contains(&m) && m != 0xc4 && m != 0xc8 && m != 0xcc {
                let h = u16::from_be_bytes([b[i + 5], b[i + 6]]) as u32;
                let w = u16::from_be_bytes([b[i + 7], b[i + 8]]) as u32;
                return Some((w, h));
            }
            if m == 0xda {
                break; // SOS: header selesai
            }
            let seg = u16::from_be_bytes([b[i + 2], b[i + 3]]) as usize;
            if seg < 2 {
                break;
            }
            i += 2 + seg;
        }
        None
    } else if b.starts_with(b"\x89PNG\r\n\x1a\n") && b.len() >= 24 {
        let w = u32::from_be_bytes([b[16], b[17], b[18], b[19]]);
        let h = u32::from_be_bytes([b[20], b[21], b[22], b[23]]);
        Some((w, h))
    } else if b.starts_with(b"RIFF")
        && b.get(8..12) == Some(b"WEBP")
        && b.len() >= 30
        && b.get(12..16) == Some(b"VP8X")
    {
        let w = 1 + u32::from_le_bytes([b[24], b[25], b[26], 0]);
        let h = 1 + u32::from_le_bytes([b[27], b[28], b[29], 0]);
        Some((w, h))
    } else if b.starts_with(b"GIF8") && b.len() >= 10 {
        let w = u16::from_le_bytes([b[6], b[7]]) as u32;
        let h = u16::from_le_bytes([b[8], b[9]]) as u32;
        Some((w, h))
    } else {
        None
    }
}

/// Probe dimensi untuk SEMUA halaman chapter, konkuren per batch, urutan
/// dipertahankan. `None` per-halaman = tidak diketahui.
///
/// Tidak lagi dipanggil dari respons chapter (lihat `u_chapter_inner`): probe
/// ini satu range-GET upstream per halaman dan 59% hasilnya `null` untuk WebP
/// lossy. Disimpan (bukan dihapus) karena masih bisa dipakai kalau `image_sizes`
/// nanti di-cache per chapter (Fix B).
#[allow(dead_code)]
async fn probe_dims(client: &reqwest::Client, urls: &[String]) -> Vec<Option<(u32, u32)>> {
    const PROBE_CONCURRENCY: usize = 8;
    let mut slots: Vec<Option<Option<(u32, u32)>>> = vec![None; urls.len()];
    for (bi, chunk) in urls.chunks(PROBE_CONCURRENCY).enumerate() {
        let mut set = tokio::task::JoinSet::new();
        for (i, url) in chunk.iter().enumerate() {
            let url = url.clone();
            let client = client.clone();
            set.spawn(async move {
                (bi * PROBE_CONCURRENCY + i, probe_image_dim(&client, &url).await)
            });
        }
        while let Some(j) = set.join_next().await {
            if let Ok((idx, dim)) = j {
                slots[idx] = Some(dim);
            }
        }
    }
    slots.into_iter().map(|s| s.unwrap_or(None)).collect()
}

/// Ambil semua gambar chapter (konkuren per batch, urutan dipertahankan).
///
/// Memori: SEMUA byte halaman ditahan sampai PDF dirakit — itu tak terhindarkan
/// karena `write_pdf_bytes` butuh seluruh set sekaligus. Yang bisa ditekan
/// adalah puncak sementara: `PAGE_CONCURRENCY` kecil membatasi berapa byte
/// in-flight pada satu waktu (terukur: 6 → +27 MB puncak di chapter 18 halaman).
async fn fetch_pages(client: &reqwest::Client, urls: &[String]) -> anyhow::Result<Vec<pdf::Page>> {
    let mut slots: Vec<Option<Vec<u8>>> = vec![None; urls.len()];
    for (batch, chunk) in urls.chunks(PAGE_CONCURRENCY).enumerate() {
        let mut set = tokio::task::JoinSet::new();
        for (i, url) in chunk.iter().enumerate() {
            let url = url.clone();
            let client = client.clone();
            let idx = batch * PAGE_CONCURRENCY + i;
            set.spawn(async move { (idx, fetch_image(&client, &url).await) });
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
            bytes: slot
                .ok_or_else(|| anyhow::anyhow!("gambar halaman {} hilang", pages.len() + 1))?,
        });
    }
    Ok(pages)
}

/// Orkestrasi generate+simpan PDF: resolve chapter lintas sumber via
/// `read_chapter_any` (gambar = `outcome.pages.images`), judul series dari
/// `series_resolve` (untuk `series_title` + `title_key`), tulis PDF ke store.
async fn generate_pdf(
    state: &UnifiedState,
    username: &str,
    handle: &str,
    number: &str,
) -> Result<DownloadEntry, AppError> {
    let series = state
        .aggregator
        .series_resolve(handle, SERIES_CHAPTER_LIMIT, None)
        .await
        .map_err(classify_core_err)?;
    let series_title = series.detail.manga.title.clone();
    let series_key = series.detail.manga.title_key.clone();

    let out = state
        .aggregator
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
    let t_fetch0 = std::time::Instant::now();
    let pages = fetch_pages(&state.image_client, &out.pages.images)
        .await
        .map_err(AppError::new)?;
    let t_fetch = t_fetch0.elapsed();
    // Encode PDF itu CPU-bound: jalankan di blocking pool supaya pagar waktu
    // DOWNLOAD_PDF_BUDGET di u_download_pdf tetap bisa memutus request,
    // bukan tertahan worker async.
    let t_enc0 = std::time::Instant::now();
    let (bytes, report) = tokio::task::spawn_blocking(move || pdf::write_pdf_bytes(&pages))
        .await
        .map_err(|e| AppError::internal(format!("task PDF gagal: {e}")))?
        .map_err(|e| AppError::internal(format!("gagal membentuk PDF: {e:#}")))?;
    let store = store(state).map_err(|e| AppError::internal(format!("{e:#}")))?;
    let entry = store
        .store_pdf(
            PdfMeta { username, handle, number, title: &out.pages.title, series_title: &series_title, title_key: &series_key, },
            bytes,
        )
        .await
        .map_err(|e| AppError::internal(format!("gagal menyimpan PDF: {e:#}")))?;
    let t_enc = t_enc0.elapsed();
    tracing::info!(
        "unduhan {} {} selesai: {} halaman ({} lossless, {} re-encode), {} byte, fetch={:?} encode={:?}",
        series_title,
        number,
        report.pages,
        report.passthrough,
        report.reencoded,
        entry.size_bytes,
        t_fetch,
        t_enc
    );
    Ok(entry)
}

/// POST /api/unified/download-pdf {handle, number}
/// -> {id, filename, title, series_title, size_bytes} (+title_key)
///
/// Butuh akun: file PDF dibagi, tapi entri index masuk ke akun pemanggil.
async fn u_download_pdf(State(state): State<Arc<crate::routes::AppState>>, headers: HeaderMap, Json(req): Json<DownloadPdfReq>) -> Res<Value> {
    let state = &state.unified;
    let username = require_user(&headers)?;
    validate_handle(&req.handle)?;
    let number = req.number.trim();
    if number.is_empty() {
        return Err(AppError::bad_request("parameter number wajib diisi"));
    }
    // Fail-fast sebelum kerja berat: kalau store tidak siap (disk tidak
    // writable), balas 500 yang jelas SEKARANG - bukan setelah fetch + encode
    // puluhan detik, dan bukan 502 "sumber lambat".
    store(state).map_err(|e| AppError::internal(format!("{e:#}")))?;
    // Pagar TOTAL (P1-4b): timeout per gambar saja tidak cukup — chapter
    // panjang bisa menumpuk puluhan batch. Batas ini mencakup resolve series,
    // semua gambar, dan encode.
    let entry = tokio::time::timeout(
        DOWNLOAD_PDF_BUDGET,
        generate_pdf(state, &username, &req.handle, number),
    )
    .await
    .map_err(|_| {
        AppError::new(anyhow::anyhow!(
            "unduhan PDF melebihi batas {} detik",
            DOWNLOAD_PDF_BUDGET.as_secs()
        ))
    })??;
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
/// -> {items:[...], total_bytes} MILIK akun.
///
/// Tidak ada `limit_bytes` lagi (limit byte dihapus, diganti TTL 24 jam).
/// `expires_at` (aditif) = epoch millis `downloaded_at + TTL`, biar web bisa
/// menampilkan sisa waktu tanpa menghitung sendiri.
async fn u_downloads(State(state): State<Arc<crate::routes::AppState>>, headers: HeaderMap) -> Res<Value> {
    let state = &state.unified;
    let username = require_user(&headers)?;
    let store = store(state).map_err(|e| AppError::internal(format!("{e:#}")))?;
    let (items, total) = store.list(&username).await;
    let ttl_ms = downloads::TTL_SECS * 1000;
    let items: Vec<Value> = items
        .into_iter()
        .map(|e| {
            let mut v = serde_json::to_value(&e).unwrap_or(Value::Null);
            if let Some(obj) = v.as_object_mut() {
                obj.insert("expires_at".into(), json!(e.downloaded_at + ttl_ms));
            }
            v
        })
        .collect();
    Ok(Json(json!({
        "items": items,
        "total_bytes": total,
    })))
}

/// GET /api/unified/downloads/{id} -> byte PDF + Content-Disposition
/// attachment.
///
/// ## Wajib akun (P1-5)
/// Sebelumnya request TANPA header dilayani selama file ada di disk — siapa
/// pun yang tahu/pewarisi id bisa mengunduh PDF akun lain. Sekarang sama
/// seperti route ber-scope akun lain: header `X-Komik-User` valid WAJIB (401
/// kalau hilang/invalid/belum terdaftar), dan id harus milik akun itu (404
/// kalau bukan) supaya keberadaan file akun lain tidak bocor.
///
/// Tidak ada lagi update LRU (`last_opened_at` dihapus; satu-satunya cap
/// waktu = `downloaded_at`, dasar TTL).
async fn u_download_file(State(state): State<Arc<crate::routes::AppState>>, headers: HeaderMap, Path(id): Path<String>) -> Result<Response, AppError> {
    let state = &state.unified;
    let username = require_user(&headers)?;
    let store = store(state).map_err(|e| AppError::internal(format!("{e:#}")))?;
    let not_found = || AppError::not_found(format!("unduhan {id} tidak ditemukan"));
    // Isolasi akun: id akun lain -> 404 (bukan 403) supaya tidak membocorkan
    // bahwa file itu ada.
    let entry = store.get(&username, &id).await.ok_or_else(not_found)?;
    let path = store.pdf_path(&id);
    let bytes = tokio::fs::read(&path).await.map_err(|e| {
        if e.kind() == std::io::ErrorKind::NotFound {
            AppError::not_found(format!("file unduhan {id} tidak ada di disk"))
        } else {
            // Galat disk NYATA (izin/IO) = 500, bukan 502 "sumber lambat".
            AppError::internal(format!("gagal membaca {}: {e}", path.display()))
        }
    })?;
    Response::builder()
        .header(header::CONTENT_TYPE, "application/pdf")
        .header(
            header::CONTENT_DISPOSITION,
            format!(
                "attachment; filename=\"{}\"",
                entry.filename.replace('"', "")
            ),
        )
        .header(header::CONTENT_LENGTH, bytes.len())
        .body(Body::from(bytes))
        .map_err(|e| AppError::new(anyhow::anyhow!("gagal membentuk respons PDF: {e}")))
}

/// DELETE /api/unified/downloads/{id} -> {deleted:true}
/// Menghapus entri MILIK akun; file fisik hilang hanya saat tak ada akun lain
/// yang menunjuknya.
async fn u_download_delete(State(state): State<Arc<crate::routes::AppState>>, headers: HeaderMap, Path(id): Path<String>) -> Res<Value> {
    let state = &state.unified;
    let username = require_user(&headers)?;
    let store = store(state).map_err(|e| AppError::internal(format!("{e:#}")))?;
    if store.delete(&username, &id).await {
        Ok(Json(json!({ "deleted": true })))
    } else {
        Err(AppError::not_found(format!("unduhan {id} tidak ditemukan")))
    }
}

/// DELETE /api/unified/downloads -> hapus SEMUA MILIK akun (modal "hapus semua").
async fn u_download_delete_all(State(state): State<Arc<crate::routes::AppState>>, headers: HeaderMap) -> Res<Value> {
    let state = &state.unified;
    let username = require_user(&headers)?;
    let store = store(state).map_err(|e| AppError::internal(format!("{e:#}")))?;
    let before = store.list(&username).await.0.len();
    let changed = store.clear_all(&username).await;
    Ok(Json(json!({ "deleted": if changed { before } else { 0 } })))
}

// ------------------------------------------------------------------ router

/// Sub-router /api/unified. Handler memakai `State<Arc<AppState>>` dan membaca
/// `state.unified` (bukan static global) — router utama menyuntikkan state
/// via `.with_state()`.
pub fn unified_routes() -> Router<Arc<crate::routes::AppState>> {
    Router::new()
        .route("/api/unified/health", get(u_health))
        .route("/api/unified/search", get(u_search))
        .route("/api/unified/catalogue", get(u_catalogue))
        .route("/api/unified/popular", get(u_popular))
        .route("/api/unified/latest", get(u_latest))
        .route("/api/unified/genres", get(u_genres))
        .route("/api/unified/series/:handle", get(u_series))
        .route("/api/unified/chapter/:handle/:number", get(u_chapter))
        // Rak buku: unduhan PDF (kontrak lane rak-buku). Limit byte +
        // eviction + settings DIHAPUS, diganti retensi TTL 24 jam.
        .route("/api/unified/download-pdf", post(u_download_pdf))
        .route(
            "/api/unified/downloads",
            get(u_downloads).delete(u_download_delete_all),
        )
        .route(
            "/api/unified/downloads/:id",
            get(u_download_file).delete(u_download_delete),
        )
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Dimensi JPEG dibaca dari SOF header tanpa decode penuh.
    #[test]
    fn parse_dims_jpeg_sof() {
        // SOF2 (progressive) 720x997
        let mut b = vec![0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46];
        b.extend_from_slice(b"IF\x00\x01\x01\x00\x00\x01\x00\x01\x00\x00");
        b.extend_from_slice(&[0xff, 0xc2, 0x00, 0x11, 0x08, 0x03, 0xe5, 0x02, 0xd0]);
        assert_eq!(parse_img_dims(&b), Some((720, 997)));
    }

    /// Dimensi PNG dibaca dari IHDR.
    #[test]
    fn parse_dims_png() {
        let mut b = b"\x89PNG\r\n\x1a\n".to_vec();
        b.extend_from_slice(&[0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
        b.extend_from_slice(&[0, 0, 2, 0, 0, 0, 3, 0, 8, 6, 0, 0, 0]);
        assert_eq!(parse_img_dims(&b), Some((512, 768)));
    }

    /// Bukan gambar → None.
    #[test]
    fn parse_dims_bukan_gambar() {
        assert_eq!(parse_img_dims(b"<html>"), None);
        assert_eq!(parse_img_dims(&[]), None);
    }

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
        let miss = classify_core_err(anyhow::anyhow!(
            "gagal ambil series komiku:6426 (komiku: tidak ada)"
        ));
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
        assert_eq!(
            out.title_key,
            komik_core::model::title_key("One Piece: Romance Dawn!")
        );
        assert_eq!(out.title_key, "one piece romance dawn");
    }

    /// Referer per-host: `https://host/path/img.jpg` -> `https://host/`.
    #[test]
    fn referer_for_host() {
        assert_eq!(
            referer_for("https://img.komiku.org/a/b.jpg"),
            "https://img.komiku.org/"
        );
        assert_eq!(
            referer_for("https://cdn.jsdelivr.net/x.jpg"),
            "https://cdn.jsdelivr.net/"
        );
        assert_eq!(referer_for("https://host"), "https://host/");
    }

    /// Gambar chapter hanya boleh dari host di allowlist `hosts.rs` (SSRF).
    #[test]
    fn host_gambar_di_allowlist() {
        assert!(crate::hosts::host_allowed("https://image2.komiku.to/a.jpg"));
        assert!(!crate::hosts::host_allowed("https://127.0.0.1/a.jpg"));
        assert!(!crate::hosts::host_allowed(
            "https://evil.example.com/a.jpg"
        ));
        assert!(
            !crate::hosts::host_allowed("http://image2.komiku.to/a.jpg"),
            "bukan https"
        );
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

    // ------------------------------------------------------- cache TTL health

    /// Batas klasifikasi umur (SWR): < TTL = Fresh; [TTL, MAX_STALE) = Stale
    /// (sajikan + refresh latar); >= MAX_STALE = Expired (probe inline).
    /// Uji batas persis supaya semantik `<` terkunci (umur == TTL = basi).
    #[test]
    fn classify_age_batas_ttl_dan_max_stale() {
        use std::time::Duration;
        assert_eq!(classify_age(Duration::ZERO), CacheAge::Fresh);
        assert_eq!(
            classify_age(HEALTH_CACHE_TTL - Duration::from_millis(1)),
            CacheAge::Fresh
        );
        assert_eq!(
            classify_age(HEALTH_CACHE_TTL),
            CacheAge::Stale,
            "umur persis TTL = basi (masuk jalur SWR)"
        );
        assert_eq!(
            classify_age(HEALTH_CACHE_MAX_STALE - Duration::from_millis(1)),
            CacheAge::Stale
        );
        assert_eq!(
            classify_age(HEALTH_CACHE_MAX_STALE),
            CacheAge::Expired,
            "umur persis MAX_STALE = terlalu basi (probe inline)"
        );
        assert_eq!(
            classify_age(HEALTH_CACHE_MAX_STALE + Duration::from_secs(60)),
            CacheAge::Expired
        );
    }

    /// Kontrak SWR: MAX_STALE HARUS > TTL (kalau tidak, jalur Stale tak pernah
    /// tercapai dan SWR mati). Dan TTL >= interval poll klien (30s) supaya
    /// poll rutin dilayani dari cache (Fresh/Stale), bukan menunggu probe.
    #[test]
    fn health_cache_ttl_mendukung_swr_pada_poll_30s() {
        use std::time::Duration;
        assert!(
            HEALTH_CACHE_MAX_STALE > HEALTH_CACHE_TTL,
            "MAX_STALE {HEALTH_CACHE_MAX_STALE:?} harus > TTL {HEALTH_CACHE_TTL:?} (jalur SWR)"
        );
        assert!(
            HEALTH_CACHE_TTL >= Duration::from_secs(30),
            "TTL {HEALTH_CACHE_TTL:?} harus >= interval poll klien 30s supaya poll rutin dilayani cache (bukan menunggu probe ~1s)"
        );
    }

    /// Kontrak SWR series: MAX_STALE HARUS > TTL (jalur Stale tak pernah
    /// tercapai kalau tidak), dan TTL 300 s ≪ MAX_STALE 600 s supaya stale
    /// hanya disajikan pada jeda re-visit normal, bukan data sangat basi.
    #[test]
    fn series_cache_ttl_mendukung_swr() {
        use std::time::Duration;
        assert!(SERIES_CACHE_MAX_STALE > SERIES_CACHE_TTL);
        assert_eq!(classify_age_with(Duration::ZERO, SERIES_CACHE_TTL, SERIES_CACHE_MAX_STALE), CacheAge::Fresh);
        assert_eq!(classify_age_with(SERIES_CACHE_TTL, SERIES_CACHE_TTL, SERIES_CACHE_MAX_STALE), CacheAge::Stale);
        assert_eq!(classify_age_with(SERIES_CACHE_MAX_STALE, SERIES_CACHE_TTL, SERIES_CACHE_MAX_STALE), CacheAge::Expired);
    }

    // ------------------------------------------------- filter tipe/status

    /// Manga sintetis untuk filter (manga_type/status diatur eksplisit).
    fn sample(tag: &str, tipe: Option<&str>, status: Option<&str>) -> Manga {
        let mut m =
            komik_core::model::Manga::new(komik_core::model::SourceId::from("komiku"), tag, tag);
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
        assert!(
            !match_filters(&a, Some("Manhua"), None),
            "tipe beda gugur"
        );
        assert!(
            !match_filters(&a, None, Some("Ongoing")),
            "status beda gugur"
        );
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
            failures: vec![(
                komik_core::model::SourceId::from("kiryuu"),
                "timeout".into(),
            )],
            sources_total: 4,
            sources_ok: 3,
            from_cache: false,
        };
        // Filter tipe=Manga -> 2 item (a, c), status Ongoing -> ya.
        let out = list_out_filtered(merged.clone(), None, Some("Manga"), None, SortMode::Latest, None);
        assert_eq!(out.items.len(), 2, "count harus jujur terhadap filter");
        assert!(out
            .items
            .iter()
            .all(|i| i.manga_type.as_deref() == Some("Manga")));
        // partial failure diteruskan apa adanya (bukan disembunyikan filter)
        assert_eq!(out.failed_sources, vec!["kiryuu".to_string()]);

        // Tanpa filter = semua item (recency core apa adanya, tidak di-rank).
        let all = list_out_filtered(merged.clone(), None, None, None, SortMode::Latest, None);
        assert_eq!(all.items.len(), 4);

        // AND: tipe=Manga + status=Ongoing -> 1 item.
        let both = list_out_filtered(merged.clone(), None, Some("manga"), Some("ongoing"), SortMode::Latest, None);
        assert_eq!(both.items.len(), 1);
        assert_eq!(both.items[0].native_id, "a");

        // `max` memotong HASIL terfilter, bukan input.
        let capped = list_out_filtered(merged.clone(), None, None, None, SortMode::Latest, Some(2));
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
        let out = list_out_filtered(merged, None, Some("Manga"), None, SortMode::Latest, None);
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
            SortMode::Latest,
            None,
        );
        assert_eq!(out0.items.len(), 0);
    }

    // ------------------------------------------------ akses file PDF (P1-5)

    fn status(err: AppError) -> u16 {
        use axum::response::IntoResponse;
        err.into_response().status().as_u16()
    }

    /// GET /downloads/{id} TANPA header WAJIB 401. Dulu cabang ini melayani
    /// file apa pun yang masih ada di disk (P1-5). Handler dipanggil langsung
    /// supaya tes tidak butuh jaringan.
    #[tokio::test]
    async fn download_file_tanpa_header_401() {
        let state = State(Arc::new(crate::routes::AppState::new()));
        let res = u_download_file(state, HeaderMap::new(), Path("0123456789abcdef".into())).await;
        let err = res.expect_err("tanpa header harus galat, bukan 200");
        assert_eq!(status(err), 401);
    }

    /// Header ada tapi tidak valid / akun belum terdaftar tetap 401.
    #[tokio::test]
    async fn download_file_header_tidak_valid_401() {
        let state = State(Arc::new(crate::routes::AppState::new()));
        let mut h = HeaderMap::new();
        h.insert("x-komik-user", "Bukan Valid!".parse().unwrap());
        let res = u_download_file(state, h, Path("0123456789abcdef".into())).await;
        let err = res.expect_err("header invalid harus galat, bukan 200");
        assert_eq!(status(err), 401);
    }

    // ------------------------------------- single-flight chapter per-chapter

    /// Gerbang chapter = PER CHAPTER, bukan per handle series: dua nomor
    /// berbeda pada series yang sama TIDAK boleh berbagi gerbang (kalau
    /// berbagi, chapter 2 harus menunggu chapter 1 selesai — antre palsu).
    #[test]
    fn chapter_gate_terpisah_per_nomor_chapter() {
        let gates = ChapterGates::default();
        let a = chapter_gate(&gates, "komiku:398792", "4");
        let b = chapter_gate(&gates, "komiku:398792", "5");
        let c = chapter_gate(&gates, "komiku:398792", "4");
        assert!(!Arc::ptr_eq(&a, &b), "chapter 4 dan 5 harus gerbang BERBEDA");
        assert!(Arc::ptr_eq(&a, &c), "chapter sama harus gerbang SAMA (single-flight)");
    }

    /// Key gerbang memakai `chapter_number_key` (normalisasi leading/trailing
    /// zero) supaya "04" dan "4" = SATU chapter, bukan dua fan-out. Handle
    /// series tetap dibedakan: series lain boleh punya nomor sama.
    #[test]
    fn chapter_gate_key_menormalkan_nomor() {
        assert_eq!(
            chapter_gate_key("komiku:398792", "04"),
            chapter_gate_key("komiku:398792", "4")
        );
        assert_eq!(
            chapter_gate_key("komiku:398792", "179.60"),
            chapter_gate_key("komiku:398792", "179.6")
        );
        assert_ne!(
            chapter_gate_key("komiku:398792", "4"),
            chapter_gate_key("komiku:999", "4")
        );
    }

    /// INTI single-flight: 16 request paralel ke chapter yang SAMA harus
    /// menghasilkan SATU fan-out. Pembeda "fan-out" vs "cache-hit" adalah
    /// panggilan upstream per request — bukan latensi (cache core bisa
    /// membuat request kedua murah walau tetap ada call).
    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn chapter_paralel_sama_hanya_satu_fanout() {
        let gates = Arc::new(ChapterGates::default());
        let hits = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        // Cache bersama: meniru `chapter_cache` sungguhan. Inilah yang membuat
        // task ke-2..16 (yang menunggu gerbang) berhenti tanpa fan-out.
        let cache = Arc::new(std::sync::Mutex::new(None::<Value>));

        let mut tasks = Vec::new();
        for _ in 0..16 {
            let gates = gates.clone();
            let hits = hits.clone();
            let cache = cache.clone();
            tasks.push(tokio::spawn(async move {
                let cache_read = cache.clone();
                chapter_single_flight(
                    &gates,
                    "komiku:398792",
                    "4",
                    move || cache_read.lock().unwrap().clone(),
                    || {
                        let hits = hits.clone();
                        let cache = cache.clone();
                        async move {
                            hits.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                            // Tahan gerbang supaya 16 task benar-benar menumpuk.
                            tokio::time::sleep(std::time::Duration::from_millis(60)).await;
                            let v = serde_json::json!({"number": "4"});
                            *cache.lock().unwrap() = Some(v.clone());
                            Ok::<Value, AppError>(v)
                        }
                    },
                )
                .await
            }));
        }
        for t in tasks {
            t.await.unwrap().expect("semua request harus dapat hasil");
        }

        assert_eq!(
            hits.load(std::sync::atomic::Ordering::SeqCst),
            1,
            "16 request paralel ke chapter SAMA harus SATU fan-out upstream"
        );
        let v = cache.lock().unwrap().clone().expect("fan-out harus jalan sekali");
        assert_eq!(v["number"], "4");
    }

    /// Chapter BERBEDA tidak boleh saling mengunci: 8 nomor berbeda, masing-
    /// masing 2 request paralel → 8 fan-out (bukan 1, bukan 16).
    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn chapter_paralel_beda_nomor_tetap_fanout_sendiri() {
        let gates = Arc::new(ChapterGates::default());
        let hits = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let cache = Arc::new(std::sync::Mutex::new(
            std::collections::HashMap::<String, Value>::new(),
        ));

        let mut tasks = Vec::new();
        for n in 0..8u32 {
            for _ in 0..2 {
                let gates = gates.clone();
                let hits = hits.clone();
                let cache = cache.clone();
                tasks.push(tokio::spawn(async move {
                    let num = n.to_string();
                    let cache_read = cache.clone();
                    let key = num.clone();
                    chapter_single_flight(
                        &gates,
                        "komiku:398792",
                        &num,
                        move || cache_read.lock().unwrap().get(&key).cloned(),
                        || {
                            let hits = hits.clone();
                            let cache = cache.clone();
                            let num = num.clone();
                            async move {
                                hits.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                                tokio::time::sleep(std::time::Duration::from_millis(40)).await;
                                let v = serde_json::json!({"number": num});
                                cache.lock().unwrap().insert(num, v.clone());
                                Ok::<Value, AppError>(v)
                            }
                        },
                    )
                    .await
                }));
            }
        }
        for t in tasks {
            t.await.unwrap().expect("semua request harus dapat hasil");
        }
        assert_eq!(
            hits.load(std::sync::atomic::Ordering::SeqCst),
            8,
            "8 chapter berbeda x 2 request = 8 fan-out (per-chapter, bukan global)"
        );
    }

    /// Kegagalan fan-out tidak boleh "membekukan" gerbang: request berikutnya
    /// tetap boleh mencoba lagi (gerbang dilepas oleh drop guard, bukan cache
    /// error permanen).
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn chapter_gate_lepas_setelah_galat() {
        let gates = Arc::new(ChapterGates::default());
        let first = chapter_single_flight(
            &gates,
            "komiku:398792",
            "4",
            || None,
            || async {
                Err::<Value, AppError>(AppError::new(anyhow::anyhow!("upstream mati")))
            },
        )
        .await;
        assert!(first.is_err(), "fan-out gagal harus diteruskan sebagai galat");

        let second = chapter_single_flight(
            &gates,
            "komiku:398792",
            "4",
            || None,
            || async { Ok::<Value, AppError>(serde_json::json!({"number": "4"})) },
        )
        .await;
        assert!(second.is_ok(), "gerbang harus dilepas setelah galat, bukan deadlock");
    }
}
