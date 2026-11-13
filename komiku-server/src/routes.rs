//! Endpoint HTTP untuk frontend.
//!
//! Frontend TIDAK pernah melihat blob terenkripsi — semua didekripsi di sini,
//! jadi React cukup mengonsumsi JSON bersih (lihat `shape`).

use axum::{
    body::Body,
    extract::{Path, Query},
    http::{header, HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::get,
    Json, Router,
};
use serde::Deserialize;
use serde_json::{json, Value};
use std::sync::Arc;

use crate::{api, crypto, unified};
use komik_core::model::title_key;

/// `unified` = state terpusat untuk semua handler `/api/unified/*` (aggregator,
/// caches, gerbang single-flight, semaphore fan-out, store unduhan) — dipakai
/// via axum `State` extractor, bukan OnceLock statis lagi.
#[derive(Clone)]
pub struct AppState {
    pub unified: Arc<unified::UnifiedState>,
}

impl AppState {
    pub fn new() -> Self {
        AppState {
            unified: Arc::new(unified::UnifiedState::new()),
        }
    }
}

impl Default for AppState {
    fn default() -> Self {
        Self::new()
    }
}

/// Hitung request user. Probe healthcheck TIDAK dihitung supaya angka
/// `/api/stats` tidak bias oleh container yang mengecek dirinya sendiri.
async fn count_request(
    req: axum::extract::Request,
    next: axum::middleware::Next,
) -> axum::response::Response {
    let p = req.uri().path();
    let is_probe = p == "/healthz" || p == "/api/health" || p == "/api/stats";
    let start = std::time::Instant::now();
    let resp = next.run(req).await;
    if !is_probe {
        crate::resilience::stats::REQUESTS
            .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        crate::resilience::stats::record_latency(start.elapsed().as_millis() as u64);
    }
    resp
}

/// `/api/stats` — angka runtime, TERPISAH dari `/healthz`.
///
/// Kenapa terpisah: `/healthz` dipanggil healthcheck container tiap ~30 s,
/// jadi kalau counter ikut dihitung di sana angkanya bias oleh probe sendiri.
/// Endpoint ini hanya menghitung request user sungguhan.
async fn stats() -> Res<Value> {
    Ok(Json(crate::resilience::stats::snapshot()))
}

/// Error -> respons JSON yang bisa dibaca frontend (bukan stack trace).
/// Klasifikasi status: 502 = sumber gagal (default), 500 = galat internal
/// server (disk/IO/encoding), 400 = input klien tidak valid, 404 = entitas
/// tidak ada, 401 = belum terautentikasi. Hint "sumber lambat" hanya utk 502
/// (QA batch a1a095e3: BUG-3 — 500/502 untuk galat klien menyesatkan; QA
/// P0-1: galat disk tidak boleh jadi 502 "sumber lambat").
#[derive(Debug)]
enum ErrKind {
    Upstream,
    Internal,
    BadRequest,
    NotFound,
    Unauthorized,
}

pub struct AppError {
    err: anyhow::Error,
    kind: ErrKind,
}

impl std::fmt::Display for AppError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{:#}", self.err)
    }
}

impl std::fmt::Debug for AppError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("AppError")
            .field("kind", &self.kind)
            .field("err", &self.err)
            .finish()
    }
}

impl AppError {
    /// Error dari upstream/gagal fetch — 502 (dipakai handler lama & `?`).
    pub fn new(e: impl Into<anyhow::Error>) -> Self {
        AppError {
            err: e.into(),
            kind: ErrKind::Upstream,
        }
    }

    /// Galat di sisi server sendiri (disk penuh/tidak writable, gagal
    /// encode PDF, state store rusak) — 500 tanpa hint "sumber lambat":
    /// upstream tidak bisa disalahkan, jadi jangan menyuruh user coba lagi.
    pub fn internal(msg: impl Into<String>) -> Self {
        AppError {
            err: anyhow::anyhow!(msg.into()),
            kind: ErrKind::Internal,
        }
    }

    /// Input klien tidak valid (validasi tangan) — 400, tanpa hint menyesatkan.
    pub fn bad_request(msg: impl Into<String>) -> Self {
        AppError {
            err: anyhow::anyhow!(msg.into()),
            kind: ErrKind::BadRequest,
        }
    }

