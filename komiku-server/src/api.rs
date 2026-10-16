//! Klien HTTP ke API mobile Komiku+.
//!
//! Dua host dipakai (dari `EndPoints` di APK):
//! - `index.komikid.org`   -> homepage, kategori, katalog A-Z, pencarian
//! - `content.komikid.org` -> detail manga + chapter
//!
//! Semua request WAJIB membawa header `x-secure-seeds` (lihat `crypto`).

use anyhow::{anyhow, Context, Result};
use once_cell::sync::Lazy;
use serde_json::Value;
use std::time::Duration;

use crate::crypto;

pub const BASE_INDEX: &str = "https://index.komikid.org/";
pub const BASE_CONTENT: &str = "https://content.komikid.org/";

const UA: &str = "Mozilla/5.0 (Linux; Android 13; SM-S908B) AppleWebKit/537.36 \
(KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36";

/// Klien tunggal dengan timeout & keep-alive; aman dipakai bersama antar task.
static CLIENT: Lazy<reqwest::Client> = Lazy::new(|| {
    reqwest::Client::builder()
        .user_agent(UA)
        .timeout(Duration::from_secs(30))
        .pool_idle_timeout(Duration::from_secs(90))
        .build()
        .expect("klien HTTP gagal dibuat")
});

/// GET dengan seed segar. Retry sekali saat 401/403 karena seed berbasis waktu.
pub async fn get(base: &str, path_suffix: &str, query: &[(&str, String)]) -> Result<Value> {
    let url = format!("{base}{path_suffix}");

    let mut last_err = None;
    for _attempt in 0..3 {
        let resp = CLIENT
            .get(&url)
            .query(query)
            .header("x-secure-seeds", crypto::x_secure_seeds())
            .header("x-package-name", "id.komiku.plus")
            .header("x-version-code", "11")
            .header("x-country-code", "ID")
            .header("Accept", "application/json")
            .send()
            .await;

        match resp {
            Ok(r) => {
                let status = r.status();
                if status == reqwest::StatusCode::UNAUTHORIZED
                    || status == reqwest::StatusCode::FORBIDDEN
                {
                    // seed kedaluwarsa -> generate ulang
                    last_err = Some(anyhow!("HTTP {status} (seed ditolak)"));
                    tokio::time::sleep(Duration::from_millis(400)).await;
                    continue;
                }
                let body = r.text().await.context("baca body gagal")?;
                if !status.is_success() {
                    return Err(anyhow!(
                        "HTTP {status} dari {url}: {}",
                        body.chars().take(200).collect::<String>()
                    ));
                }
                return serde_json::from_str(&body)
                    .with_context(|| format!("respons bukan JSON ({} byte)", body.len()));
            }
            Err(e) => {
                last_err = Some(anyhow!(e));
                tokio::time::sleep(Duration::from_millis(500)).await;
            }
        }
    }
    Err(last_err.unwrap_or_else(|| anyhow!("gagal setelah 3 percobaan")))
}

/// Pencarian: `page/{n}/?s={q}` — perhatikan key hasilnya `manga`, bukan `data`.
pub async fn search(q: &str, page: u32) -> Result<Value> {
    get(
        BASE_INDEX,
        &format!("page/{page}/"),
        &[("s", q.to_string())],
    )
    .await
}

/// Katalog A-Z lengkap (5.6 MB). Di-cache di `routes::catalogue`.
pub async fn catalogue() -> Result<Value> {
    get(BASE_INDEX, "", &[("content", "mangalist".into())]).await
}

pub async fn homepage() -> Result<Value> {
    get(BASE_INDEX, "", &[("content", "homepage".into())]).await
}

pub async fn categories() -> Result<Value> {
    get(BASE_INDEX, "", &[("content", "categorylist".into())]).await
}

/// Detail manga + daftar chapter (blob terenkripsi di dalamnya).
pub async fn series(id: i64) -> Result<Value> {
    get(
        BASE_CONTENT,
        "",
        &[("content", "manga".into()), ("id", id.to_string())],
    )
    .await
}

/// Satu chapter: metadata + blob daftar URL gambar.
pub async fn chapter(id: i64) -> Result<Value> {
    get(
        BASE_CONTENT,
        "",
        &[("content", "chapter".into()), ("id", id.to_string())],
    )
    .await
}
