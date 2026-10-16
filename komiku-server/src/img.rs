//! Proxy gambar CDN → `/img?u=<url>`.
//!
//! Kenapa gambar tidak langsung di-hotlink dari `img.komiku.org` lagi:
//! 1. Service worker bisa men-cache respons same-origin penuh (bukan opaque),
//!    jadi cache lebih bisa diandalkan & bisa diukur.
//! 2. Retry/backoff terjadi di sisi server — browser tinggal meminta ulang.
//! 3. Kuota cache SW terpakai untuk aset yang benar-benar immutable:
//!    path CDN per chapter tidak pernah berubah.
//!
//! Keamanan: host di-allowlist eksplisit per host (SSRF guard). Lihat
//! `ALLOWED_HOSTS` di bawah — TIDAK ada wildcard/subdomain matching.

use axum::{
    extract::Query,
    http::{header, StatusCode},
    response::{IntoResponse, Response},
    Json,
};
use serde::Deserialize;
use std::time::Duration;

/// Host gambar yang diizinkan (SSRF guard): eksplisit per host, TANPA
/// wildcard — subdomain liar / host user-request langsung ditolak.
/// Sumber: img.komiku.org (komiku), image2..image11.komiku.to (komiku+mangaku
/// CDN, semuanya resolve live 2026-10-15), thumbnail.komiku.org (cover
/// komiku), assets/storage.shngm.id (shinigami), cdnkuma.my.id (mangaku),
/// cdn.jsdelivr.net + v2.yuucdn.net + v7.kiryuu.to (kiryuu — host HTML
/// terverifikasi, gambar multi-host).
///
/// KONTRAK: daftar ini WAJIB identik dengan `IMG_HOSTS` di
/// `komiku-web/src/imgUrl.ts` — host yang tak ada di sana tak di-proxy klien,
/// host yang tak ada di sini dijawab 403 server.
const ALLOWED_HOSTS: &[&str] = &[
    "img.komiku.org",
    "thumbnail.komiku.org",
    "image2.komiku.to",
    "image3.komiku.to",
    "image4.komiku.to",
    "image5.komiku.to",
    "image6.komiku.to",
    "image7.komiku.to",
    "image8.komiku.to",
    "image9.komiku.to",
    "image10.komiku.to",
    "image11.komiku.to",
    "assets.shngm.id",
    "storage.shngm.id",
    "cdnkuma.my.id",
    "cdn.jsdelivr.net",
    "v2.yuucdn.net",
    "v7.kiryuu.to",
];

const TIMEOUT: Duration = Duration::from_secs(20);
const RETRIES: u32 = 3;

#[derive(Deserialize)]
pub struct ImgQuery {
    u: String,
}

/// Ambil host dari `https://host/...` tanpa crate `url` (cukup allowlist).
fn https_host(u: &str) -> Option<&str> {
    let rest = u.strip_prefix("https://")?;
    let host = rest.split(['/', '?', '#']).next()?;
    if host.is_empty() {
        None
    } else {
        Some(host)
    }
}

/// Host gambar yang diizinkan (bandingkan eksak, case-insensitive): host tidak
/// dikenal — termasuk subdomain — ditolak. Dipakai juga `downloads` saat
/// mengambil gambar chapter untuk PDF (allowlist SSRF yang sama).
pub fn host_allowed(u: &str) -> bool {
    match https_host(u) {
        Some(h) => ALLOWED_HOSTS
            .iter()
            .any(|allowed| h.eq_ignore_ascii_case(allowed)),
        None => false,
    }
}

/// Handler: proxy satu gambar dengan retry + header cache panjang.
pub async fn img_handler(Query(q): Query<ImgQuery>) -> Response {
    if !host_allowed(&q.u) {
        return err(StatusCode::FORBIDDEN, "host gambar tidak diizinkan");
    }
    let target = q.u.clone();

    let client = reqwest::Client::builder()
        .timeout(TIMEOUT)
        .build()
        .unwrap_or_default();

    let mut last_err = String::from("gagal mengambil gambar");
    for attempt in 0..RETRIES {
        if attempt > 0 {
            // backoff: 300ms, 900ms — cukup untuk jaringan jadul yang drop packet
            tokio::time::sleep(Duration::from_millis(300 * (1 << attempt))).await;
        }
        let resp = match client.get(target.clone()).send().await {
            Ok(r) => r,
            Err(e) => {
                last_err = e.to_string();
                continue;
            }
        };
        let status = resp.status();
        let content_type = resp
            .headers()
            .get(header::CONTENT_TYPE)
            .and_then(|v| v.to_str().ok())
            .unwrap_or("application/octet-stream")
            .to_string();
        match resp.bytes().await {
            Ok(bytes) if status.is_success() => {
                return axum::response::Response::builder()
                    .header(header::CONTENT_TYPE, content_type)
                    .header(header::CONTENT_LENGTH, bytes.len())
                    // immutable: path CDN per chapter tidak pernah berubah
                    .header(header::CACHE_CONTROL, "public, max-age=31536000, immutable")
                    .body(axum::body::Body::from(bytes))
                    .unwrap()
            }
            Ok(_) => return err(StatusCode::BAD_GATEWAY, &format!("CDN balas {status}")),
            Err(e) => {
                last_err = e.to_string();
                continue;
            }
        }
    }
    tracing::warn!("proxy /img gagal untuk {target}: {last_err}");
    err(StatusCode::BAD_GATEWAY, "gambar gagal diambil; coba lagi")
}

fn err(code: StatusCode, msg: &str) -> Response {
    // hint "jaringan tidak stabil" hanya masuk akal untuk 5xx — 403 SSRF /
    // host bukan jaringan (QA batch a1a095e3: BUG-3b).
    let body = if code.is_server_error() {
        serde_json::json!({ "error": msg, "hint": "jaringan sedang tidak stabil" })
    } else {
        serde_json::json!({ "error": msg })
    };
    (code, Json(body)).into_response()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn allowlist_komiku_cdn_lengkap() {
        // image2..image11 (komiku+mangaku CDN) harus proxy; tanpa ini gambar
        // dari host baru dijawab 403 dan reader kosong.
        for h in ["img.komiku.org", "thumbnail.komiku.org", "image2.komiku.to", "image11.komiku.to"] {
            assert!(host_allowed(&format!("https://{h}/x/1.webp")), "{h} harus diizinkan");
        }
        // host asing + subdomain liar tetap ditolak (guard SSRF)
        assert!(!host_allowed("https://evil.example.com/1.webp"));
        assert!(!host_allowed("https://image12.komiku.to/1.webp"));
        assert!(!host_allowed("https://komiku.to.evil.net/1.webp"));
        // skema http ditolak (proxy hanya https)
        assert!(!host_allowed("http://img.komiku.org/1.webp"));
    }
}