    /// Entitas tidak ada — 404, tanpa hint.
    pub fn not_found(msg: impl Into<String>) -> Self {
        AppError {
            err: anyhow::anyhow!(msg.into()),
            kind: ErrKind::NotFound,
        }
    }

    /// Klien belum terautentikasi sebagai akun (header `X-Komik-User` hilang,
    /// invalid, atau akun belum terdaftar) — 401.
    pub fn unauthorized(msg: impl Into<String>) -> Self {
        AppError {
            err: anyhow::anyhow!(msg.into()),
            kind: ErrKind::Unauthorized,
        }
    }
}

impl IntoResponse for AppError {
    fn into_response(self) -> Response {
        let msg = format!("{:#}", self.err);
        match self.kind {
            ErrKind::Upstream => {
                tracing::warn!("gagal melayani request: {msg}");
                (
                    StatusCode::BAD_GATEWAY,
                    Json(
                        json!({ "error": msg, "hint": "sumber sedang lambat/menolak; coba lagi" }),
                    ),
                )
                    .into_response()
            }
            ErrKind::Internal => {
                tracing::error!("galat internal saat melayani request: {msg}");
                (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    Json(json!({ "error": msg })),
                )
                    .into_response()
            }
            ErrKind::BadRequest => {
                (StatusCode::BAD_REQUEST, Json(json!({ "error": msg }))).into_response()
            }
            ErrKind::NotFound => {
                (StatusCode::NOT_FOUND, Json(json!({ "error": msg }))).into_response()
            }
            ErrKind::Unauthorized => {
                (StatusCode::UNAUTHORIZED, Json(json!({ "error": msg }))).into_response()
            }
        }
    }
}

impl<E> From<E> for AppError
where
    E: Into<anyhow::Error>,
{
    fn from(e: E) -> Self {
        Self::new(e)
    }
}

pub type Res<T> = Result<Json<T>, AppError>;

// --- pembentukan bentuk data untuk frontend ---

/// Ambil daftar manga dari respons pencarian (`manga`) atau katalog (`data`).
fn manga_list(v: &Value) -> Vec<Value> {
    v.get("manga")
        .or_else(|| v.get("data"))
        .and_then(|d| d.as_array())
        .cloned()
        .unwrap_or_default()
}

/// Satu entri manga diringkas ke field yang dipakai UI (kartu & daftar).
/// `title_key` (normalisasi server, sama seperti unified) = identitas rak
/// favorit/sejarah — kartu Komiku lama ikut membawa supaya tombol favorit
/// tersedia di SEMUA kartu, bukan cuma kartu unified.
fn slim(m: &Value) -> Value {
    let key = m
        .get("title")
        .and_then(|t| t.as_str())
        .map(title_key)
        .unwrap_or_default();
    json!({
        "id": m.get("id"),
        "title": m.get("title"),
        "title_alt": m.get("title_alt"),
        "score": m.get("score"),
        "author": m.get("author"),
        "update_date": m.get("update_date"),
        "total_views": m.get("total_views"),
        "thumbnail": m.get("thumbnail"),
        "cover": m.get("cover"),
        "tipe": m.get("tipe").and_then(|t| t.as_array())
            .map(|a| a.iter().filter_map(|x| x.get("name")).cloned().collect::<Vec<_>>()),
        "status": m.get("statusmanga").and_then(|t| t.as_array())
            .map(|a| a.iter().filter_map(|x| x.get("name")).cloned().collect::<Vec<_>>()),
        "other": m.get("other").and_then(|t| t.as_array())
            .map(|a| a.iter().filter_map(|x| x.get("name")).cloned().collect::<Vec<_>>()),
        "title_key": key,
    })
}

fn chapter_list(v: &Value) -> Vec<Value> {
    v.as_array().cloned().unwrap_or_default()
}

// --- handler ---

/// Cache payload `/api/homepage` (dipakai bagian "Pilihan Komiku" di Home).
/// Upstream `index.komikid.org` lambat (0,25–1,5 s per hit, tanpa cache di sisi
/// kita) — TTL pendek cukup: katalog bagian berubah lambat.
const HOMEPAGE_CACHE_TTL: std::time::Duration = std::time::Duration::from_secs(120);
static HOMEPAGE_CACHE: once_cell::sync::Lazy<std::sync::Mutex<Option<(std::time::Instant, Value)>>> =
    once_cell::sync::Lazy::new(|| std::sync::Mutex::new(None));
