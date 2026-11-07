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
    path::{Path, PathBuf},
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
/// 512 MB: satu chapter ≈ 5,4 MB, jadi muat ~95 chapter — jauh di atas
/// kebutuhan baca normal, tapi tak membiarkan disk membengkak tanpa batas.
const CACHE_CAP_BYTES: u64 = 512 * 1024 * 1024;
/// Pemicu evict: bersihkan bila total ≥ cap. Di bawah ini tidak usah.
const CACHE_CAP_TRIGGER_BYTES: u64 = CACHE_CAP_BYTES * 19 / 20;
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

/// Batas encode paralel. Decode+resize+encode itu CPU-bound: tanpa batas,
/// satu unduhan offline (3 lebar x 6 halaman) mengirim 18 encode sekaligus ke
/// blocking pool, 4 core berebut, tiap encode jadi 3-20 s, dan RSS membengkak
/// (tiap encode memegang buffer RGBA satu halaman). Semaphore = jumlah core
/// membuat antrean terjadi di layer async (murah) alih-alih di CPU.
fn encode_gate() -> &'static tokio::sync::Semaphore {
    static S: OnceCell<tokio::sync::Semaphore> = OnceCell::new();
    S.get_or_init(|| {
        let n = std::thread::available_parallelism()
            .map(|v| v.get())
            .unwrap_or(2)
            .clamp(2, 8);
        tokio::sync::Semaphore::new(n)
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

/// Byte ASLI satu URL yang sudah tersimpan di cache disk.
///
/// Dipakai unduhan PDF: halaman yang sudah pernah dibaca (reader selalu
/// mengisi cache raw) tidak perlu diunduh ulang dari CDN — hemat satu
/// round-trip per halaman, dan tetap benar karena kuncinya URL (byte identik
/// dengan yang diterima /img). None = belum ada di cache.
pub fn cached_raw(url: &str) -> Option<Vec<u8>> {
    let path = raw_cache_path(&sha1_hex(url));
    match std::fs::read(&path) {
        Ok(b) if !b.is_empty() => Some(b),
        _ => None,
    }
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

/// AVIF dimatikan: klien web tidak pernah meminta lebar 160–320
/// (READER_WIDTHS=[480,640,900], LQIP kosong), dan encode AVIF mahal
/// (1.8–5.3 s/gambar, 24.8 s untuk 8 paralel). Selalu WebP. Jalan encode
/// AVIF (`resize_encode_avif`) dibiarkan utuh tapi tidak pernah dipicu.
fn negotiated_format(_accepts_avif: bool, _raw_w: u32) -> ImgFormat {
    ImgFormat::WebP
}

/// Dimensi asli (width×height) per URL upstream, direkam saat encode sukses.
/// Keyed by upstream URL; dipakai `unified::fetch_chapter_payload` untuk mengisi
/// `image_sizes` (BE-3) tanpa network — menggantikan probe range-GET yang
/// sia-sia (59% null untuk WebP lossy).
static ORIG_DIMS: OnceCell<std::sync::Mutex<HashMap<String, (u32, u32)>>> = OnceCell::new();

fn record_orig_dims(url: &str, w: u32, h: u32) {
    if let Ok(mut m) = ORIG_DIMS.get_or_init(|| std::sync::Mutex::new(HashMap::new())).lock() {
        m.insert(url.to_string(), (w, h));
    }
}

/// Query dimensi asli yang sudah direkam untuk URL upstream. `None` = belum
/// pernah di-encode sukses (MISS → frontend fallback rasio 0.685).
pub fn known_orig_dims(url: &str) -> Option<(u32, u32)> {
    ORIG_DIMS.get()?.lock().ok()?.get(url).copied()
}

/// Decode → resize (lebar `w`, rasio dipertahankan) → WebP lossy.
/// Kualitas diturunkan untuk gambar kecil: di 480 px q72 sudah tak terbedakan
/// dari aslinya di layar HP, dan selisih byte-nya besar.
fn resize_encode(src: &[u8], target_w: u32, url: &str) -> Result<Vec<u8>, String> {
    let img = image::load_from_memory(src).map_err(|e| format!("decode: {e}"))?;
    let (sw, sh) = (img.width(), img.height());
    if sw == 0 || sh == 0 {
        return Err("dimensi tak valid".into());
    }
    let w = target_w.min(sw); // jangan pernah memperbesar (byte naik, tak berguna)
    let h = ((sh as u64 * w as u64) / sw as u64).max(1) as u32;
    let small = if w == sw {
        img
    } else if w <= 160 {
        // LQIP reader (96 px) — hasilnya di-blur, jadi box-filter (`thumbnail`)
        // sudah cukup: 8x lebih cepat dari Triangle (terukur 41 vs 325 ms untuk
        // banner 720x8300) tanpa beda kasat mata di 96 px.
        img.thumbnail(w, h)
    } else {
        // Lanczos3 lebih tajam untuk line-art manga; Triangle dipakai kalau
        // gambarnya besar supaya CPU tidak meledak (rasio downscale ekstrem).
        // Ambang 2M px: banner halaman (720x8300-plus = 6-7M px) jatuh ke Triangle
        // (cepat), halaman normal (720x1200 ≈ 0.9M px) tetap Lanczos3.
        let filter = if (sw as u64 * sh as u64) > 2_000_000 {
            FilterType::Triangle
        } else {
            FilterType::Lanczos3
        };
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
    // thread_level=1: libwebp pakai multi-core (terukur encode 647→454 ms di
    // 4 core). Sama byte (172146), sekadar lebih cepat.
    let mut cfg = webp::WebPConfig::new().map_err(|_| "config".to_string())?;
    cfg.quality = q;
    cfg.thread_level = 1;
    let out = enc.encode_advanced(&cfg).map_err(|e| format!("encode: {e:?}"))?.to_vec();
    record_orig_dims(url, sw, sh);
    Ok(out)
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
        .as_chunks::<3>()
        .0
        .iter()
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
///
/// Rekursif satu tingkat: cache raw (`raw/<2 hex>/<sha>.bin`) bersarang lebih
/// dalam dari shard biasa (`<2 hex>/<sha>.webp`). Tanpa rekursi, file raw
/// lolos dari penghitungan & evict — 66 MB dari 75 MB baseline ada di sana.
fn evict_if_needed() {
    fn collect(
        dir: &Path,
        entries: &mut Vec<(std::time::SystemTime, u64, PathBuf)>,
        total: &mut u64,
    ) {
        let Ok(children) = std::fs::read_dir(dir) else {
            return;
        };
        for c in children.flatten() {
            let p = c.path();
            let Ok(md) = c.metadata() else {
                continue;
            };
            if md.is_dir() {
                collect(&p, entries, total);
            } else {
                let t = md.modified().unwrap_or(std::time::SystemTime::UNIX_EPOCH);
                *total += md.len();
                entries.push((t, md.len(), p));
            }
        }
    }

    let dir = cache_dir();
    let mut entries: Vec<(std::time::SystemTime, u64, PathBuf)> = Vec::new();
    let mut total: u64 = 0;
    collect(dir, &mut entries, &mut total);
    if total < CACHE_CAP_TRIGGER_BYTES {
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
    // lebar thumbnail sungguhan (160–320). WebP tetap default untuk yang lain.
    //
    // LQIP reader memakai lebar MINIMUM (96 px) dan di-blur. AVIF di ukuran itu
    // tidak terlihat bedanya, tapi encode-nya jauh lebih mahal: terukur 32 s vs
    // 4,3 s untuk satu halaman (cold, debug). Setiap halaman memicu satu LQIP,
    // jadi seluruh CPU server habis untuk placeholder dan halaman yang sedang
    // dibaca ikut tertunda. WebP sudah lebih dari cukup untuk blur 96 px.
    let accepts_avif = headers
        .get(header::ACCEPT)
        .and_then(|v| v.to_str().ok())
        .map(|v| v.split(',').any(|t| t.trim_start().starts_with("image/avif")))
        .unwrap_or(false);
    let fmt = negotiated_format(accepts_avif, raw_w);

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
                crate::resilience::stats::IMG_FAIL
                    .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
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

    // Slot encode (lihat `encode_gate`). Diambil SETELAH fetch: fetch itu IO,
    // tidak boleh memakan slot CPU.
    let _permit = encode_gate().acquire().await.ok();

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
                    let u = q.u.clone();
                    move || resize_encode(&src, target, &u)
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
            let u = q.u.clone();
            move || resize_encode(&src, target, &u)
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
    if fastrand_u32().is_multiple_of(512) {
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
        let out = resize_encode(&buf, 480, "https://x/1.webp").expect("encode");
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
        let out = resize_encode(&buf, 900, "https://x/2.webp").expect("encode");
        let back = image::load_from_memory(&out).expect("decode hasil");
        assert_eq!((back.width(), back.height()), (300, 400));
    }

    #[test]
    fn resize_lqip_96_memakai_thumbnail_dan_menghasilkan_dimensi_benar() {
        // LQIP 96 px: box-filter (thumbnail) tetap harus menjaga rasio.
        let mut buf = Vec::new();
        let img = image::RgbImage::from_pixel(900, 1200, image::Rgb([200, 200, 200]));
        image::DynamicImage::ImageRgb8(img)
            .write_to(&mut std::io::Cursor::new(&mut buf), image::ImageFormat::Png)
            .unwrap();
        let out = resize_encode(&buf, 96, "https://x/3.webp").expect("encode");
        let back = image::load_from_memory(&out).expect("decode hasil");
        assert_eq!((back.width(), back.height()), (96, 128));
        assert!(out.len() < buf.len());
    }

    #[test]
    fn record_query_orig_dims_roundtrip() {
        // BE-3: encode sukses merekam dimensi asli; query mengembalikannya.
        let mut buf = Vec::new();
        let img = image::RgbImage::from_pixel(900, 1200, image::Rgb([200, 200, 200]));
        image::DynamicImage::ImageRgb8(img)
            .write_to(&mut std::io::Cursor::new(&mut buf), image::ImageFormat::Png)
            .unwrap();
        let url = "https://x/rt.webp";
        assert_eq!(known_orig_dims(url), None, "belum direkam");
        resize_encode(&buf, 480, url).expect("encode");
        assert_eq!(known_orig_dims(url), Some((900, 1200)));
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
    fn avif_dimatikan_selalu_webp() {
        // AVIF mati: semua kombinasi (termasuk klien yang minta image/avif di
        // lebar 160–320) harus WebP.
        for w in [0, 96, 160, 320, 321, 200] {
            assert!(
                matches!(negotiated_format(true, w), ImgFormat::WebP),
                "w={w} harus WebP"
            );
            assert!(matches!(negotiated_format(false, w), ImgFormat::WebP));
        }
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
