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

/// Timeout per PERCOBAAN untuk endpoint legacy. Dulu 30 s × 3 percobaan =
/// ~91 s saat upstream hang; sekarang 8 s × 2 = ~16 s (dan 522/523 yang
/// dijawab Cloudflare langsung gagal tanpa retry).
const REQUEST_TIMEOUT: Duration = Duration::from_secs(8);
/// Katalog A-Z 5.6 MB boleh lebih lambat; tetap dibatasi supaya request
/// pertama saat sumber mati tidak menggantung selamanya.
const CATALOGUE_TIMEOUT: Duration = Duration::from_secs(20);
/// Percobaan maksimum. Retry hanya untuk 401/403 (seed basi) dan galat
/// jaringan; status HTTP non-2xx lain (mis. 522) langsung dikembalikan.
const MAX_ATTEMPTS: u32 = 2;

/// Klien tunggal dengan keep-alive; timeout dipasang PER REQUEST supaya
/// katalog (berat) bisa punya batas berbeda dari endpoint ringan.
static CLIENT: Lazy<reqwest::Client> = Lazy::new(|| {
    reqwest::Client::builder()
        .user_agent(UA)
        .pool_idle_timeout(Duration::from_secs(90))
        .build()
        // Jangan panic di jalur request: client default tetap fungsional.
        .unwrap_or_default()
});

/// GET dengan seed segar. Retry sekali saat 401/403 karena seed berbasis waktu.
pub async fn get(base: &str, path_suffix: &str, query: &[(&str, String)]) -> Result<Value> {
    get_with_timeout(base, path_suffix, query, REQUEST_TIMEOUT).await
}

async fn get_with_timeout(
    base: &str,
    path_suffix: &str,
    query: &[(&str, String)],
    timeout: Duration,
) -> Result<Value> {
    let url = format!("{base}{path_suffix}");

    let mut last_err = None;
    for attempt in 0..MAX_ATTEMPTS {
        let resp = CLIENT
            .get(&url)
            .query(query)
            // Menimpa timeout client (tidak ada default global): batas total
            // satu percobaan, termasuk baca body.
            .timeout(timeout)
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
                    if attempt + 1 < MAX_ATTEMPTS {
                        tokio::time::sleep(Duration::from_millis(400)).await;
                    }
                    continue;
                }
                let body = r.text().await.context("baca body gagal")?;
                if !status.is_success() {
                    // 5xx (termasuk 522/523 Cloudflare) TIDAK di-retry:
                    // mengulang tidak menyembuhkan origin timeout, hanya
                    // menambah waktu tunggu user.
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
                if attempt + 1 < MAX_ATTEMPTS {
                    tokio::time::sleep(Duration::from_millis(500)).await;
                }
            }
        }
    }
    Err(last_err.unwrap_or_else(|| anyhow!("gagal setelah {MAX_ATTEMPTS} percobaan")))
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
    get_with_timeout(
        BASE_INDEX,
        "",
        &[("content", "mangalist".into())],
        CATALOGUE_TIMEOUT,
    )
    .await
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