/// Single-flight untuk refresh: saat TTL habis, hanya satu request yang
/// menembak upstream; sisanya menunggu lalu membaca cache yang baru.
static HOMEPAGE_REFRESH: once_cell::sync::Lazy<tokio::sync::Mutex<()>> =
    once_cell::sync::Lazy::new(|| tokio::sync::Mutex::new(()));
/// Tombstone negatif: waktu kegagalan upstream terakhir. Dalam cooldown
/// singkat (5 s) request short-circuit tanpa menembak upstream lagi,
/// sehingga satu kegagalan tidak memicu stampede N fetch berurutan.
const HOMEPAGE_FAIL_COOLDOWN: std::time::Duration = std::time::Duration::from_secs(5);
static HOMEPAGE_LAST_FAIL: once_cell::sync::Lazy<std::sync::Mutex<Option<std::time::Instant>>> =
    once_cell::sync::Lazy::new(|| std::sync::Mutex::new(None));

fn homepage_cached() -> Option<Value> {
    let guard = HOMEPAGE_CACHE.lock().ok()?;
    let (at, cached) = guard.as_ref()?;
    (at.elapsed() < HOMEPAGE_CACHE_TTL).then(|| cached.clone())
}

/// Payload homepage (cache + single-flight + TTL) — dipisah dari handler
/// supaya warm-up startup memakai jalur yang SAMA.
pub(crate) async fn homepage_payload() -> Result<Value, AppError> {
    if let Some(cached) = homepage_cached() {
        return Ok(cached);
    }

    // double-check di dalam gate: yang kalah balapan ikut memakai hasil leader
    let _gate = HOMEPAGE_REFRESH.lock().await;
    if let Some(cached) = homepage_cached() {
        return Ok(cached);
    }

    // Tombstone negatif: kalau upstream baru saja gagal (dalam cooldown),
    // short-circuit tanpa re-fetch — hindari stampede N fetch berurutan.
    if let Ok(guard) = HOMEPAGE_LAST_FAIL.lock() {
        if let Some(at) = guard.as_ref() {
            if at.elapsed() < HOMEPAGE_FAIL_COOLDOWN {
                return Err(AppError::new(anyhow::anyhow!(
                    "upstream homepage baru saja gagal (cooldown)"
                )));
            }
        }
    }

    let raw = match api::homepage().await {
        Ok(raw) => raw,
        Err(e) => {
            *HOMEPAGE_LAST_FAIL.lock().unwrap_or_else(|p| p.into_inner()) =
                Some(std::time::Instant::now());
            return Err(AppError::new(e));
        }
    };
    let mut out = serde_json::Map::new();
    out.insert(
        "success".into(),
        raw.get("success").cloned().unwrap_or(json!(true)),
    );

    // setiap seksi (trending/popular/latest/...) diringkas seragam
    if let Some(obj) = raw.as_object() {
        for (key, val) in obj {
            if key == "success" {
                continue;
            }
            let Some(items) = val.get("data").and_then(|d| d.as_array()) else {
                continue;
            };
            out.insert(
                key.clone(),
                json!({
                    "title": val.get("title").cloned().unwrap_or(json!(key)),
                    "more": val.get("more"),
                    "data": items.iter().map(slim).collect::<Vec<_>>(),
                }),
            );
        }
    }
    if let Ok(mut guard) = HOMEPAGE_CACHE.lock() {
        *guard = Some((std::time::Instant::now(), Value::Object(out.clone())));
    }
    Ok(Value::Object(out))
}

/// Ambil nilai header `If-None-Match` sebagai &str (kalau ada & valid).
pub(crate) fn if_none_match(headers: &HeaderMap) -> Option<&str> {
    headers.get(header::IF_NONE_MATCH).and_then(|v| v.to_str().ok())
}

