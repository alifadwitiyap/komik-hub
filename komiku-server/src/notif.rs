//! notif.rs — notifier "favorit diupdate" lintas sumber (server-side).
//!
//! Menyimpan daftar favorit (kunci = `title_key` ternormalisasi lintas sumber),
//! baseline chapter per sumber, dan log notifikasi. Satu interval tokio
//! memeriksa setiap favorit terhadap sumber aktif (komiku/mangaku/shinigami/
//! kiryuu) lewat `komik_core::aggregator`; chapter baru (lebih tinggi dari
//! baseline) menimbulkan SATU notifikasi per title_key.
//!
//! State di `data/state.json` (default relatif CWD = D:/project/komiku-server;
//! override `KOMIKU_NOTIF_DIR`). Penulisan atomik (temp + rename) seperti
//! `downloads.rs`. Retensi: notifikasi lebih tua dari 7 hari dibuang tiap save.
//!
//! Handler stateless (store global OnceLock + aggregator statis), jadi router
//! bisa di-`.merge()` tanpa menyentuh `AppState` — pola sama seperti
//! `unified::unified_routes()`.

use axum::{
    routing::{get, post, put},
    Json, Router,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::cmp::Ordering;
use std::collections::{BTreeMap, HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{Arc, OnceLock};
use std::time::Duration;
use tokio::sync::Mutex;

use komik_core::adapters::all_sources;
use komik_core::aggregator::Aggregator;
use komik_core::model::Chapter;
use komik_core::source::PER_SOURCE_TIMEOUT_SECS;

use crate::routes::{AppError, Res};

/// Direktori state default (relatif CWD server). Override `KOMIKU_NOTIF_DIR`.
fn data_dir() -> PathBuf {
    std::env::var_os("KOMIKU_NOTIF_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("data"))
}

/// Retensi notifikasi: 7 hari.
const RETENTION_MS: i64 = 7 * 24 * 60 * 60 * 1000;
/// Cache in-memory per-series: 30 menit (menghindari menghammer sumber).
const CACHE_TTL_MS: i64 = 30 * 60 * 1000;
/// Batas chapter yang dimuat per sumber saat resolve (manga panjang).
const NOTIF_CHAPTER_LIMIT: u32 = 2000;
/// Interval default background checker (detik).
const DEFAULT_INTERVAL_SECS: u64 = 1800;
/// Favorit di atas jumlah ini -> interval checker digandakan.
const BIG_LIST_THRESHOLD: usize = 50;

/// UA Android: adapter komiku/mangaku/shinigami wajib UA mobile (sama seperti
/// `unified.rs`).
const UA_MOBILE: &str = "Mozilla/5.0 (Linux; Android 13; SM-S908B) AppleWebKit/537.36 \
                          (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36";

fn interval_secs() -> u64 {
    std::env::var("NOTIF_INTERVAL_SECS")
        .ok()
        .and_then(|v| v.parse().ok())
        .filter(|&n| n > 0)
        .unwrap_or(DEFAULT_INTERVAL_SECS)
}

// ------------------------------------------------------------------ model

/// Satu favorit. Kunci map = `title_key`.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
struct Favorite {
    title: String,
    #[serde(default)]
    cover_url: Option<String>,
    handle: String,
    source: String,
    /// sumber -> nomor chapter tertinggi (string). Kosong = belum terisi
    /// baseline; favorit seperti ini DILEWATI checker sampai di-fill.
    #[serde(default)]
    baselines: BTreeMap<String, String>,
}

/// Satu baris notifikasi.
#[derive(Debug, Clone, Serialize, Deserialize)]
struct NotifEntry {
    id: String,
    title_key: String,
    title: String,
    /// handle series ('sumber:native_id' atau id lama) — tujuan navigasi
    /// baris notifikasi di web (/manga/<handle>). default utk state lama.
    #[serde(default)]
    handle: String,
    chapter: String,
    sources: Vec<String>,
    /// epoch millis
    at: i64,
    read: bool,
}

#[derive(Debug, Default, Serialize, Deserialize)]
struct State {
    #[serde(default)]
    favorites: BTreeMap<String, Favorite>,
    #[serde(default)]
    notifications: Vec<NotifEntry>,
    #[serde(default)]
    last_check_at: Option<i64>,
}

// ------------------------------------------------------------------ store

/// Store notifikasi: state di balik satu mutex (serial tulis), cache snapshot
/// per-series terpisah (biar mutex state tak dipegang saat fetch jaringan).
pub struct NotifStore {
    state_path: PathBuf,
    state: Mutex<State>,
    /// title_key -> (fetched_at_ms, [(sumber, chapter_tertinggi)])
    cache: Mutex<HashMap<String, (i64, Vec<(String, String)>)>>,
    /// Mutex "ada check cycle berjalan" — cegah cycle bertumpuk.
    /// Sengaja Mutex (bukan AtomicBool): guard dilepas otomatis saat task
    /// selesai ATAU panic, jadi penanda tidak bisa nyangkut selamanya dan
    /// mematikan checker latar permanen.
    checking: Mutex<()>,
}

impl NotifStore {
    fn open(dir: impl Into<PathBuf>) -> anyhow::Result<Arc<Self>> {
        let dir = dir.into();
        if let Err(e) = std::fs::create_dir_all(&dir) {
            tracing::warn!("notif: gagal buat dir {}: {e}", dir.display());
        }
        let state_path = dir.join("state.json");
        let state = read_json(&state_path).unwrap_or_default();
        Ok(Arc::new(NotifStore {
            state_path,
            state: Mutex::new(state),
            cache: Mutex::new(HashMap::new()),
            checking: Mutex::new(()),
        }))
    }

    /// Purge retensi (7 hari) lalu tulis atomik. Dipanggil setiap mutasi state.
    fn save_locked(&self, st: &mut State) {
        let cutoff = now_millis().saturating_sub(RETENTION_MS);
        st.notifications.retain(|n| n.at >= cutoff);
        if let Err(e) = write_json(&self.state_path, st) {
            tracing::error!("notif: gagal tulis {}: {e:#}", self.state_path.display());
        }
    }

    /// Snapshot chapter-tertinggi per sumber untuk satu favorit, dengan cache
    /// in-memory 30 menit. Fetch SUMBER di luar lock state.
    async fn snapshot(&self, key: &str, fav: &Favorite) -> Vec<(String, String)> {
        {
            let cache = self.cache.lock().await;
            if let Some((at, snap)) = cache.get(key) {
                if now_millis().saturating_sub(*at) < CACHE_TTL_MS {
                    return snap.clone();
                }
            }
        }
        let snap = fetch_snapshots(fav).await;
        {
            let mut cache = self.cache.lock().await;
            cache.insert(key.to_string(), (now_millis(), snap.clone()));
        }
        snap
    }
}

/// Satu instance Aggregator untuk proses ini (pola sama `unified::aggregator()`).
fn aggregator() -> &'static Aggregator {
    static AGG: OnceLock<Aggregator> = OnceLock::new();
    AGG.get_or_init(|| {
        let client = reqwest::Client::builder()
            .user_agent(UA_MOBILE)
            .timeout(std::time::Duration::from_secs(2 * PER_SOURCE_TIMEOUT_SECS))
            .build()
            .unwrap_or_default();
        Aggregator::new(all_sources(client))
    })
}

/// Store notifikasi global untuk handler + awal interval background.
fn store() -> &'static Arc<NotifStore> {
    static STORE: OnceLock<Arc<NotifStore>> = OnceLock::new();
    STORE.get_or_init(|| {
        let dir = data_dir();
        let s = NotifStore::open(&dir).unwrap_or_else(|e| {
            tracing::error!("notif store gagal dibuka ({}): {e:#}", dir.display());
            NotifStore::open(std::env::temp_dir()).expect("temp dir selalu ada")
        });
        // Interval checker dijalankan sekali di latar (butuh runtime tokio —
        // handler selalu dipanggil di dalam runtime).
        if tokio::runtime::Handle::try_current().is_ok() {
            tokio::spawn(background_checker(s.clone()));
        }
        s
    })
}

// ------------------------------------------------------------------ util

fn now_millis() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

fn read_json<T: for<'de> Deserialize<'de>>(path: &Path) -> Option<T> {
    let raw = std::fs::read_to_string(path).ok()?;
    match serde_json::from_str(&raw) {
        Ok(v) => Some(v),
        Err(e) => {
            tracing::warn!("{} rusak, di-reset: {e}", path.display());
            None
        }
    }
}

fn write_json<T: Serialize>(path: &Path, value: &T) -> anyhow::Result<()> {
    let raw = serde_json::to_vec_pretty(value)?;
    // atomik: tmp lalu rename, supaya state tidak setengah tertulis.
    let tmp = path.with_extension("json.tmp");
    // Windows: rename bisa kena sharing violation sesaat (pembaca lain/AV
    // sedang memegang state.json). Tanpa retry, save gagal SENYAP: state
    // memori dan file jadi beda padahal handler sudah balas 200. Retry
    // pendek (total <= ~200ms) dulu, baru menyerah.
    let mut last_err: Option<std::io::Error> = None;
    for attempt in 0..5u32 {
        match std::fs::write(&tmp, &raw).and_then(|()| std::fs::rename(&tmp, path)) {
            Ok(()) => return Ok(()),
            Err(e) => {
                last_err = Some(e);
                if attempt + 1 < 5 {
                    std::thread::sleep(Duration::from_millis(20 * (attempt as u64 + 1)));
                }
            }
        }
    }
    match last_err {
        Some(e) => Err(anyhow::Error::new(e).context(format!("gagal tulis {}", path.display()))),
        None => Err(anyhow::anyhow!("gagal tulis {}", path.display())),
    }
}

/// Bandingkan nomor chapter: numerik kalau dua-duanya parse f64, selain itu
/// leksikografis (string). Kembalikan Ordering.
fn cmp_num_or_str(a: &str, b: &str) -> Ordering {
    match (a.trim().parse::<f64>(), b.trim().parse::<f64>()) {
        (Ok(x), Ok(y)) => x.partial_cmp(&y).unwrap_or(Ordering::Equal),
        _ => a.cmp(b),
    }
}

/// Chapter tertinggi (string) dari daftar source; `None` kalau kosong.
fn highest_chapter(chapters: &[Chapter]) -> Option<String> {
    chapters
        .iter()
        .map(|c| c.number.as_str())
        .max_by(|a, b| cmp_num_or_str(a, b))
        .map(|s| s.to_string())
}

/// ID notifikasi deterministik dari title_key+number (tanpa dep baru).
fn notif_id(title_key: &str, number: &str) -> String {
    format!("{:016x}", fnv1a(format!("{title_key}|{number}").as_bytes()))
}

/// fnv1a 64-bit (hash deterministik utk id; tidak perlu kripto).
fn fnv1a(bytes: &[u8]) -> u64 {
    let mut hash: u64 = 0xcbf29ce484222325;
    for b in bytes {
        hash ^= *b as u64;
        hash = hash.wrapping_mul(0x100000001b3);
    }
    hash
}

// ------------------------------------------------------------------ deteksi

/// Deteksi satu "chapter baru": sumber dengan nomor STRICTLY lebih tinggi dari
/// baseline-nya. Sumber tanpa baseline -> dilewati (None utk sumber itu).
/// Mengembalikan (sumber, nomor_tertinggi) dengan nomor TERBESAR di antara
/// kandidat baru — dipakai sbg nomor chapter notifikasi.
fn detect_new(baseline: &BTreeMap<String, String>, current: &[(String, String)]) -> Option<(String, String)> {
    let mut best: Option<(String, String)> = None;
    for (src, num) in current {
        let Some(base) = baseline.get(src) else {
            continue; // baseline belum ada -> jangan notifikasi (bab pre-existing)
        };
        if cmp_num_or_str(num, base) != Ordering::Greater {
            continue;
        }
        let better = match &best {
            None => true,
            Some((_, bnum)) => cmp_num_or_str(num, bnum) == Ordering::Greater,
        };
        if better {
            best = Some((src.clone(), num.clone()));
        }
    }
    best
}

/// Semua sumber yang muncul lebih tinggi dari baseline-nya (untuk field
/// `sources` pada notifikasi).
fn detect_new_sources(baseline: &BTreeMap<String, String>, current: &[(String, String)]) -> Vec<String> {
    current
        .iter()
        .filter_map(|(src, num)| {
            let base = baseline.get(src)?;
            (cmp_num_or_str(num, base) == Ordering::Greater).then(|| src.clone())
        })
        .collect()
}

// ------------------------------------------------------------------ PUT replace-all

#[derive(Deserialize)]
struct FavIn {
    title_key: String,
    title: String,
    #[serde(default)]
    cover_url: Option<String>,
    handle: String,
    source: String,
}

#[derive(Deserialize)]
struct PutFavoritesReq {
    favorites: Vec<FavIn>,
}

/// Terapkan snapshot "replace-all" favorit ke state. Favorit yang sudah ada
/// mempertahankan BASELINES-nya (hanya metadata di-refresh); favorit baru kunci
/// title_key idempotent; favorit lama yang tak ada di input dibuang.
/// Mengembalikan daftar title_key baru (baselines kosong, butuh baseline-fill).
fn apply_favorites(existing: &mut BTreeMap<String, Favorite>, incoming: Vec<FavIn>) -> Vec<String> {
    let incoming_keys: std::collections::BTreeSet<String> =
        incoming.iter().map(|f| f.title_key.clone()).collect();
    // replace-all: buang favorit yang tidak ada di daftar baru.
    existing.retain(|k, _| incoming_keys.contains(k));

    let mut new_keys = Vec::new();
    for fav in incoming {
        match existing.get_mut(&fav.title_key) {
            Some(ex) => {
                // sudah ada: refresh metadata, PERTAHANKAN baselines.
                ex.title = fav.title;
                ex.cover_url = fav.cover_url;
                ex.handle = fav.handle;
                ex.source = fav.source;
            }
            None => {
                new_keys.push(fav.title_key.clone());
                existing.insert(
                    fav.title_key.clone(),
                    Favorite {
                        title: fav.title,
                        cover_url: fav.cover_url,
                        handle: fav.handle,
                        source: fav.source,
                        baselines: BTreeMap::new(), // di-fill async
                    },
                );
            }
        }
    }
    new_keys
}

// ------------------------------------------------------------------ ambil data sumber

/// Snapshot chapter-tertinggi per sumber untuk satu favorit: resolve judul
/// (exact title_key via aggregator) di SETIAP sumber, ambil daftar chapter,
/// ambil nomor tertinggi. Kegagalan sumber -> log warn + LANJUT (jangan abort).
async fn fetch_snapshots(fav: &Favorite) -> Vec<(String, String)> {
    let agg = aggregator();
    let names: Vec<String> = agg.sources.iter().map(|s| s.id().as_str().to_string()).collect();
    let mut out = Vec::new();
    let title = fav.title.as_str();
    for name in names {
        match agg.series_resolve(&fav.title, NOTIF_CHAPTER_LIMIT, Some(&name)).await {
            Ok(o) => {
                if let Some(hi) = highest_chapter(&o.detail.chapters) {
                    out.push((name, hi));
                }
            }
            Err(e) => {
                tracing::warn!("notif: '{title}' sumber {name} gagal (lewati): {e:#}");
            }
        }
    }
    out
}

/// Baseline-fill untuk favorit baru: ambil series dari sumber/handle favorit
/// (native id) lalu set baseline sumber itu = chapter tertinggi saat ini.
/// Hanya mengisi kalau baselines masih kosong (tak menimpa riwayat).
async fn fill_baselines(store: &NotifStore, key: &str) {
    let fav = {
        let st = store.state.lock().await;
        st.favorites.get(key).cloned()
    };
    let Some(fav) = fav else { return };
    let handle = format!("{}:{}", fav.source, fav.handle);
    match aggregator().series_resolve(&handle, NOTIF_CHAPTER_LIMIT, None).await {
        Ok(o) => {
            let served = o.detail.manga.source.as_str().to_string();
            let Some(hi) = highest_chapter(&o.detail.chapters) else {
                return;
            };
            let mut st = store.state.lock().await;
            let do_save = match st.favorites.get_mut(key) {
                Some(f) if f.baselines.is_empty() => {
                    f.baselines.insert(served, hi.clone());
                    true
                }
                _ => false,
            };
            if do_save {
                store.save_locked(&mut st);
                tracing::info!("notif: baseline '{title_key}' terisi ({src}={hi})", title_key = key, src = fav.source);
            }
        }
        Err(e) => tracing::warn!("notif: baseline-fill '{title}' gagal: {e:#}", title = fav.title),
    }
}

// ------------------------------------------------------------------ check cycle

/// Satu siklus pemeriksaan. Guard `checking` mencegah cycle bertumpuk
/// (dipicu GET /list Dan interval). Adopsi baseline sumber baru secara diam;
/// chapter baru -> 1 notifikasi per title_key.
async fn run_check_cycle(store: &NotifStore) {
    // try_lock: kalau ada cycle berjalan, langsung keluar. Guard mutex
    // dipegang sampai fungsi selesai, termasuk saat return/panic -> tak
    // mungkin "nyangkut true" seperti AtomicBool manual.
    let Ok(_guard) = store.checking.try_lock() else {
        return; // sudah ada cycle berjalan
    };
    let now = now_millis();

    // Snapshot favorit + catat waktu mulai. Baselines diklone; fetch di luar lock.
    let favorites: Vec<(String, Favorite)> = {
        let mut st = store.state.lock().await;
        st.last_check_at = Some(now);
        st.favorites.iter().map(|(k, v)| (k.clone(), v.clone())).collect()
    };

    // Fetch snapshot per favorit di LUAR lock. Baselines kosong = DILEWATI.
    let mut snaps: Vec<(String, Vec<(String, String)>)> = Vec::new();
    for (key, fav) in &favorites {
        if fav.baselines.is_empty() {
            continue;
        }
        let snap = store.snapshot(key, fav).await;
        snaps.push((key.clone(), snap));
    }

    // Deteksi + mutasi baseline/notifikasi di bawah SATU lock.
    {
        let mut st = store.state.lock().await;
        for (key, snap) in &snaps {
            let notif: Option<NotifEntry> = {
                let Some(f) = st.favorites.get_mut(key) else {
                    continue;
                };
                if f.baselines.is_empty() {
                    continue;
                }
                let detection = detect_new(&f.baselines, snap);
                let srcs = detect_new_sources(&f.baselines, snap);
                // Naikkan/adopsi baseline ke snapshot terkini (tak pernah turun).
                for (src, num) in snap {
                    let e = f.baselines.entry(src.clone()).or_insert_with(|| num.clone());
                    if cmp_num_or_str(num, e) == Ordering::Greater {
                        *e = num.clone();
                    }
                }
                detection.map(|(_, max_num)| NotifEntry {
                    id: notif_id(key, &max_num),
                    title_key: key.clone(),
                    title: f.title.clone(),
                    handle: f.handle.clone(),
                    chapter: max_num,
                    sources: srcs,
                    at: now,
                    read: false,
                })
            };
            if let Some(n) = notif {
                if !st.notifications.iter().any(|e| e.id == n.id) {
                    st.notifications.push(n);
                }
            }
        }
        store.save_locked(&mut st);
    }
    // guard `checking` dilepas di sini (akhir scope) — otomatis walau panic.
}

/// Interval efektif: `NOTIF_INTERVAL_SECS` (default 1800), DIGANDAKAN kalau
/// jumlah favorit > 50 (BIG_LIST_THRESHOLD). Satu sumber kebenaran untuk
/// interval checker latar DAN TTL pemicu check di GET /list — sebelumnya
/// keduanya beda (get_list memakai interval dasar), jadi daftar besar
/// memicu cycle 2x lebih sering dari yang diperhitungkan.
fn effective_interval(favorites_len: usize) -> Duration {
    let base = Duration::from_secs(interval_secs());
    if favorites_len > BIG_LIST_THRESHOLD {
        base.saturating_mul(2)
    } else {
        base
    }
}

/// Interval checker latar. Dihitung ulang tiap iterasi (replace daftar favorit
/// bisa mengubahnya).
async fn background_checker(store: Arc<NotifStore>) {
    loop {
        let secs = {
            let st = store.state.lock().await;
            effective_interval(st.favorites.len())
        };
        tokio::time::sleep(secs.max(Duration::from_secs(1))).await;
        run_check_cycle(&store).await;
    }
}

// ------------------------------------------------------------------ handler

/// PUT /api/notif/favorites — replace-all snapshot; balas segera, lalu spawn
/// baseline-fill async utk favorit baru (respons TIDAK menunggu fill).
async fn put_favorites(Json(req): Json<PutFavoritesReq>) -> Res<Value> {
    let store = store();
    let (count, new_keys) = {
        let mut st = store.state.lock().await;
        let new_keys = apply_favorites(&mut st.favorites, req.favorites);
        let count = st.favorites.len();
        store.save_locked(&mut st);
        (count, new_keys)
    };
    let filling = new_keys.len();
    if filling > 0 {
        let s = store.clone();
        tokio::spawn(async move {
            for key in new_keys {
                fill_baselines(&s, &key).await;
            }
        });
    }
    Ok(Json(json!({ "ok": true, "count": count, "filling": filling })))
}

/// GET /api/notif/list — notifikasi (urut `at` DESC), unread, last_check_at.
/// Kalau sudah lewat TTL dan tak ada cycle berjalan: picu check cycle async
/// (fire-and-forget; respons tidak menunggu).
async fn get_list() -> Res<Value> {
    let store = store();
    let now = now_millis();
    let (items, unread, last_check_at, should_check) = {
        let st = store.state.lock().await;
        let unread = st.notifications.iter().filter(|n| !n.read).count();
        let mut items = st.notifications.clone();
        items.sort_by(|a, b| b.at.cmp(&a.at));
        // TTL = interval efektif (samakan dengan interval checker latar,
        // termasuk penggandaan saat favorit > 50) supaya cadence check
        // konsisten dan tidak memblok request ini.
        let ttl = effective_interval(st.favorites.len()).as_millis() as i64;
        let should_check = store.checking.try_lock().is_ok()
            && st.last_check_at.map_or(true, |t| now.saturating_sub(t) > ttl);
        (items, unread, st.last_check_at, should_check)
    };
    if should_check {
        let s = store.clone();
        tokio::spawn(async move { run_check_cycle(&s).await });
    }
    Ok(Json(json!({
        "items": items,
        "unread": unread,
        "last_check_at": last_check_at,
    })))
}

#[derive(Deserialize)]
struct ReadReq {
    #[serde(default)]
    ids: Option<Vec<String>>,
    #[serde(default)]
    all: Option<bool>,
}

/// POST /api/notif/read — {"ids":[...]} atau {"all":true}: tandai terbaca.
async fn mark_read(Json(req): Json<ReadReq>) -> Res<Value> {
    let store = store();
    let marked = {
        let mut st = store.state.lock().await;
        let mut marked = 0usize;
        if req.all.unwrap_or(false) {
            for n in st.notifications.iter_mut() {
                if !n.read {
                    n.read = true;
                    marked += 1;
                }
            }
        } else if let Some(ids) = &req.ids {
            let set: HashSet<&str> = ids.iter().map(String::as_str).collect();
            for n in st.notifications.iter_mut() {
                if !n.read && set.contains(n.id.as_str()) {
                    n.read = true;
                    marked += 1;
                }
            }
        }
        if marked > 0 {
            store.save_locked(&mut st);
        }
        marked
    };
    Ok(Json(json!({ "ok": true, "marked": marked })))
}

#[derive(Deserialize)]
struct DismissReq {
    id: String,
}

/// POST /api/notif/dismiss — {"id":"..."}: hapus satu notifikasi (404 kalau
/// tidak ada).
async fn dismiss(Json(req): Json<DismissReq>) -> Res<Value> {
    let store = store();
    let removed = {
        let mut st = store.state.lock().await;
        let before = st.notifications.len();
        st.notifications.retain(|n| n.id != req.id);
        let removed = st.notifications.len() != before;
        if removed {
            store.save_locked(&mut st);
        }
        removed
    };
    if removed {
        Ok(Json(json!({ "ok": true })))
    } else {
        Err(AppError::not_found(format!("notifikasi {} tidak ditemukan", req.id)))
    }
}

// ------------------------------------------------------------------ router

/// Sub-router /api/notif. Stateless (store global), jadi Router<()> bisa
/// langsung di-`.merge()`. CORS permissive mengikuti router /api lain.
pub fn notif_routes() -> Router {
    Router::new()
        .route("/api/notif/favorites", put(put_favorites))
        .route("/api/notif/list", get(get_list))
        .route("/api/notif/read", post(mark_read))
        .route("/api/notif/dismiss", post(dismiss))
        .layer(tower_http::cors::CorsLayer::permissive())
}

// ------------------------------------------------------------------ util tambahan

#[cfg(test)]
fn temp_dir(tag: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!(
        "komiku-notif-{tag}-{}-{}",
        std::process::id(),
        now_millis()
    ));
    let _ = std::fs::remove_dir_all(&dir);
    dir
}

