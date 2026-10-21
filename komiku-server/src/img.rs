//! Proxy gambar ber-resize: `GET /img?u=<url absolut>&w=<lebar px>`.
//!
//! Kenapa ada lagi (Q21 dulu membuang proxy ini): byte gambar adalah bottleneck
//! yang user rasakan saat membaca di koneksi jelek. Satu chapter = 5,4 MB
//! (rata-rata 180 KB/halaman, 900 px penuh) — di 400 kbps itu ~108 detik per
//! chapter. CDN sumber TIDAK mendukung resize (`?width=`/`?q=` diabaikan,
//! sudah diuji live: byte identik), jadi satu-satunya cara memotong byte adalah
//! decode → resize → encode ulang di server.
//
// Keuntungan lain karena gambar jadi SAME-ORIGIN:
// - service worker bisa men-cache respons penuh (bukan opaque) → baca ulang
//   dan baca offline jadi instan;
// - retry/backoff ada di server, browser cukup meminta sekali.
//
// Kontrak:
//   /img?u=<url>&w=<px>   -> WebP lossy selebar `w` (rasio asli dipertahankan)
//   /img?u=<url>          -> byte asli CDN (passthrough, tetap di-cache di disk)
// Cache: `data/imgcache/<2 huruf>/<sha1>.webp`, header `immutable` 1 tahun —
// URL CDN per chapter tidak pernah berubah, jadi cache-nya abadi.
//
// Keamanan: host di-allowlist eksplisit (`hosts::host_allowed`) → proxy ini
// BUKAN open fetch. Hanya https, hanya image/*, ukuran upstream dibatasi.

use axum::{
    body::Body,
    extract::Query,
    http::{header, HeaderValue, StatusCode},
    response::{IntoResponse, Response},
    Json,
};
use image::imageops::FilterType;
use once_cell::sync::OnceCell;
use serde::Deserialize;
use std::{
    collections::HashMap,
    path::PathBuf,
    sync::Arc,
    time::Duration,
};
use tokio::sync::Mutex;

/// Batas atas lebar yang dilayani (di atas ini gambar dianggap sampul/hero).
const W_MAX: u32 = 1400;
const W_MIN: u32 = 96;
/// Batas ukuran gambar upstream yang mau diproses (byte).
const MAX_UPSTREAM: usize = 24 * 1024 * 1024;
/// Batas total isi cache di disk; di atas ini entri terlama dihapus.
const CACHE_CAP_BYTES: u64 = 4 * 1024 * 1024 * 1024;
const TIMEOUT: Duration = Duration::from_secs(25);
const RETRIES: u32 = 2;

#[derive(Deserialize)]
pub struct ImgQuery {
    /// URL gambar absolut (`https://host/path`).
    u: String,
    /// Lebar target dalam px; kosong/0 = tanpa resize.
    w: Option<u32>,
}

fn client() -> &'static reqwest::Client {
    static C: OnceCell<reqwest::Client> = OnceCell::new();
    C.get_or_init(|| {
        reqwest::Client::builder()
            .timeout(TIMEOUT)
            .pool_max_idle_per_host(8)
            .build()
            .unwrap_or_default()
    })
}

/// Direktori cache gambar (dibuat sekali). Default `data/imgcache`, bisa
/// diarahkan lewat `KOMIKU_IMGCACHE_DIR` (dipakai smoke test agar tidak
/// menyentuh state produksi).
fn cache_dir() -> &'static PathBuf {
    static D: OnceCell<PathBuf> = OnceCell::new();
    D.get_or_init(|| {
        let dir = std::env::var("KOMIKU_IMGCACHE_DIR")
            .map(PathBuf::from)
            .unwrap_or_else(|_| PathBuf::from("data/imgcache"));
        let _ = std::fs::create_dir_all(&dir);
        dir
    })
}

/// Single-flight per key: dua permintaan halaman yang sama tidak men-decode
/// dan menulis file yang sama bersamaan.
fn inflight() -> &'static Mutex<HashMap<String, Arc<Mutex<()>>>> {
    static M: OnceCell<Mutex<HashMap<String, Arc<Mutex<()>>>>> = OnceCell::new();
    M.get_or_init(|| Mutex::new(HashMap::new()))
}

fn sha1_hex(s: &str) -> String {
    use sha1::{Digest, Sha1};
    let mut h = Sha1::new();
    h.update(s.as_bytes());
    h.finalize().iter().map(|b| format!("{b:02x}")).collect()
}