/// Respons JSON dengan ETag lemah (W/"<hash-hex>" dari byte serde_json,
/// DefaultHasher — bukan crypto) + Cache-Control. Kalau `If-None-Match`
/// memuat ETag yang sama (atau `*`) -> 304 tanpa body, header tetap ada.
/// Dipakai untuk payload yang sudah di-cache supaya client bisa revalidasi.
pub(crate) fn json_with_etag<T: serde::Serialize>(
    value: &T,
    cache_control: &str,
    if_none_match: Option<&str>,
) -> Response {
    use std::collections::hash_map::DefaultHasher;
    use std::hash::{Hash, Hasher};

    let bytes = serde_json::to_vec(value).unwrap_or_else(|_| b"null".to_vec());
    let mut h = DefaultHasher::new();
    bytes.hash(&mut h);
    let etag = format!("W/\"{:016x}\"", h.finish());

    let not_modified = if_none_match
        .map(|inm| {
            let server_opaque = etag.strip_prefix("W/\"").unwrap_or(&etag[1..etag.len() - 1]);
            inm.split(',')
                .map(str::trim)
                .any(|s| {
                    if s == "*" {
                        return true;
                    }
                    // RFC 7232: If-None-Match pakai WEAK comparison — strip
                    // prefix "W/" dan kutip dari KEDUA sisi. Kalau tidak,
                    // client yang mengirim strong tag `"hash"` tak akan match
                    // server weak `W/"hash"` → 200+body, bukan 304.
                    let s_opaque = s.strip_prefix("W/\"").unwrap_or(&s[1..s.len() - 1]);
                    s_opaque == server_opaque
                })
        })
        .unwrap_or(false);

    let builder = Response::builder()
        .header(header::ETAG, &etag)
        .header(header::CACHE_CONTROL, cache_control);
    if not_modified {
        return builder
            .status(StatusCode::NOT_MODIFIED)
            .body(Body::empty())
            .expect("304 response build");
    }
    builder
        .header(header::CONTENT_TYPE, "application/json")
        .body(Body::from(bytes))
        .expect("json response build")
}

async fn homepage(headers: HeaderMap) -> Response {
    match homepage_payload().await {
        Ok(v) => json_with_etag(&v, "public, max-age=30", if_none_match(&headers)),
        Err(e) => e.into_response(),
    }
}

/// Cache pencarian `/api/search` (legacy). Sebelumnya endpoint ini menembak
/// upstream `index.komikid.org` untuk SETIAP request (baseline warm≈cold
/// 1515ms). API `api::search` hanya satu sumber — cache TTL pendek + single-flight
/// cukup: query yang sama berulang (klik chip, back/forward, retry) jadi ~ms.
const SEARCH_CACHE_TTL: std::time::Duration = std::time::Duration::from_secs(120);
/// Cap entri — cermin `SEARCH_CACHE_MAX` di unified.rs (128) supaya cache
/// pencarian legacy tidak tumbuh tanpa batas (HashMap murni, tak ada eviction).
const SEARCH_CACHE_MAX: usize = 128;
static SEARCH_CACHE: once_cell::sync::Lazy<
    std::sync::Mutex<std::collections::HashMap<String, (std::time::Instant, Value)>>,
> = once_cell::sync::Lazy::new(Default::default);
/// Single-flight: saat TTL habis hanya satu request yang menembak upstream.
static SEARCH_REFRESH: once_cell::sync::Lazy<tokio::sync::Mutex<()>> =
    once_cell::sync::Lazy::new(|| tokio::sync::Mutex::new(()));

async fn search(Query(q): Query<SearchQuery>) -> Res<Value> {
    let page = q.page.unwrap_or(1);
    let key = format!("{}:{}", q.q.trim().to_lowercase(), page);
    if let Ok(guard) = SEARCH_CACHE.lock() {
        if let Some((at, cached)) = guard.get(&key) {
            if at.elapsed() < SEARCH_CACHE_TTL {
                return Ok(Json(cached.clone()));
            }
        }
    }
    // double-check di dalam gate
    let _gate = SEARCH_REFRESH.lock().await;
    if let Ok(guard) = SEARCH_CACHE.lock() {
        if let Some((at, cached)) = guard.get(&key) {
            if at.elapsed() < SEARCH_CACHE_TTL {
                return Ok(Json(cached.clone()));
            }
        }
    }
    let raw = api::search(&q.q, page).await?;
    let items = manga_list(&raw);
    let out = json!({
        "page": page,
        "count": items.len(),
        "manga": items.iter().map(slim).collect::<Vec<_>>(),
    });
    if let Ok(mut guard) = SEARCH_CACHE.lock() {
        // Cap kasar, cermin search_cache_put di unified.rs: buang satu entri
        // paling tua kalau penuh dan key belum ada.
        if guard.len() >= SEARCH_CACHE_MAX && !guard.contains_key(&key) {
            if let Some(old) = guard
                .iter()
                .min_by_key(|(_, (at, _))| *at)
                .map(|(k, _)| k.clone())
            {
                guard.remove(&old);
            }
        }
        guard.insert(key, (std::time::Instant::now(), out.clone()));
    }
    Ok(Json(out))
}