// ------------------------------------------------------------------ test

#[cfg(test)]
mod tests {
    use super::*;

    // ---- interval efektif (penggandaan favorit besar) ------------------

    #[test]
    fn effective_interval_doubles_above_threshold() {
        // <= 50 favorit: interval dasar (override NOTIF_INTERVAL_SECS dihormati)
        assert_eq!(effective_interval(0), Duration::from_secs(interval_secs()));
        assert_eq!(
            effective_interval(BIG_LIST_THRESHOLD),
            Duration::from_secs(interval_secs()),
            "tepat 50 TIDAK digandakan (batas > 50)"
        );
        // > 50 favorit: digandakan (dipakai interval latar DAN TTL GET /list)
        assert_eq!(
            effective_interval(BIG_LIST_THRESHOLD + 1),
            Duration::from_secs(interval_secs() * 2)
        );
        assert_eq!(
            effective_interval(500),
            Duration::from_secs(interval_secs() * 2)
        );
    }

    #[tokio::test]
    async fn checking_guard_releases_after_cycle() {
        // Guard check cycle harus bebas lagi setelah run_check_cycle selesai
        // (bukan "nyangkut true" seperti AtomicBool manual saat task gagal).
        let dir = temp_dir("checking-guard");
        let store = NotifStore::open(&dir).unwrap();
        assert!(store.checking.try_lock().is_ok(), "guard bebas saat idle");
        drop(store.checking.try_lock().unwrap());
        run_check_cycle(&store).await; // tanpa favorit: no-op + save
        assert!(
            store.checking.try_lock().is_ok(),
            "guard harus dilepas setelah cycle selesai"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn save_failure_keeps_store_alive() {
        // state.json berupa DIREKTORI -> setiap save pasti gagal. Store harus
        // tetap terpakai (tidak panic, lock tetap bisa diambil) dan kegagalan
        // hanya di-log (lihat test write_json_* untuk sisi Err-nya).
        let dir = temp_dir("save-fail");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::create_dir_all(dir.join("state.json")).unwrap();
        let store = NotifStore::open(&dir).unwrap();
        {
            let mut st = store.state.lock().await;
            st.notifications.push(notif("x", now_millis()));
            store.save_locked(&mut st); // gagal tulis -> ERROR log, tanpa panic
        }
        // store tetap hidup setelah kegagalan tulis
        assert!(store.checking.try_lock().is_ok());
        drop(store.checking.try_lock().unwrap());
        let st = store.state.lock().await;
        assert_eq!(st.notifications.len(), 1, "state memori tetap utuh");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn write_json_retry_then_err_when_target_is_dir() {
        let dir = temp_dir("write-json-dir");
        std::fs::create_dir_all(&dir).unwrap();
        let target = dir.join("state.json");
        std::fs::create_dir_all(&target).unwrap(); // rename akan gagal
        let out = write_json(&target, &State::default());
        assert!(out.is_err(), "target berupa direktori -> Err setelah retry");
        let _ = std::fs::remove_dir_all(&dir);
    }

    // ---- detect_new ----------------------------------------------------

    #[test]
    fn detect_new_numeric() {
        let mut base = BTreeMap::new();
        base.insert("komiku".to_string(), "1194".to_string());
        let current = vec![("komiku".to_string(), "1195".to_string())];
        assert_eq!(
            detect_new(&base, &current),
            Some(("komiku".to_string(), "1195".to_string()))
        );
    }

    #[test]
    fn detect_new_decimal() {
        let mut base = BTreeMap::new();
        base.insert("kiryuu".to_string(), "44.1".to_string());
        let current = vec![("kiryuu".to_string(), "44.2".to_string())];
        assert_eq!(
            detect_new(&base, &current),
            Some(("kiryuu".to_string(), "44.2".to_string()))
        );
    }

    /// Fallback string: "extra-9" / "extra-10" TIDAK parse f64, jadi dibanding
    /// LEKSIKOGRAFIS — BUKAN numerik. Byte pertama yang beda setelah "extra-"
    /// adalah '1'(0x31) vs '9'(0x39); '1' < '9' sehingga "extra-10" < "extra-9"
    /// -> TIDAK dianggap baru. Perilaku ini dipatok (pin). Kontras berupa kasus
    /// positif string-benar: "extra-9" > "extra-1" (byte '9' > '1') -> terdeteksi.
    #[test]
    fn detect_new_string_fallback_is_lexicographic() {
        let mut base = BTreeMap::new();
        base.insert("mangaku".to_string(), "extra-9".to_string());
        // "extra-10" lexicographically LESS than "extra-9" -> NOT new.
        let cur10 = vec![("mangaku".to_string(), "extra-10".to_string())];
        assert_eq!(detect_new(&base, &cur10), None, "string compare: 'extra-10' < 'extra-9'");

        // Kasus positif string: '9'(0x39) > '1'(0x31) -> "extra-9" > "extra-1".
        let mut base2 = BTreeMap::new();
        base2.insert("mangaku".to_string(), "extra-1".to_string());
        let cur9 = vec![("mangaku".to_string(), "extra-9".to_string())];
        assert_eq!(
            detect_new(&base2, &cur9),
            Some(("mangaku".to_string(), "extra-9".to_string()))
        );
    }

    #[test]
    fn detect_new_equal_is_none() {
        let mut base = BTreeMap::new();
        base.insert("komiku".to_string(), "44.1".to_string());
        let current = vec![("komiku".to_string(), "44.1".to_string())];
        assert_eq!(detect_new(&base, &current), None);
    }

    #[test]
    fn detect_new_lower_is_none() {
        let mut base = BTreeMap::new();
        base.insert("komiku".to_string(), "1195".to_string());
        let current = vec![("komiku".to_string(), "1194".to_string())];
        assert_eq!(detect_new(&base, &current), None);
    }

    #[test]
    fn detect_new_missing_baseline_is_none() {
        let base = BTreeMap::new(); // kosong -> tak ada baseline
        let current = vec![("komiku".to_string(), "1195".to_string())];
        assert_eq!(detect_new(&base, &current), None);
    }

    #[test]
    fn detect_new_picks_highest_across_sources() {
        let mut base = BTreeMap::new();
        base.insert("komiku".to_string(), "10".to_string());
        base.insert("kiryuu".to_string(), "5".to_string());
        let current = vec![
            ("komiku".to_string(), "11".to_string()),
            ("kiryuu".to_string(), "6".to_string()),
        ];
        // komiku lebih tinggi (11 > 6) -> itu yang jadi nomor notifikasi.
        assert_eq!(
            detect_new(&base, &current),
            Some(("komiku".to_string(), "11".to_string()))
        );
        // dan sources = dua-duanya yang baru.
        let mut srcs = detect_new_sources(&base, &current);
        srcs.sort();
        assert_eq!(srcs, vec!["kiryuu".to_string(), "komiku".to_string()]);
    }

    // ---- state persistence --------------------------------------------

    fn fav(id: &str, source: &str) -> Favorite {
        Favorite {
            title: format!("Judul {id}"),
            cover_url: None,
            handle: id.to_string(),
            source: source.to_string(),
            baselines: BTreeMap::new(),
        }
    }

    fn notif(id: &str, at: i64) -> NotifEntry {
        NotifEntry {
            id: id.to_string(),
            title_key: "k".to_string(),
            title: "Judul".to_string(),
            handle: "3215".to_string(),
            chapter: "1".to_string(),
            sources: vec!["komiku".to_string()],
            at,
            read: false,
        }
    }

    #[tokio::test]
    async fn state_save_load_roundtrip() {
        let dir = temp_dir("roundtrip");
        let now = now_millis(); // timestamp segar supaya tak kena purge 7 hari
        {
            let store = NotifStore::open(&dir).unwrap();
            let mut st = store.state.lock().await;
            let mut f = fav("3215", "komiku");
            f.baselines.insert("komiku".to_string(), "1195".to_string());
            st.favorites.insert("k1".to_string(), f);
            st.notifications.push(notif(&notif_id("k1", "1195"), now));
            st.last_check_at = Some(now);
            store.save_locked(&mut st);
        }
        // buka ulang dari disk
        let store2 = NotifStore::open(&dir).unwrap();
        let st2 = store2.state.lock().await;
        assert_eq!(st2.favorites.len(), 1);
        assert_eq!(
            st2.favorites.get("k1").unwrap().baselines.get("komiku"),
            Some(&"1195".to_string())
        );
        assert_eq!(st2.notifications.len(), 1);
        assert_eq!(st2.notifications[0].id, notif_id("k1", "1195"));
        assert_eq!(st2.last_check_at, Some(now));
        // file benar-benar ada di lokasi schema
        assert!(store2.state_path.ends_with("state.json"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn retention_purges_notifications_older_than_7_days() {
        let dir = temp_dir("retention");
        {
            let store = NotifStore::open(&dir).unwrap();
            let mut st = store.state.lock().await;
            let now = now_millis();
            st.notifications.push(notif("old", now - 8 * 24 * 60 * 60 * 1000));
            st.notifications.push(notif("fresh", now - 1000));
            store.save_locked(&mut st); // save = purge lalu tulis
        }
        let store2 = NotifStore::open(&dir).unwrap();
        let st2 = store2.state.lock().await;
        assert_eq!(st2.notifications.len(), 1, "yang >7 hari dibuang");
        assert_eq!(st2.notifications[0].id, "fresh");
        let _ = std::fs::remove_dir_all(&dir);
    }

    // ---- PUT replace-all semantics ------------------------------------

    #[test]
    fn replace_all_preserves_baselines_marks_new_and_drops_absent() {
        let mut state: BTreeMap<String, Favorite> = BTreeMap::new();
        // favorit lama k1 sudah punya baseline.
        let mut existing = fav("3215", "komiku");
        existing.baselines.insert("komiku".to_string(), "100".to_string());
        state.insert("k1".to_string(), existing);
        // favorit lama k3 yang akan hilang (tidak ada di input baru).
        state.insert("k3".to_string(), fav("9", "mangaku"));

        // input baru: pertahankan k1, tambah k2 (k3 hilang).
        let incoming = vec![
            FavIn {
                title_key: "k1".to_string(),
                title: "Judul 1 baru".to_string(),
                cover_url: Some("https://x/c.jpg".to_string()),
                handle: "3215".to_string(),
                source: "komiku".to_string(),
            },
            FavIn {
                title_key: "k2".to_string(),
                title: "Judul 2".to_string(),
                cover_url: None,
                handle: "42".to_string(),
                source: "komiku".to_string(),
            },
        ];
        let new_keys = apply_favorites(&mut state, incoming);

        // hanya k2 baru.
        assert_eq!(new_keys, vec!["k2".to_string()]);
        // k1 baselines DIPERTAHANKAN, metadata di-refresh.
        let k1 = state.get("k1").unwrap();
        assert_eq!(k1.baselines.get("komiku"), Some(&"100".to_string()), "baseline lama tak hilang");
        assert_eq!(k1.title, "Judul 1 baru");
        assert_eq!(k1.cover_url.as_deref(), Some("https://x/c.jpg"));
        // k2 baru dengan baselines kosong (butuh baseline-fill).
        assert!(state.get("k2").unwrap().baselines.is_empty());
        // k3 dibuang (replace-all).
        assert!(!state.contains_key("k3"), "favorit tak ada di input dibuang");
    }

    #[test]
    fn replace_all_idempotent_marks_no_new_when_all_existing() {
        let mut state: BTreeMap<String, Favorite> = BTreeMap::new();
        state.insert("k1".to_string(), fav("3215", "komiku"));
        let incoming = vec![FavIn {
            title_key: "k1".to_string(),
            title: "Judul 1".to_string(),
            cover_url: None,
            handle: "3215".to_string(),
            source: "komiku".to_string(),
        }];
        let new_keys = apply_favorites(&mut state, incoming);
        assert!(new_keys.is_empty(), "favorit yang sudah ada bukan 'baru'");
    }
}