fn cache_path(key: &str) -> PathBuf {
    let shard = &key[0..2];
    cache_dir().join(shard).join(format!("{key}.webp"))
}

/// Path byte asli hasil fetch upstream (kunci = URL saja, bukan URL+lebar).
fn raw_cache_path(key: &str) -> PathBuf {
    let shard = &key[0..2];
    cache_dir().join("raw").join(shard).join(format!("{key}.bin"))
}

/// Tulis file lewat temp UNIK lalu rename. Di Windows `rename` gagal kalau
/// tujuan sedang dibuka proses lain (GET paralel), jadi dicoba beberapa kali.
fn write_atomic(path: &PathBuf, bytes: &[u8]) {
    if let Some(dir) = path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    let tmp = path.with_extension(format!("tmp{}", std::process::id()));
    if std::fs::write(&tmp, bytes).is_ok() {
        for _ in 0..3 {
            if std::fs::rename(&tmp, path).is_ok() {
                break;
            }
            std::thread::sleep(Duration::from_millis(50));
        }
        let _ = std::fs::remove_file(&tmp);
    }
}

/// Tipe isi dari magic bytes (byte asli dari CDN bisa webp/jpeg/png/gif).
fn sniff_type(b: &[u8]) -> &'static str {
    if b.len() > 12 && &b[0..4] == b"RIFF" && &b[8..12] == b"WEBP" {
        "image/webp"
    } else if b.starts_with(&[0xff, 0xd8, 0xff]) {
        "image/jpeg"
    } else if b.starts_with(&[0x89, b'P', b'N', b'G']) {
        "image/png"
    } else if b.starts_with(b"GIF8") {
        "image/gif"
    } else {
        "application/octet-stream"
    }
}

fn err(status: StatusCode, msg: &str) -> Response {
    (status, Json(serde_json::json!({ "error": msg }))).into_response()
}

fn immutable(bytes: Vec<u8>, etag: &str, cache: &str) -> Response {
    let body = Body::from(bytes);
    let mut resp = Response::new(body);
    let h = resp.headers_mut();
    h.insert(header::CONTENT_TYPE, HeaderValue::from_static("image/webp"));
    h.insert(
        header::CACHE_CONTROL,
        HeaderValue::from_static("public, max-age=31536000, immutable"),
    );
    if let Ok(v) = HeaderValue::from_str(etag) {
        h.insert(header::ETAG, v);
    }
    if let Ok(v) = HeaderValue::from_str(cache) {
        h.insert("x-img-cache", v);
    }
    resp
}

/// Decode → resize (lebar `w`, rasio dipertahankan) → WebP lossy.
/// Kualitas diturunkan untuk gambar kecil: di 480 px q72 sudah tak terbedakan
/// dari aslinya di layar HP, dan selisih byte-nya besar.
fn resize_encode(src: &[u8], target_w: u32) -> Result<Vec<u8>, String> {
    let img = image::load_from_memory(src).map_err(|e| format!("decode: {e}"))?;
    let (sw, sh) = (img.width(), img.height());
    if sw == 0 || sh == 0 {
        return Err("dimensi tak valid".into());
    }
    let w = target_w.min(sw); // jangan pernah memperbesar (byte naik, tak berguna)
    let h = ((sh as u64 * w as u64) / sw as u64).max(1) as u32;
    // Lanczos3 lebih tajam untuk line-art manga; Triangle dipakai kalau
    // gambarnya besar supaya CPU tidak meledak (rasio downscale ekstrem).
    let filter = if (sw as u64 * sh as u64) > 12_000_000 {
        FilterType::Triangle
    } else {
        FilterType::Lanczos3
    };
    let small = if w == sw {
        img
    } else {
        img.resize_exact(w, h, filter)
    };
    let rgb = small.to_rgb8();
    let q = if w <= 520 {
        72.0
    } else if w <= 720 {
        75.0
    } else {
        78.0
    };
    let enc = webp::Encoder::from_rgb(rgb.as_raw(), rgb.width(), rgb.height());
    Ok(enc.encode(q).to_vec())
}

