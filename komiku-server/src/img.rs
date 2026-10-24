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
    http::{header, HeaderMap, HeaderValue, StatusCode},
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

/// Format output proxy /img. WebP default; AVIF (opsional) untuk sampul/
/// thumbnail kecil via negosiasi Accept. Passthrough = byte asli (tanpa resize).
#[derive(Clone, Copy, PartialEq, Eq)]
enum ImgFormat {
    WebP,
    Avif,
    Passthrough,
}

impl ImgFormat {
    fn ext(self) -> &'static str {
        match self {
            Self::WebP => "webp",
            Self::Avif => "avif",
            Self::Passthrough => "",
        }
    }

    fn mime(self) -> &'static str {
        match self {
            Self::WebP => "image/webp",
            Self::Avif => "image/avif",
            Self::Passthrough => "application/octet-stream",
        }
    }
}

/// Path cache untuk varian format tertentu — ekstensi ikut menentukan format,
/// sehingga WebP dan AVIF tidak saling menimpa di disk.
fn cache_path_fmt(key: &str, fmt: ImgFormat) -> PathBuf {
    let shard = &key[0..2];
    cache_dir().join(shard).join(format!("{key}.{}", fmt.ext()))
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

fn immutable(bytes: Vec<u8>, etag: &str, cache: &str, mime: &'static str) -> Response {
    let body = Body::from(bytes);
    let mut resp = Response::new(body);
    let h = resp.headers_mut();
    h.insert(header::CONTENT_TYPE, HeaderValue::from_static(mime));
    h.insert(
        header::CACHE_CONTROL,
        HeaderValue::from_static("public, max-age=31536000, immutable"),
    );
    // Vary: Accept — respons beda per varian (webp/avif) yang dinegosiasikan.
    h.insert("vary", HeaderValue::from_static("Accept"));
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

/// Decode → resize (decode/lebar/filter sama seperti `resize_encode`) → AVIF
/// lossy via `ravif` (rav1e). Kualitas 72 (rentang valid 1..=100); dipakai
/// hanya untuk sampul/thumbnail kecil (w<=320) saat klien meminta image/avif.
fn resize_encode_avif(src: &[u8], target_w: u32) -> Result<Vec<u8>, String> {
    let img = image::load_from_memory(src).map_err(|e| format!("decode: {e}"))?;
    let (sw, sh) = (img.width(), img.height());
    if sw == 0 || sh == 0 {
        return Err("dimensi tak valid".into());
    }
    let w = target_w.min(sw); // jangan pernah memperbesar
    let h = ((sh as u64 * w as u64) / sw as u64).max(1) as u32;
    // Filter sama dengan resize_encode: Lanczos3 untuk line-art, Triangle untuk
    // gambar besar agar CPU tidak meledak.
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
    // Kualitas AVIF: thumbnail kecil, 72 sudah tak terbedakan.
    let q = 72.0;
    // ravif butuh &[RGB8]; bangun dari byte RGB mentah.
    let pixels: Vec<ravif::RGB8> = rgb
        .as_raw()
        .chunks_exact(3)
        .map(|c| ravif::RGB8::new(c[0], c[1], c[2]))
        .collect();
    let img = ravif::Img::new(&pixels[..], rgb.width() as usize, rgb.height() as usize);
    let enc = ravif::Encoder::new().with_quality(q);
    let res = enc.encode_rgb(img).map_err(|e| format!("encode avif: {e}"))?;
    Ok(res.avif_file)
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
pub async fn img_handler(Query(q): Query<ImgQuery>, headers: HeaderMap) -> Response {
    if q.u.len() > 2048 || !crate::hosts::host_allowed(&q.u) {
        return err(StatusCode::FORBIDDEN, "host gambar tidak diizinkan");
    }
    let raw_w = q.w.unwrap_or(0);
    if raw_w != 0 && !(W_MIN..=W_MAX).contains(&raw_w) {
        return err(StatusCode::BAD_REQUEST, "lebar di luar rentang");
    }

    // Negosiasi AVIF (opsional): hanya bila klien menerima `image/avif` DAN
    // lebar kecil (sampul/thumbnail, w<=320). WebP tetap default untuk yang lain.
    let accepts_avif = headers
        .get(header::ACCEPT)
        .and_then(|v| v.to_str().ok())
        .map(|v| v.split(',').any(|t| t.trim_start().starts_with("image/avif")))
        .unwrap_or(false);
    let fmt = if accepts_avif && raw_w != 0 && raw_w <= 320 {
        ImgFormat::Avif
    } else {
        ImgFormat::WebP
    };

    // kunci cache unik per format (WebP vs AVIF berbeda, tidak saling timpa).
    let key = sha1_hex(&format!("{}|{}|{}", q.u, raw_w, fmt.ext()));
    let path = cache_path_fmt(&key, fmt);
    let etag = format!("\"{key}\"");

    if let Ok(bytes) = std::fs::read(&path) {
        return immutable(bytes, &etag, "hit", fmt.mime());
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
        return immutable(bytes, &etag, "hit", fmt.mime());
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
        return immutable(upstream.clone(), &etag, "miss-passthrough", sniff_type(&upstream));
    }

    let fetch_ms = t_fetch.elapsed().as_millis() as u64;
    // Decode + encode di blocking pool (CPU-bound, jangan menahan worker async).
    let t_enc = std::time::Instant::now();
    let target = raw_w;
    let fallback = upstream.clone();

    // Encode sesuai format yang dinegosiasikan; bila encoder gagal, turun ke
    // WebP lalu ke byte asli — jangan pernah 500.
    let (encoded, out_fmt): (Vec<u8>, ImgFormat) = if fmt == ImgFormat::Avif {
        let r = tokio::task::spawn_blocking({
            let src = upstream.clone();
            move || resize_encode_avif(&src, target)
        })
        .await;
        match r {
            Ok(Ok(v)) => (v, ImgFormat::Avif),
            _ => {
                tracing::warn!("img avif gagal — fallback WebP");
                match tokio::task::spawn_blocking({
                    let src = upstream.clone();
                    move || resize_encode(&src, target)
                })
                .await
                {
                    Ok(Ok(v)) => (v, ImgFormat::WebP),
                    _ => {
                        tracing::warn!("img webp fallback juga gagal — kirim byte asli");
                        (fallback, ImgFormat::Passthrough)
                    }
                }
            }
        }
    } else {
        let r = tokio::task::spawn_blocking({
            let src = upstream.clone();
            move || resize_encode(&src, target)
        })
        .await;
        match r {
            Ok(Ok(v)) => (v, ImgFormat::WebP),
            _ => {
                tracing::warn!("img resize gagal — kirim byte asli");
                (fallback, ImgFormat::Passthrough)
            }
        }
    };

    // Simpan ke cache hanya jika hasilnya format terencode; gunakan kunci cache
    // format yang benar (bisa beda dari yang diminta saat terjadi fallback).
    if out_fmt != ImgFormat::Passthrough {
        let write_key = if out_fmt == fmt {
            key.clone()
        } else {
            sha1_hex(&format!("{}|{}|{}", q.u, raw_w, out_fmt.ext()))
        };
        write_atomic(&cache_path_fmt(&write_key, out_fmt), &encoded);
    }

    tracing::info!(
        "img miss w={raw_w} fetch={fetch_ms}ms encode={}ms upstream={}B out={}B fmt={}",
        t_enc.elapsed().as_millis(),
        upstream.len(),
        encoded.len(),
        out_fmt.ext()
    );

    drop(guard);
    inflight_release(&key).await;

    // sesekali bersihkan cache (murah: 1/512 penulisan)
    if fastrand_u32() % 512 == 0 {
        std::thread::spawn(evict_if_needed);
    }

    let mime = if out_fmt == ImgFormat::Passthrough {
        sniff_type(&encoded)
    } else {
        out_fmt.mime()
    };
    immutable(encoded, &etag, "miss", mime)
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
        let p = cache_path_fmt(&key, ImgFormat::WebP);
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

    #[test]
    fn resize_avif_menghasilkan_bytes() {
        let mut buf = Vec::new();
        let img = image::RgbImage::from_pixel(300, 400, image::Rgb([10, 10, 10]));
        image::DynamicImage::ImageRgb8(img)
            .write_to(&mut std::io::Cursor::new(&mut buf), image::ImageFormat::Png)
            .unwrap();
        let out = resize_encode_avif(&buf, 200).expect("encode avif");
        assert!(!out.is_empty());
        // AVIF/HEIF wajib memuat box "ftyp" di awal file.
        assert!(
            out.windows(4).any(|w| w == b"ftyp"),
            "output bukan AVIF: len={}",
            out.len()
        );
    }

    #[test]
    fn kunci_cache_beda_per_format() {
        let k_webp = sha1_hex("https://x/1.webp|200|webp");
        let k_avif = sha1_hex("https://x/1.webp|200|avif");
        assert_ne!(k_webp, k_avif, "WebP dan AVIF harus punya kunci cache beda");
        assert!(cache_path_fmt(&k_avif, ImgFormat::Avif)
            .to_string_lossy()
            .ends_with(".avif"));
    }
}
