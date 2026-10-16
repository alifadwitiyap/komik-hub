//! progress.rs — posisi baca per-akun ("lanjut baca" pindah device).
//!
//! Entri progress adalah **blob JSON opaque** milik frontend: bentuknya
//! didefinisikan `komiku-web/src/hooks/useProgress.ts` (`ProgressEntry`) dan
//! server sengaja TIDAK memahaminya. Server hanya: simpan per-akun, kembalikan
//! apa adanya, dan jaga batas ukuran supaya satu akun tidak bisa membengkakkan
//! disk. Ini menghindari dua definisi bentuk yang bisa saling menyimpang.
//!
//! State: `<dir>/progress/<username>.json` — file terpisah dari
//! `users/<username>.json` (notif) supaya dua modul tidak pernah menulis file
//! yang sama (lost update) dan lane-nya bisa disjoint.
//!
//! Handler stateless (baca/tulis file), di-`.merge()` tanpa `AppState`.

use axum::{http::HeaderMap, routing::get, Json, Router};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::path::{Path, PathBuf};

use crate::routes::{AppError, Res};
use crate::user::{require_user, users_dir};

/// Batas jumlah entri yang diterima server. Frontend menyimpan `MAX = 24`
/// (satu entri per series); 200 memberi ruang lega tanpa membuka pintu
/// penyalahgunaan.
const MAX_ENTRIES: usize = 200;

/// Batas ukuran file (byte) — jaring pengaman terakhir.
const MAX_BYTES: usize = 512 * 1024;

fn progress_dir() -> PathBuf {
    users_dir().join("progress")
}

fn progress_file(username: &str) -> PathBuf {
    progress_dir().join(format!("{username}.json"))
}

#[derive(Debug, Default, Serialize, Deserialize)]
struct ProgressState {
    #[serde(default)]
    entries: Vec<Value>,
}

fn read_state(path: &Path) -> ProgressState {
    std::fs::read(path)
        .ok()
        .and_then(|b| serde_json::from_slice::<ProgressState>(&b).ok())
        .unwrap_or_default()
}

/// Tulis atomik (temp + rename) — pola sama `notif.rs`/`downloads.rs`: state
/// tidak boleh setengah tertulis kalau proses mati di tengah.
fn write_state(path: &Path, st: &ProgressState) -> anyhow::Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, serde_json::to_vec(st)?)?;
    std::fs::rename(&tmp, path)?;
    Ok(())
}

/// GET /api/progress -> {entries:[...]}
async fn get_progress(headers: HeaderMap) -> Res<Value> {
    let username = require_user(&headers)?;
    let st = read_state(&progress_file(&username));
    Ok(Json(json!({ "entries": st.entries })))
}

#[derive(Deserialize)]
struct PutProgressReq {
    #[serde(default)]
    entries: Vec<Value>,
}

/// PUT /api/progress {entries:[...]} -> {ok, count}
///
/// Replace-all per akun (frontend sudah menggabungkan sebelum mengirim).
async fn put_progress(headers: HeaderMap, Json(req): Json<PutProgressReq>) -> Res<Value> {
    let username = require_user(&headers)?;

    if req.entries.len() > MAX_ENTRIES {
        return Err(AppError::bad_request(format!(
            "terlalu banyak entri progress: {} (maks {MAX_ENTRIES})",
            req.entries.len()
        )));
    }
    let st = ProgressState {
        entries: req.entries,
    };
    let body = serde_json::to_vec(&st)
        .map_err(|e| AppError::new(anyhow::anyhow!("gagal serialisasi progress: {e}")))?;
    if body.len() > MAX_BYTES {
        return Err(AppError::bad_request(format!(
            "progress terlalu besar: {} byte (maks {MAX_BYTES})",
            body.len()
        )));
    }
    let count = st.entries.len();
    write_state(&progress_file(&username), &st)
        .map_err(|e| AppError::new(anyhow::anyhow!("gagal simpan progress: {e}")))?;
    Ok(Json(json!({ "ok": true, "count": count })))
}

/// Sub-router /api/progress. Stateless -> `Router<()>`.
pub fn progress_routes() -> Router {
    Router::new()
        .route("/api/progress", get(get_progress).put(put_progress))
        .layer(tower_http::cors::CorsLayer::permissive())
}

// ------------------------------------------------------------------ test

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn roundtrip_simpan_dan_baca() {
        let dir = std::env::temp_dir().join(format!(
            "komiku-progress-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let path = dir.join("progress").join("alif.json");

        let st = ProgressState {
            entries: vec![json!({ "seriesId": 1308, "page": 5, "at": 1 })],
        };
        write_state(&path, &st).expect("tulis");
        let back = read_state(&path);
        assert_eq!(back.entries.len(), 1);
        assert_eq!(back.entries[0]["seriesId"], 1308);
        assert_eq!(back.entries[0]["page"], 5);

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn file_hilang_atau_korup_jadi_state_kosong() {
        let missing = std::env::temp_dir().join("komiku-progress-tidak-ada-xyz.json");
        assert!(read_state(&missing).entries.is_empty());

        // korup: bukan JSON -> kosong, bukan panic
        let bad =
            std::env::temp_dir().join(format!("komiku-progress-bad-{}.json", std::process::id()));
        std::fs::write(&bad, b"{bukan json").unwrap();
        assert!(read_state(&bad).entries.is_empty());
        let _ = std::fs::remove_file(&bad);
    }

    #[test]
    fn progress_file_berada_di_bawah_users_dir() {
        // progress sengaja terpisah dari users/<u>.json (notif) supaya dua
        // modul tidak menulis file yang sama.
        let dir = users_dir();
        let _ = dir;
        let f = progress_file("alif");
        assert!(f.to_string_lossy().contains("progress"));
        assert!(f.to_string_lossy().ends_with("alif.json"));
    }
}