async fn fetch_upstream(url: &str) -> Result<(String, Vec<u8>), String> {
    let mut last = String::from("gagal mengambil gambar");
    for attempt in 0..RETRIES {
        if attempt > 0 {
            tokio::time::sleep(Duration::from_millis(250 * (1 << attempt))).await;
        }
        match client().get(url).send().await {
            Ok(r) => {
                let status = r.status();
                let ctype = r
                    .headers()
                    .get(header::CONTENT_TYPE)
                    .and_then(|v| v.to_str().ok())
                    .unwrap_or("application/octet-stream")
                    .to_string();
                if !status.is_success() {
                    last = format!("upstream {status}");
                    continue;
                }
                if !ctype.starts_with("image/") {
                    return Err(format!("bukan gambar: {ctype}"));
                }
                match r.content_length() {
                    Some(n) if n as usize > MAX_UPSTREAM => {
                        return Err(format!("gambar terlalu besar: {n} B"))
                    }
                    _ => {}
                }
                match r.bytes().await {
                    Ok(b) => {
                        if b.len() > MAX_UPSTREAM {
                            return Err("gambar terlalu besar".into());
                        }
                        return Ok((ctype, b.to_vec()));
                    }
                    Err(e) => last = e.to_string(),
                }
            }
            Err(e) => last = e.to_string(),
        }
    }
    Err(last)
}

/// Hapus entri cache terlama sampai total di bawah `cap`. Dipanggil sesekali
/// (bukan tiap request) supaya tidak ada pengembaraan disk tiap gambar.
fn evict_if_needed() {
    let dir = cache_dir();
    let mut entries: Vec<(std::time::SystemTime, u64, PathBuf)> = Vec::new();
    let mut total: u64 = 0;
    let Ok(shards) = std::fs::read_dir(dir) else {
        return;
    };
    for shard in shards.flatten() {
        let Ok(files) = std::fs::read_dir(shard.path()) else {
            continue;
        };
        for f in files.flatten() {
            if let Ok(md) = f.metadata() {
                let t = md.modified().unwrap_or(std::time::SystemTime::UNIX_EPOCH);
                total += md.len();
                entries.push((t, md.len(), f.path()));
            }
        }
    }
    if total <= CACHE_CAP_BYTES {
        return;
    }
    entries.sort_by_key(|e| e.0);
    let mut freed = 0u64;
    for (_, len, path) in entries {
        if total - freed <= CACHE_CAP_BYTES * 9 / 10 {
            break;
        }
        if std::fs::remove_file(&path).is_ok() {
            freed += len;
        }
    }
    tracing::info!("imgcache: bersihkan {freed} byte (total {total})");
}

/// Handler `/img`. Isi cache di disk; miss → ambil dari CDN, resize, simpan.
pub async fn img_handler(Query(q): Query<ImgQuery>) -> Response {
    if q.u.len() > 2048 || !crate::hosts::host_allowed(&q.u) {
        return err(StatusCode::FORBIDDEN, "host gambar tidak diizinkan");
    }
    let raw_w = q.w.unwrap_or(0);
    if raw_w != 0 && !(W_MIN..=W_MAX).contains(&raw_w) {
        return err(StatusCode::BAD_REQUEST, "lebar di luar rentang");
    }
    // kunci cache: URL + lebar (0 = passthrough byte asli)
    let key = sha1_hex(&format!("{}|{}", q.u, raw_w));
    let path = cache_path(&key);
    let etag = format!("\"{key}\"");

    if let Ok(bytes) = std::fs::read(&path) {
        return immutable(bytes, &etag, "hit");
    }

    // single-flight: kunci per key supaya decode/encode tidak dobel
    let lock = {
        let mut map = inflight().lock().await;
        map.entry(key.clone())
            .or_insert_with(|| Arc::new(Mutex::new(())))
            .clone()
    };
    let guard = lock.lock().await;

    // re-cek setelah dapat lock: mungkin permintaan lain barusan mengisi cache
    if let Ok(bytes) = std::fs::read(&path) {
        drop(guard);
        inflight_release(&key).await;
        return immutable(bytes, &etag, "hit");
    }

    // --- byte ASLI di-cache terpisah, dipakai bersama semua lebar ---
    // Kenapa: satu halaman bisa diminta di 480 (HP 1x), 640 (HP retina) dan
    // 900 (desktop). Tanpa cache raw, tiap lebar memicu fetch upstream ulang
    // (2-3 s per halaman di jaringan rumah). Dengan cache raw, upstream sekali.
    let raw_path = raw_cache_path(&sha1_hex(&q.u));
    let t_fetch = std::time::Instant::now();
    let upstream = match std::fs::read(&raw_path) {
        Ok(b) if !b.is_empty() => b,
        _ => match fetch_upstream(&q.u).await {
            Ok((_ct, bytes)) => {
                write_atomic(&raw_path, &bytes);
                bytes
            }
            Err(e) => {
                drop(guard);
                inflight_release(&key).await;
                return err(StatusCode::BAD_GATEWAY, &e);
            }
        },
    };

    // Tanpa `w`: layani byte asli apa adanya (dipakai cover/unduhan bila perlu).
    if raw_w == 0 {
        drop(guard);
        inflight_release(&key).await;
        let mut resp = immutable(upstream.clone(), &etag, "miss-passthrough");
        resp.headers_mut().insert(
            header::CONTENT_TYPE,
            HeaderValue::from_static(sniff_type(&upstream)),
        );
        return resp;
    }

    let fetch_ms = t_fetch.elapsed().as_millis() as u64;
    // Decode + encode di blocking pool (CPU-bound, jangan menahan worker async).
    let t_enc = std::time::Instant::now();
    let src = upstream.clone();
    let target = raw_w;
    // salinan untuk jalur gagal: byte asli lebih baik daripada halaman kosong
    let fallback = upstream.clone();
    let encoded = match tokio::task::spawn_blocking(move || resize_encode(&src, target)).await {
        Ok(Ok(v)) => v,
        Ok(Err(e)) => {
            tracing::warn!("img resize gagal: {e} — kirim byte asli");
            fallback
        }
        Err(e) => {
            tracing::warn!("img resize panik: {e} — kirim byte asli");
            fallback
        }
    };

    tracing::info!(
        "img miss w={raw_w} fetch={fetch_ms}ms encode={}ms upstream={}B out={}B",
        t_enc.elapsed().as_millis(),
        upstream.len(),
        encoded.len()
    );
    write_atomic(&path, &encoded);

    drop(guard);
    inflight_release(&key).await;

    // sesekali bersihkan cache (murah: 1/512 penulisan)
    if fastrand_u32() % 512 == 0 {
        std::thread::spawn(evict_if_needed);
    }

    immutable(encoded, &etag, "miss")
}

