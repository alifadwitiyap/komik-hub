//! Endpoint HTTP untuk frontend.
//!
//! Frontend TIDAK pernah melihat blob terenkripsi — semua didekripsi di sini,
//! jadi React cukup mengonsumsi JSON bersih (lihat `shape`).

use axum::{
    extract::{Path, Query, State},
    http::StatusCode,
    response::{IntoResponse, Response},
    routing::get,
    Json, Router,
};
use serde::Deserialize;
use serde_json::{json, Value};
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::RwLock;

use crate::{api, crypto, unified};
use komik_core::model::title_key;

/// Cache katalog A-Z: 5.6 MB, satu-satunya panggilan yang mahal.
#[derive(Clone, Default)]
pub struct AppState {
    catalogue: Arc<RwLock<Option<(Value, std::time::Instant)>>>,
}

const CATALOGUE_TTL: Duration = Duration::from_secs(30 * 60);

/// Error -> respons JSON yang bisa dibaca frontend (bukan stack trace).
/// Klasifikasi status: 502 = sumber gagal (default), 400 = input klien
/// tidak valid, 404 = entitas tidak ada. Hint "sumber lambat" hanya utk 502
/// (QA batch a1a095e3: BUG-3 — 500/502 untuk galat klien menyesatkan).
enum ErrKind {
    Upstream,
    BadRequest,
    NotFound,
}

pub struct AppError {
    err: anyhow::Error,
    kind: ErrKind,
}

impl AppError {
    /// Error dari upstream/gagal fetch — 502 (dipakai handler lama & `?`).
    pub fn new(e: impl Into<anyhow::Error>) -> Self {
        AppError { err: e.into(), kind: ErrKind::Upstream }
    }

    /// Input klien tidak valid (validasi tangan) — 400, tanpa hint menyesatkan.
    pub fn bad_request(msg: impl Into<String>) -> Self {
        AppError { err: anyhow::anyhow!(msg.into()), kind: ErrKind::BadRequest }
    }

    /// Entitas tidak ada — 404, tanpa hint.
    pub fn not_found(msg: impl Into<String>) -> Self {
        AppError { err: anyhow::anyhow!(msg.into()), kind: ErrKind::NotFound }
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
                    Json(json!({ "error": msg, "hint": "sumber sedang lambat/menolak; coba lagi" })),
                )
                    .into_response()
            }
            ErrKind::BadRequest => (
                StatusCode::BAD_REQUEST,
                Json(json!({ "error": msg })),
            )
                .into_response(),
            ErrKind::NotFound => (
                StatusCode::NOT_FOUND,
                Json(json!({ "error": msg })),
            )
                .into_response(),
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

async fn homepage() -> Res<Value> {
    let raw = api::homepage().await?;
    let mut out = serde_json::Map::new();
    out.insert("success".into(), raw.get("success").cloned().unwrap_or(json!(true)));

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
    Ok(Json(Value::Object(out)))
}

async fn search(
    Query(q): Query<SearchQuery>,
) -> Res<Value> {
    let raw = api::search(&q.q, q.page.unwrap_or(1)).await?;
    let items = manga_list(&raw);
    Ok(Json(json!({
        "page": q.page.unwrap_or(1),
        "count": items.len(),
        "manga": items.iter().map(slim).collect::<Vec<_>>(),
    })))
}

#[derive(Deserialize)]
struct SearchQuery {
    q: String,
    page: Option<u32>,
}

async fn categories() -> Res<Value> {
    let raw = api::categories().await?;
    // buang grup kosong (mis. "berwarna" tanpa isi) supaya UI tidak menampilkan header hampa
    let groups: Vec<Value> = raw
        .get("data")
        .and_then(|d| d.as_array())
        .map(|arr| {
            arr.iter()
                .filter(|g| {
                    g.get("data")
                        .and_then(|d| d.as_array())
                        .map(|a| !a.is_empty())
                        .unwrap_or(false)
                })
                .map(|g| {
                    json!({
                        "category": g.get("category"),
                        "items": g.get("data"),
                    })
                })
                .collect()
        })
        .unwrap_or_default();
    Ok(Json(json!({ "groups": groups })))
}

async fn catalogue(State(st): State<AppState>) -> Res<Value> {
    {
        let guard = st.catalogue.read().await;
        if let Some((val, at)) = guard.as_ref() {
            if at.elapsed() < CATALOGUE_TTL {
                return Ok(Json(val.clone()));
            }
        }
    }
    let raw = api::catalogue().await?;
    // raw: { success, message, data: { "#": [...], "A": [...], ... } }
    let mut letters = serde_json::Map::new();
    if let Some(buckets) = raw.get("data").and_then(|d| d.as_object()) {
        for (letter, items) in buckets {
            let list: Vec<Value> = items
                .as_array()
                .map(|a| a.iter().map(slim).collect())
                .unwrap_or_default();
            letters.insert(letter.clone(), json!(list));
        }
    }
    let val = json!({ "letters": letters });
    *st.catalogue.write().await = Some((val.clone(), std::time::Instant::now()));
    Ok(Json(val))
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

pub fn router(state: AppState) -> Router {
    Router::new()
        .route("/img", get(crate::img::img_handler))
        .route("/api/health", get(health))
        .route("/api/homepage", get(homepage))
        .route("/api/search", get(search))
        .route("/api/categories", get(categories))
        .route("/api/catalogue", get(catalogue))
        .route("/api/series/:id", get(series))
        .route("/api/chapter/:id", get(chapter))
        // route BARU: wrapper komik-core (multi-sumber). Route lama di atas
        // tidak diubah; handler unified stateless (aggregator statis).
        .merge(unified::unified_routes())
        .with_state(state)
        .layer(
            tower_http::cors::CorsLayer::permissive(), // dev: Vite di port lain
        )
}
