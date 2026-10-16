//! user.rs — identitas akun Komik Hub (username-only, tanpa password).
//!
//! Satu username = satu akun. Username dinormalisasi (trim + lowercase) dan
//! divalidasi ketat SEBELUM dipakai sebagai nama file
//! (`<dir>/users/<username>.json`). Alfabet terbatas `[a-z0-9_-]` bukan
//! kosmetik: tanpa itu username `../../etc/passwd` keluar dari folder data.
//!
//! Semua endpoint ber-scope akun membaca header `X-Komik-User`.
//!
//! Handler stateless (baca/tulis file langsung), jadi router bisa di-`.merge()`
//! tanpa menyentuh `AppState` — pola sama seperti `notif::notif_routes()`.

use axum::{
    http::HeaderMap,
    routing::{get, post},
    Json, Router,
};
use serde::Deserialize;
use serde_json::{json, Value};
use std::path::{Path, PathBuf};

use crate::routes::{AppError, Res};

/// Panjang username: 3..=20 karakter.
const MIN_LEN: usize = 3;
const MAX_LEN: usize = 20;

/// Pesan validasi tunggal — dipakai handler `claim` (400) supaya frontend dan
/// server tidak pernah beda kalimat.
const RULE: &str =
    "username harus 3-20 karakter: huruf kecil, angka, '-' atau '_' (diawali huruf/angka)";

/// Direktori akun. `KOMIKU_USERS_DIR` menang; kalau tidak diset jatuh ke
/// `KOMIKU_NOTIF_DIR` (deploy lama sudah menaruh state di `/data`), lalu `data`.
pub fn users_dir() -> PathBuf {
    if let Some(d) = std::env::var_os("KOMIKU_USERS_DIR") {
        return PathBuf::from(d);
    }
    if let Some(d) = std::env::var_os("KOMIKU_NOTIF_DIR") {
        return PathBuf::from(d);
    }
    PathBuf::from("data")
}

/// Path state satu akun: `<dir>/users/<username>.json`.
///
/// Aman dari path traversal karena `username` sudah lolos `normalize_username`
/// (tanpa `/`, `\`, atau `.`) sebelum sampai sini.
pub fn user_file(dir: &Path, username: &str) -> PathBuf {
    dir.join("users").join(format!("{username}.json"))
}

/// Trim + lowercase + validasi. `None` = tidak valid.
///
/// Murni (tanpa tipe error) supaya pemanggil bisa memilih status: `claim`
/// membalas 400, `require_user` membalas 401.
pub fn normalize_username(raw: &str) -> Option<String> {
    let u = raw.trim().to_ascii_lowercase();
    if u.len() < MIN_LEN || u.len() > MAX_LEN {
        return None;
    }
    // byte-wise aman: semua karakter yang lolos pasti ASCII.
    if !u.as_bytes()[0].is_ascii_alphanumeric() {
        return None;
    }
    if !u
        .bytes()
        .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'_' || b == b'-')
    {
        return None;
    }
    Some(u)
}

/// Akun sudah terdaftar? (file state-nya ada)
pub fn user_exists(username: &str) -> bool {
    user_file(&users_dir(), username).is_file()
}

/// Baca `X-Komik-User`, normalisasi, pastikan akun sudah terdaftar.
///
/// Err(401) kalau header hilang / username invalid / belum terdaftar. Ketiga
/// kasus sengaja satu status: dari sisi klien semuanya berarti "belum masuk".
pub fn require_user(headers: &HeaderMap) -> Result<String, AppError> {
    let raw = headers
        .get("x-komik-user")
        .and_then(|v| v.to_str().ok())
        .unwrap_or_default();
    if raw.trim().is_empty() {
        return Err(AppError::unauthorized("header X-Komik-User wajib diisi"));
    }
    let Some(username) = normalize_username(raw) else {
        return Err(AppError::unauthorized(format!("username tidak valid — {RULE}")));
    };
    if !user_exists(&username) {
        return Err(AppError::unauthorized(format!(
            "akun '{username}' belum terdaftar — daftar dulu di /akun"
        )));
    }
    Ok(username)
}

// ------------------------------------------------------------------ handler

#[derive(Deserialize)]
struct ClaimReq {
    username: String,
}