async fn inflight_release(key: &str) {
    let mut map = inflight().lock().await;
    if let Some(entry) = map.get(key) {
        // hanya hapus kalau tidak ada yang sedang menunggu (strong_count == 1)
        if Arc::strong_count(entry) <= 1 {
            map.remove(key);
        }
    }
}

fn fastrand_u32() -> u32 {
    use std::time::{SystemTime, UNIX_EPOCH};
    let n = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.subsec_nanos())
        .unwrap_or(0);
    n ^ (std::process::id().rotate_left(7))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn kunci_cache_beda_per_lebar() {
        assert_ne!(sha1_hex("https://x/1.webp|480"), sha1_hex("https://x/1.webp|640"));
        assert_eq!(sha1_hex("https://x/1.webp|480").len(), 40);
    }

    #[test]
    fn path_cache_ter_shard() {
        let key = sha1_hex("https://x/1.webp|480");
        let p = cache_path(&key);
        let s = p.to_string_lossy().replace('\\', "/");
        assert!(s.contains("/imgcache/"), "path: {s}");
        assert!(s.ends_with(&format!("{key}.webp")), "path: {s}");
    }

    #[test]
    fn resize_memperkecil_dan_mempertahankan_rasio() {
        // gambar 900x1200 solid: decode->resize 480 harus jadi 480x640 WebP
        let mut buf = Vec::new();
        let img = image::RgbImage::from_pixel(900, 1200, image::Rgb([200, 200, 200]));
        image::DynamicImage::ImageRgb8(img)
            .write_to(&mut std::io::Cursor::new(&mut buf), image::ImageFormat::Png)
            .unwrap();
        let out = resize_encode(&buf, 480).expect("encode");
        let back = image::load_from_memory(&out).expect("decode hasil");
        assert_eq!((back.width(), back.height()), (480, 640));
        assert!(out.len() < buf.len(), "hasil harus lebih kecil dari PNG sumber");
    }

    #[test]
    fn resize_tidak_memperbesar() {
        let mut buf = Vec::new();
        let img = image::RgbImage::from_pixel(300, 400, image::Rgb([10, 10, 10]));
        image::DynamicImage::ImageRgb8(img)
            .write_to(&mut std::io::Cursor::new(&mut buf), image::ImageFormat::Png)
            .unwrap();
        let out = resize_encode(&buf, 900).expect("encode");
        let back = image::load_from_memory(&out).expect("decode hasil");
        assert_eq!((back.width(), back.height()), (300, 400));
    }
}
