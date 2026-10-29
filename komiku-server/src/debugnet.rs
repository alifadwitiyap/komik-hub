//! Diagnostik jaringan untuk satu host: DNS → TCP → TLS → HTTP.
//!
//! Kenapa ada: sumber mangaku/kiryuu timeout 5 s di production padahal dari
//! mesin lain host-nya sehat. Tanpa shell ke container, satu-satunya cara
//! memisahkan "DNS salah" vs "egress diblok" vs "Cloudflare menahan" adalah
//! mengukur tiap tahap dari DALAM proses yang gagal.
//!
//! Keamanan: host WAJIB lolos allowlist [`crate::hosts::host_allowed`] — endpoint
//! ini tidak boleh jadi SSRF terbuka. Tidak ada retry/redirect follow.

use std::net::{SocketAddr, ToSocketAddrs};
use std::time::{Duration, Instant};

use axum::extract::Query;
use axum::Json;
use serde::Deserialize;
use serde_json::{json, Value};

use crate::routes::Res;

#[derive(Deserialize)]
pub struct NetQuery {
    /// Host tanpa skema, mis. `mangaku.lol`.
    host: String,
    /// Port TCP (default 443).
    port: Option<u16>,
    /// Path yang di-GET setelah TLS (default `/`).
    path: Option<String>,
}

const STEP_TIMEOUT: Duration = Duration::from_secs(8);

/// Host yang boleh diprobe. Terpisah dari allowlist gambar `hosts.rs` (yang
/// sengaja hanya CDN gambar): di sini yang didiagnosis justru host HTML sumber
/// — mangaku.lol / v7.kiryuu.to dkk. Tetap daftar eksplisit, tanpa wildcard,
/// supaya endpoint ini tidak bisa dipakai memindai jaringan internal.
const DEBUG_HOSTS: &[&str] = &[
    "mangaku.lol",
    "v7.kiryuu.to",
    "komiku.org",
    "index.komikid.org",
    "shngm.id",
    "api.shngm.id",
    "cloudflare-dns.com",
    "img.komiku.org",
    "cdnkuma.my.id",
    // CDN gambar chapter — WAJIB ada di sini supaya "gambar 502" bisa
    // didiagnosis per tahap (DNS/TCP/TLS/HTTP) tanpa menebak. Tanpa entri ini
    // endpoint hanya menjawab "host tidak ada di allowlist debug".
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
    "thumbnail.komiku.org",
    "thumbnail.komiku.to",
    "assets.shngm.id",
    "storage.shngm.id",
    "cdn.kiryuu.io",
];

fn host_debuggable(host: &str) -> bool {
    DEBUG_HOSTS.iter().any(|h| host.eq_ignore_ascii_case(h))
}

/// GET /api/debug/net — laporan per tahap untuk satu host.
pub async fn net_probe(Query(q): Query<NetQuery>) -> Res<Value> {
    let host = q.host.trim().to_string();
    let port = q.port.unwrap_or(443);
    let path = q.path.unwrap_or_else(|| "/".to_string());
    let url = format!("https://{host}{path}");
    if !host_debuggable(&host) {
        return Ok(Json(json!({
            "host": host,
            "error": "host tidak ada di allowlist debug (endpoint ini bukan pemindai jaringan)",
            "allowed": DEBUG_HOSTS,
        })));
    }

    // 1. DNS: resolver sistem (yang dipakai reqwest kalau tak di-pin).
    let dns_start = Instant::now();
    let addrs: Vec<SocketAddr> = match tokio::time::timeout(
        STEP_TIMEOUT,
        tokio::task::spawn_blocking({
            let host = host.clone();
            move || (host.as_str(), port).to_socket_addrs().map(|it| it.collect::<Vec<_>>())
        }),
    )
    .await
    {
        Ok(Ok(Ok(list))) => list,
        Ok(Ok(Err(e))) => {
            return Ok(Json(json!({
                "host": host,
                "dns": { "ok": false, "error": e.to_string(), "ms": dns_start.elapsed().as_millis() },
            })))
        }
        Ok(Err(e)) => {
            return Ok(Json(json!({
                "host": host,
                "dns": { "ok": false, "error": format!("task: {e}"), "ms": dns_start.elapsed().as_millis() },
            })))
        }
        Err(_) => {
            return Ok(Json(json!({
                "host": host,
                "dns": { "ok": false, "error": "timeout resolve", "ms": dns_start.elapsed().as_millis() },
            })))
        }
    };
    let dns_ms = dns_start.elapsed().as_millis();

    // 2. TCP connect per alamat (IPv4 & IPv6 dipisah supaya blackhole IPv6
    //    kelihatan sebagai connect yang menggantung, bukan "host mati").
    let mut tcp = Vec::new();
    for addr in addrs.iter().take(4) {
        let t0 = Instant::now();
        let res = tokio::time::timeout(STEP_TIMEOUT, tokio::net::TcpStream::connect(addr)).await;
        let entry = match res {
            Ok(Ok(_)) => json!({ "addr": addr.to_string(), "ok": true, "ms": t0.elapsed().as_millis() }),
            Ok(Err(e)) => json!({ "addr": addr.to_string(), "ok": false, "error": e.to_string(), "ms": t0.elapsed().as_millis() }),
            Err(_) => json!({ "addr": addr.to_string(), "ok": false, "error": "timeout connect", "ms": t0.elapsed().as_millis() }),
        };
        tcp.push(entry);
    }

    // 3. HTTP penuh lewat client baru (TLS + header mirip adapter).
    let t0 = Instant::now();
    let http = match reqwest::Client::builder()
        .timeout(STEP_TIMEOUT)
        .user_agent(crate::unified::UA_MOBILE)
        .build()
    {
        Ok(c) => match c.get(&url).send().await {
            Ok(r) => {
                let status = r.status().as_u16();
                let body = r.text().await.unwrap_or_default();
                json!({
                    "ok": status < 400,
                    "status": status,
                    "ms": t0.elapsed().as_millis(),
                    "bytes": body.len(),
                    "head": body.chars().take(120).collect::<String>(),
                })
            }
            Err(e) => json!({
                "ok": false,
                "error": format!("{e:#}"),
                "is_timeout": e.is_timeout(),
                "is_connect": e.is_connect(),
                "ms": t0.elapsed().as_millis(),
            }),
        },
        Err(e) => json!({ "ok": false, "error": format!("client: {e:#}") }),
    };

    Ok(Json(json!({
        "host": host,
        "port": port,
        "dns": { "ok": !addrs.is_empty(), "ms": dns_ms, "addrs": addrs.iter().map(|a| a.to_string()).collect::<Vec<_>>() },
        "tcp": tcp,
        "http": http,
    })))
}