#[derive(Deserialize)]
struct SearchQuery {
    q: String,
    page: Option<u32>,
}

async fn series(Path(id): Path<i64>) -> Res<Value> {
    let raw = api::series(id).await?;
    let mut s = raw.get("series").cloned().unwrap_or(Value::Null);
    if s.is_null() {
        return Err(AppError::not_found(format!("manga {id} tidak ditemukan")));
    }
    // identitas rak: title_key dinormalisasi server (sama seperti unified)
    // supaya halaman series Komiku lama punya tombol favorit.
    if let Some(obj) = s.as_object_mut() {
        let key = obj
            .get("title")
            .and_then(|t| t.as_str())
            .map(title_key)
            .unwrap_or_default();
        obj.insert("title_key".into(), json!(key));
    }
    // daftar chapter datang sebagai blob base64 -> didekripsi di sini
    let chapters = crypto::maybe_json(raw.get("chapter").cloned().unwrap_or(Value::Null));
    let related = crypto::maybe_json(raw.get("related").cloned().unwrap_or(Value::Null));
    Ok(Json(json!({
        "series": s,
        "chapters": chapter_list(&chapters),
        "related": chapter_list(&related),
    })))
}

async fn chapter(Path(id): Path<i64>) -> Res<Value> {
    let raw = api::chapter(id).await?;
    let ch = raw.get("chapter").cloned().unwrap_or(Value::Null);
    if ch.is_null() {
        return Err(AppError::not_found(format!("chapter {id} tidak ditemukan")));
    }
    let images = crypto::maybe_json(ch.get("image").cloned().unwrap_or(Value::Null));
    let series = raw.get("series").cloned().unwrap_or(Value::Null);
    // identitas rak untuk flow Komiku lama (kontrak sama seperti unified):
    // title_key = normalisasi judul series, series_handle = id series lama
    // (routing /manga/<id>), series_cover = sampul mentah (di-proxy saat render).
    let series_key = series
        .get("title")
        .and_then(|t| t.as_str())
        .map(title_key)
        .unwrap_or_default();
    let series_handle = series
        .get("id")
        .and_then(|i| i.as_i64())
        .map(|i| i.to_string());
    let series_cover = series
        .get("cover")
        .or_else(|| series.get("thumbnail"))
        .cloned();
    Ok(Json(json!({
        "chapter": {
            "id": ch.get("id"),
            "name": ch.get("name"),
            "number": ch.get("number"),
            "date": ch.get("date"),
            "views": ch.get("views"),
            "previous": ch.get("previous"),
            "next": ch.get("next"),
        },
        "images": chapter_list(&images),
        "series": series,
        "source": "komiku",
        "title_key": if series_key.is_empty() { Value::Null } else { json!(series_key) },
        "series_handle": series_handle,
        "series_cover": series_cover,
    })))
}

async fn health() -> Res<Value> {
    Ok(Json(json!({ "ok": true, "service": "komiku-server" })))
}

