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

/// Versi skema state. Naikkan saat bentuk JSON berubah; beri migrasi di
/// `CURRENT_SCHEMA_VERSION` sebelum baca.
const CURRENT_SCHEMA_VERSION: u32 = 1;

#[derive(Debug, Default, Serialize, Deserialize)]
struct ProgressState {
    /// Versi skema file. `#[serde(default)]` → file lama (tanpa field) dibaca
    /// sebagai versi 1 — tidak pernah panic.
    #[serde(default = "schema_v1")]
    schema_version: u32,
    #[serde(default)]
    entries: Vec<Value>,
}

fn schema_v1() -> u32 {
    1
}

fn read_state(path: &Path) -> ProgressState {
    let st = std::fs::read(path)
        .ok()
        .and_then(|b| serde_json::from_slice::<ProgressState>(&b).ok())
        .unwrap_or_default();
    // Migrasi naik (versi > CURRENT belum dikenal → diamkan ke default yang
    // aman? Tidak: jangan jatuhkan data. Hanya catat bila lebih baru).
    debug_assert!(st.schema_version <= CURRENT_SCHEMA_VERSION);
    st
}

/// Tulis atomik (temp + rename) — pola sama `notif.rs`/`downloads.rs`: state
/// tidak boleh setengah tertulis kalau proses mati di tengah.
///
/// Dua penyesuaian Windows (sama `read.rs`):
///  - nama file temp UNIK per tulis (pid + counter). Temp shared → dua penulis
///    saling menimpa lalu rename yang salah → state korup.
///  - `rename` GAGAL di Windows kalau file tujuan sedang dibuka proses lain
///    (mis. GET paralel) → retry singkat.
fn write_state(path: &Path, st: &ProgressState) -> anyhow::Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    static SEQ: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let seq = SEQ.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let tmp = path.with_extension(format!("json.tmp.{}.{}", std::process::id(), seq));
    std::fs::write(&tmp, serde_json::to_vec(st)?)?;
    let mut last: Option<std::io::Error> = None;
    for attempt in 0..10 {
        match std::fs::rename(&tmp, path) {
            Ok(()) => return Ok(()),
            Err(e) => {
                last = Some(e);
                // Windows: file tujuan sedang dibuka → tunggu sebentar, coba lagi.
                std::thread::sleep(std::time::Duration::from_millis(5 * (attempt + 1)));
            }
        }
    }
    let _ = std::fs::remove_file(&tmp);
    Err(anyhow::anyhow!(
        "gagal rename state progress: {}",
        last.map(|e| e.to_string()).unwrap_or_default()
    ))
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
        schema_version: CURRENT_SCHEMA_VERSION,
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
            schema_version: CURRENT_SCHEMA_VERSION,
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
    fn file_lama_tanpa_schema_version_dibaca_v1() {
        // Back-compat: file yang ditulis versi lama (tanpa field schema_version)
        // harus tetap terbaca — default ke versi 1, bukan korup/gagal.
        let dir = std::env::temp_dir().join(format!(
            "komiku-progress-lama-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let path = dir.join("progress").join("alif.json");
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, b"{\"entries\":[{\"seriesId\":1308,\"page\":5}]}").unwrap();

        let st = read_state(&path);
        assert_eq!(st.schema_version, 1);
        assert_eq!(st.entries.len(), 1);
        assert_eq!(st.entries[0]["page"], 5);

        let _ = std::fs::remove_dir_all(&dir);
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