/// POST /api/user/claim {username} -> {ok, username, created}
///
/// Daftar sekaligus masuk. `created:true` = akun baru dibuat; `false` = akun
/// sudah ada (login). Frontend memakai `created` untuk memilih arah sinkronisasi
/// (true = push rak lokal, selain itu = pull rak server). JANGAN dijadikan
/// tanpa arti — itu bagian dari kontrak.
async fn claim(Json(req): Json<ClaimReq>) -> Res<Value> {
    let username = normalize_username(&req.username)
        .ok_or_else(|| AppError::bad_request(RULE))?;

    let dir = users_dir();
    let path = user_file(&dir, &username);
    let created = !path.is_file();
    if created {
        if let Some(parent) = path.parent() {
            tokio::fs::create_dir_all(parent)
                .await
                .map_err(|e| AppError::new(anyhow::anyhow!("gagal buat dir akun: {e}")))?;
        }
        // `{}` valid: semua field State punya `#[serde(default)]`.
        tokio::fs::write(&path, b"{}")
            .await
            .map_err(|e| AppError::new(anyhow::anyhow!("gagal buat akun: {e}")))?;
        tracing::info!("user: akun baru '{username}'");
    }
    Ok(Json(json!({ "ok": true, "username": username, "created": created })))
}

/// GET /api/user/me -> {username}
///
/// Probe "username ini valid dan terdaftar?". Favorit & unduhan punya endpoint
/// sendiri (`GET /api/notif/favorites`, `GET /api/unified/downloads`) supaya
/// modul ini tidak bergantung pada store modul lain.
async fn me(headers: HeaderMap) -> Res<Value> {
    let username = require_user(&headers)?;
    Ok(Json(json!({ "username": username })))
}

// ------------------------------------------------------------------ router

/// Sub-router /api/user. Stateless -> `Router<()>`, langsung di-`.merge()`.
pub fn user_routes() -> Router {
    Router::new()
        .route("/api/user/claim", post(claim))
        .route("/api/user/me", get(me))
        .layer(tower_http::cors::CorsLayer::permissive())
}

// ------------------------------------------------------------------ test

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalize_terima_yang_valid() {
        assert_eq!(normalize_username("alif").as_deref(), Some("alif"));
        assert_eq!(normalize_username("alif_2").as_deref(), Some("alif_2"));
        assert_eq!(normalize_username("a-b-c").as_deref(), Some("a-b-c"));
        assert_eq!(normalize_username("user123").as_deref(), Some("user123"));
    }

    #[test]
    fn normalize_trim_dan_lowercase() {
        assert_eq!(normalize_username("  Alif  ").as_deref(), Some("alif"));
        assert_eq!(normalize_username("ALIF").as_deref(), Some("alif"));
        // tiga varian huruf besar/kecil = SATU akun, bukan tiga.
        assert_eq!(normalize_username("Alif"), normalize_username("ALIF"));
    }

    #[test]
    fn normalize_tolak_pendek_panjang_dan_awalan_simbol() {
        assert_eq!(normalize_username("ab"), None); // < 3
        assert_eq!(normalize_username("a"), None);
        assert_eq!(normalize_username(""), None);
        assert_eq!(normalize_username("   "), None);
        assert_eq!(normalize_username(&"a".repeat(21)), None); // > 20
        assert_eq!(normalize_username("_alif"), None); // diawali '_'
        assert_eq!(normalize_username("-alif"), None); // diawali '-'
        // 20 karakter tetap boleh
        assert!(normalize_username(&"a".repeat(20)).is_some());
    }

    #[test]
    fn normalize_tolak_path_traversal() {
        // Inilah alasan alfabet dibatasi: username jadi nama file.
        for bad in [
            "../etc/passwd",
            "../../secret",
            "a/b",
            "a\\b",
            "..",
            ".",
            "alif.json",
            "alif/../x",
            "alif\u{0}x",
            "alif x",
            "álif",
            "alif!",
        ] {
            assert_eq!(normalize_username(bad), None, "harus ditolak: {bad:?}");
        }
    }

    #[test]
    fn user_file_selalu_di_dalam_users_dir() {
        let dir = PathBuf::from("/data");
        let p = user_file(&dir, "alif");
        assert!(p.starts_with("/data/users"));
        assert!(p.to_string_lossy().ends_with("alif.json"));
    }

    #[test]
    fn require_user_tolak_header_hilang() {
        let h = HeaderMap::new();
        assert!(require_user(&h).is_err());
    }

    #[test]
    fn require_user_tolak_username_invalid() {
        let mut h = HeaderMap::new();
        h.insert("x-komik-user", "../etc/passwd".parse().unwrap());
        assert!(require_user(&h).is_err());
    }
}