pub fn router(state: Arc<AppState>) -> Router {
    Router::new()
        .route("/api/health", get(health))
        .route("/api/stats", get(stats))
        // Diagnostik jaringan per host (allowlist-guarded). Dipakai untuk
        // memisahkan DNS vs egress vs upstream saat satu sumber "mati".
        .route("/api/debug/net", get(crate::debugnet::net_probe))
        .route("/api/homepage", get(homepage))
        .route("/api/search", get(search))
        .route("/api/series/:id", get(series))
        .route("/api/chapter/:id", get(chapter))
        // Proxy gambar ber-resize (same-origin supaya bisa di-cache service
        // worker): `?u=<url CDN>&w=<lebar>`. Lihat `img.rs`.
        .route("/img", get(crate::img::img_handler))
        // route BARU: wrapper komik-core (multi-sumber). Route lama di atas
        // tidak diubah; handler unified stateless (aggregator statis).
        .merge(unified::unified_routes())
        .with_state(state)
        .layer(axum::middleware::from_fn(count_request))
        .layer(
            tower_http::cors::CorsLayer::permissive(), // dev: Vite di port lain
        )
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::body::to_bytes;

    async fn body_json(res: Response) -> Value {
        let bytes = to_bytes(res.into_body(), usize::MAX).await.unwrap();
        serde_json::from_slice(&bytes).unwrap()
    }

    /// Galat disk/IO (P0-1) HARUS 500 tanpa hint "sumber lambat" — upstream
    /// tidak bisa disalahkan, jadi user tidak boleh disuruh "coba lagi".
    #[tokio::test]
    async fn internal_jadi_500_tanpa_hint() {
        let res = AppError::internal("disk penuh saat menulis PDF").into_response();
        assert_eq!(res.status(), StatusCode::INTERNAL_SERVER_ERROR);
        let v = body_json(res).await;
        assert_eq!(v["error"], "disk penuh saat menulis PDF");
        assert!(
            v.get("hint").is_none(),
            "500 tidak boleh membawa hint upstream"
        );
    }

    /// Default `AppError::new` tetap 502 + hint (kontrak lama tidak berubah).
    #[tokio::test]
    async fn upstream_tetap_502_dengan_hint() {
        let res = AppError::new(anyhow::anyhow!("timeout ke sumber")).into_response();
        assert_eq!(res.status(), StatusCode::BAD_GATEWAY);
        let v = body_json(res).await;
        assert!(v["hint"].as_str().is_some_and(|h| h.contains("lambat")));
    }

    /// Jalur `?` (From<E>) tetap upstream — hanya pemanggil yang memilih
    /// `AppError::internal` untuk galat server sendiri.
    #[tokio::test]
    async fn from_error_anyhow_tetap_upstream() {
        fn f() -> Result<(), AppError> {
            Err(anyhow::anyhow!("gagal fetch").into())
        }
        assert_eq!(
            f().unwrap_err().into_response().status(),
            StatusCode::BAD_GATEWAY
        );
    }

    fn etag_of(res: &Response) -> String {
        res.headers()
            .get(header::ETAG)
            .unwrap()
            .to_str()
            .unwrap()
            .to_string()
    }

    /// ETag stabil untuk payload identik, berbeda untuk payload berbeda;
    /// If-None-Match yang cocok -> 304 tanpa body.
    #[tokio::test]
    async fn etag_stabil_dan_berubah_bersama_payload() {
        let a = json!({"success": true, "latest": {"data": [1, 2, 3]}});
        let b = json!({"success": true, "latest": {"data": [1, 2, 4]}});

        let r1 = json_with_etag(&a, "public, max-age=30", None);
        let r2 = json_with_etag(&a.clone(), "public, max-age=30", None);
        let r3 = json_with_etag(&b, "public, max-age=30", None);
        assert_eq!(r1.status(), StatusCode::OK);
        let e1 = etag_of(&r1);
        let e2 = etag_of(&r2);
        let e3 = etag_of(&r3);
        assert_eq!(e1, e2, "payload identik harus ETag identik");
        assert_ne!(e1, e3, "payload berbeda harus ETag berbeda");
        assert_eq!(
            r1.headers().get(header::CACHE_CONTROL).unwrap(),
            "public, max-age=30"
        );

        // If-None-Match cocok -> 304, body kosong, ETag + Cache-Control tetap ada
        let r4 = json_with_etag(&a, "public, max-age=30", Some(&e1));
        assert_eq!(r4.status(), StatusCode::NOT_MODIFIED);
        assert_eq!(etag_of(&r4), e1);
        assert_eq!(
            r4.headers().get(header::CACHE_CONTROL).unwrap(),
            "public, max-age=30"
        );
        let bytes = to_bytes(r4.into_body(), usize::MAX).await.unwrap();
        assert!(bytes.is_empty());

        // If-None-Match tidak cocok -> 200 dengan body
        let r5 = json_with_etag(&a, "public, max-age=30", Some("W/\"deadbeef\""));
        assert_eq!(r5.status(), StatusCode::OK);
    }

    #[tokio::test]
    async fn bad_request_400_tanpa_hint() {
        let res = AppError::bad_request("q wajib").into_response();
        assert_eq!(res.status(), StatusCode::BAD_REQUEST);
        let v = body_json(res).await;
        assert!(v.get("hint").is_none());
    }
}
