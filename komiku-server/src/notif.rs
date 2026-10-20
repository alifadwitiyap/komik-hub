//! notif.rs — notifier "favorit diupdate" lintas sumber (server-side), PER-AKUN.
//!
//! Menyimpan daftar favorit (kunci = `title_key` ternormalisasi lintas sumber),
//! baseline chapter per sumber, dan log notifikasi — SEMUANYA per-akun
//! (`data/users/<username>.json`). Pemeriksaan bersifat ON-DEMAND: TIDAK ada
//! loop interval latar (supaya server boleh tidur), satu siklus dijalankan
//! hanya saat `GET /api/notif/list` melihat `last_check_at` lebih tua dari TTL.
//! Siklus itu memeriksa setiap akun terhadap sumber aktif
//! (komiku/mangaku/shinigami/kiryuu) lewat `komik_core::aggregator`; chapter
//! baru (lebih tinggi dari baseline) menimbulkan SATU notifikasi per title_key
//! per akun.
//!
//! ## Kenapa per-akun
//! Dulu SATU slot global: `PUT /api/notif/favorites` replace-all membuat device
//! yang push terakhir menghapus favorit device lain, dan baseline global bikin
//! orang yang gabung belakangan kebanjiran notif chapter lama. Kini tiap akun
//! (header `X-Komik-User`) punya state sendiri; satu akun menulis tidak
//! menyentuh akun lain.
//!
//! ## Yang tetap DIBAGI
//! Cache fetch sumber (`cache`, key = `title_key`, TTL 30 menit) tetap GLOBAL:
//! 10 akun yang nge-favorit judul yang sama tetap memicu SATU fetch upstream.
//!
//! State satu akun: `<users_dir>/users/<username>.json` (penulisan atomik
//! temp+rename). Retensi: notifikasi lebih tua dari 7 hari dibuang tiap save.
//!
//! Handler stateless (store global OnceLock + aggregator statis), jadi router
//! bisa di-`.merge()` tanpa menyentuh `AppState` — pola sama seperti
//! `unified::unified_routes()`. Semua handler mengambil akun dari
//! `crate::user::require_user`.

use axum::{
    http::HeaderMap,
    routing::{get, post},
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
use crate::user::{require_user, user_file, users_dir};

/// Direktori akun default (relatif CWD server). Override `KOMIKU_USERS_DIR`
/// atau `KOMIKU_NOTIF_DIR` (lihat `crate::user::users_dir`).
fn data_dir() -> PathBuf {
    users_dir()
}

/// Retensi notifikasi: 7 hari.
const RETENTION_MS: i64 = 7 * 24 * 60 * 60 * 1000;
/// Cache in-memory per-series: 30 menit (menghindari menghammer sumber).
const CACHE_TTL_MS: i64 = 30 * 60 * 1000;
/// Batas chapter yang dimuat per sumber saat resolve (manga panjang).
const NOTIF_CHAPTER_LIMIT: u32 = 2000;
/// TTL default pemicu check ON-DEMAND di `GET /api/notif/list` (detik). Dulu ini
/// interval loop latar; loop-nya dihapus supaya server bisa tidur, jadi nilai
/// ini kini hanya jarak minimum antar siklus saat ada request /list.
const DEFAULT_INTERVAL_SECS: u64 = 1800;
/// Favorit di atas jumlah ini (TOTAL seluruh akun) -> TTL check digandakan.
const BIG_LIST_THRESHOLD: usize = 50;

/// UA Android: adapter komiku/mangaku/shinigami wajib UA mobile (sama seperti
/// `unified.rs`).
const UA_MOBILE: &str = "Mozilla/5.0 (Linux; Android 13; SM-S908B) AppleWebKit/537.36 \
                          (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36";

/// TTL pemicu on-demand dari `NOTIF_INTERVAL_SECS` (default 1800 detik).
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

/// State SATU akun.
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

/// Store notifikasi: state per-akun di balik satu mutex (serial tulis), cache
/// snapshot per-series TERPISAH dan GLOBAL (biar mutex state tak dipegang saat
/// fetch jaringan, dan fetch tetap dibagi antar-akun).
pub struct NotifStore {
    dir: PathBuf,
    /// username -> State. Lazy-load dari `<dir>/users/<username>.json`.
    state: Mutex<BTreeMap<String, State>>,
    /// title_key -> (fetched_at_ms, [(sumber, chapter_tertinggi)]) — GLOBAL.
    cache: Mutex<HashMap<String, (i64, Vec<(String, String)>)>>,
    /// Mutex "ada check cycle berjalan" — cegah cycle bertumpuk.
    /// Sengaja Mutex (bukan AtomicBool): guard dilepas otomatis saat task
    /// selesai ATAU panic, jadi penanda tidak bisa nyangkut selamanya dan
    /// mematikan check on-demand permanen.
    checking: Mutex<()>,
}

impl NotifStore {
    fn open(dir: impl Into<PathBuf>) -> anyhow::Result<Arc<Self>> {
        let dir = dir.into();
        if let Err(e) = std::fs::create_dir_all(&dir) {
            tracing::warn!("notif: gagal buat dir {}: {e}", dir.display());
        }
        Ok(Arc::new(NotifStore {
            dir,
            state: Mutex::new(BTreeMap::new()),
            cache: Mutex::new(HashMap::new()),
            checking: Mutex::new(()),
        }))
    }

    /// Ambil/buat state satu akun (lazy dari disk). Dibuat sekali lalu di-cache.
    fn ensure_user<'a>(
        dir: &Path,
        st: &'a mut BTreeMap<String, State>,
        username: &str,
    ) -> &'a mut State {
        st.entry(username.to_string())
            .or_insert_with(|| read_json(&user_file(dir, username)).unwrap_or_default())
    }

    /// Purge retensi (7 hari) lalu tulis atomik file SATU akun. Dipanggil setiap
    /// mutasi state akun itu.
    fn save_locked(&self, username: &str, st: &mut State) {
        let cutoff = now_millis().saturating_sub(RETENTION_MS);
        st.notifications.retain(|n| n.at >= cutoff);
        if let Err(e) = write_json(&user_file(&self.dir, username), st) {
            tracing::error!("notif: gagal tulis akun {username}: {e:#}");
        }
    }

    /// Snapshot chapter-tertinggi per sumber untuk satu favorit, dengan cache
    /// in-memory 30 menit (GLOBAL, key `title_key`). Fetch SUMBER di luar lock
    /// state.
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

    /// Favorit MILIK satu akun sebagai daftar ringkas (untuk GET
    /// /api/notif/favorites). Akun lain tidak bisa melihatnya.
    async fn favorites(&self, username: &str) -> Vec<FavOut> {
        let mut map = self.state.lock().await;
        let st = Self::ensure_user(&self.dir, &mut map, username);
        st.favorites
            .iter()
            .map(|(k, f)| FavOut {
                title_key: k.clone(),
                title: f.title.clone(),
                cover_url: f.cover_url.clone(),
                handle: f.handle.clone(),
                source: f.source.clone(),
            })
            .collect()
    }
}

/// Bentuk favorit untuk `GET /api/notif/favorites` (hydrate rak di web).
#[derive(Debug, Clone, Serialize, Deserialize)]
struct FavOut {
    title_key: String,
    title: String,
    cover_url: Option<String>,
    handle: String,
    source: String,
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

/// Store notifikasi global untuk handler. TIDAK ada loop latar: pemeriksaan
/// dijalankan on-demand dari `GET /api/notif/list` (lihat `get_list`), jadi
/// proses tidak bangun sendiri dan server boleh tidur.
fn store() -> &'static Arc<NotifStore> {
    static STORE: OnceLock<Arc<NotifStore>> = OnceLock::new();
    STORE.get_or_init(|| {
        let dir = data_dir();
        NotifStore::open(&dir).unwrap_or_else(|e| {
            tracing::error!("notif store gagal dibuka ({}): {e:#}", dir.display());
            NotifStore::open(std::env::temp_dir()).expect("temp dir selalu ada")
        })
    })
}

// ------------------------------------------------------------------ util

fn now_millis() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// Username akun yang punya file state di disk (untuk background checker yang
/// harus tetap jalan lintas restart, saat map in-memory masih kosong).
fn list_users(dir: &Path) -> Vec<String> {
    let mut out = Vec::new();
    let Ok(rd) = std::fs::read_dir(dir.join("users")) else {
        return out;
    };
    for e in rd.flatten() {
        let p = e.path();
        if p.extension().and_then(|x| x.to_str()) != Some("json") {
            continue;
        }
        if let Some(stem) = p.file_stem().and_then(|s| s.to_str()) {
            // hanya username valid (cegah memproses file sampah / path aneh).
            if crate::user::normalize_username(stem).is_some() {
                out.push(stem.to_string());
            }
        }
    }
    out
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
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
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
fn detect_new(
    baseline: &BTreeMap<String, String>,
    current: &[(String, String)],
) -> Option<(String, String)> {
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
fn detect_new_sources(
    baseline: &BTreeMap<String, String>,
    current: &[(String, String)],
) -> Vec<String> {
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

/// Terapkan snapshot "replace-all" favorit ke state SATU akun. Favorit yang
/// sudah ada mempertahankan BASELINES-nya (hanya metadata di-refresh); favorit
/// baru kunci title_key idempotent; favorit lama yang tak ada di input dibuang.
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
    let names: Vec<String> = agg
        .sources
        .iter()
        .map(|s| s.id().as_str().to_string())
        .collect();
    let mut out = Vec::new();
    let title = fav.title.as_str();
    for name in names {
        match agg
            .series_resolve(&fav.title, NOTIF_CHAPTER_LIMIT, Some(&name))
            .await
        {
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

/// Handle lengkap `sumber:native_id` dari favorit.
///
/// `Favorite.handle` bentuknya BEDA per sumber: flow unified sudah
/// menyertakan prefix sumber ("shinigami:6915ddaf-…"), flow lama komiku
/// hanya native id ("3922"). Menempelkan prefix tanpa cek menghasilkan
/// handle dobel ("komiku:komiku:6426") → `series_resolve` gagal → baseline
/// tak pernah terisi → notifikasi "chapter baru" mati untuk semua favorit
/// unified (bug nyata di data: baselines={} padahal handle-nya valid).
fn full_handle(source: &str, handle: &str) -> String {
    let handle = handle.trim();
    if handle.is_empty() {
        return format!("{source}:");
    }
    if handle.contains(':') {
        return handle.to_string();
    }
    format!("{source}:{handle}")
}

/// Baseline-fill untuk favorit baru MILIK `username`: ambil series dari
/// sumber/handle favorit (native id) lalu set baseline sumber itu = chapter
/// tertinggi saat ini. Hanya mengisi kalau baselines masih kosong (tak menimpa
/// riwayat).
async fn fill_baselines(store: &NotifStore, username: &str, key: &str) {
    let fav = {
        let mut map = store.state.lock().await;
        NotifStore::ensure_user(&store.dir, &mut map, username)
            .favorites
            .get(key)
            .cloned()
    };
    let Some(fav) = fav else { return };
    let handle = full_handle(&fav.source, &fav.handle);
    match aggregator()
        .series_resolve(&handle, NOTIF_CHAPTER_LIMIT, None)
        .await
    {
        Ok(o) => {
            let served = o.detail.manga.source.as_str().to_string();
            let Some(hi) = highest_chapter(&o.detail.chapters) else {
                return;
            };
            let mut map = store.state.lock().await;
            let st = NotifStore::ensure_user(&store.dir, &mut map, username);
            let do_save = match st.favorites.get_mut(key) {
                Some(f) if f.baselines.is_empty() => {
                    f.baselines.insert(served, hi.clone());
                    true
                }
                _ => false,
            };
            if do_save {
                store.save_locked(username, st);
                tracing::info!(
                    "notif: baseline '{key}' akun {username} terisi ({src}={hi})",
                    src = fav.source
                );
            }
        }
        Err(e) => tracing::warn!(
            "notif: baseline-fill '{title}' gagal: {e:#}",
            title = fav.title
        ),
    }
}

// ------------------------------------------------------------------ check cycle

/// Satu siklus pemeriksaan untuk SEMUA akun. Guard `checking` mencegah cycle
/// bertumpuk (dipicu GET /list saat TTL lewat). Fetch sumber tetap DIBAGI lewat
/// cache global `snapshot()`. Chapter baru -> 1 notifikasi per title_key per akun.
async fn run_check_cycle(store: Arc<NotifStore>) {
    // try_lock: kalau ada cycle berjalan, langsung keluar. Guard mutex
    // dipegang sampai fungsi selesai, termasuk saat return/panic -> tak
    // mungkin "nyangkut true" seperti AtomicBool manual.
    let Ok(_guard) = store.checking.try_lock() else {
        return; // sudah ada cycle berjalan
    };
    let now = now_millis();

    // Akun yang diproses: yang sudah dimuat di memory + yang punya file di disk
    // (penting lintas restart: map in-memory masih kosong saat cycle pertama).
    let mut usernames: Vec<String> = {
        let map = store.state.lock().await;
        map.keys().cloned().collect()
    };
    for u in list_users(&store.dir) {
        if !usernames.contains(&u) {
            usernames.push(u);
        }
    }
    if usernames.is_empty() {
        return; // tak ada akun -> tak ada yang perlu diperiksa
    }

    // Fase 1: tandai last_check_at + snapshot favorit per akun (di luar fetch).
    let mut per_user: Vec<(String, Vec<(String, Favorite)>)> = Vec::new();
    {
        let mut map = store.state.lock().await;
        for u in &usernames {
            let st = NotifStore::ensure_user(&store.dir, &mut map, u);
            st.last_check_at = Some(now);
            let favs = st
                .favorites
                .iter()
                .map(|(k, v)| (k.clone(), v.clone()))
                .collect();
            per_user.push((u.clone(), favs));
        }
        for (u, _) in &per_user {
            if let Some(st) = map.get_mut(u) {
                store.save_locked(u, st);
            }
        }
    }

    // Fase 2+3: fetch (di luar lock) lalu deteksi+mutasi per akun di bawah lock.
    for (username, favorites) in &per_user {
        let mut snaps: Vec<(String, Vec<(String, String)>)> = Vec::new();
        for (key, fav) in favorites {
            if fav.baselines.is_empty() {
                // Baseline kosong: coba isi sekarang (favorit lama yg fill-nya
                // gagal dulu, mis. karena handle dobel -> notifikasi mati
                // permanen). Cycle ini tetap melompatinya, jadi yang baru
                // terisi akan ternotifikasi pada cycle BERIKUTNYA.
                let s = store.clone();
                let u = username.clone();
                let k = key.clone();
                tokio::spawn(async move { fill_baselines(&s, &u, &k).await });
                continue;
            }
            let snap = store.snapshot(key, fav).await;
            snaps.push((key.clone(), snap));
        }
        if snaps.is_empty() {
            continue;
        }
        let mut map = store.state.lock().await;
        let st = NotifStore::ensure_user(&store.dir, &mut map, username);
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
                    let e = f
                        .baselines
                        .entry(src.clone())
                        .or_insert_with(|| num.clone());
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
        store.save_locked(username, st);
    }
    // guard `checking` dilepas di sini (akhir scope) — otomatis walau panic.
}

/// TTL efektif pemicu check ON-DEMAND: `NOTIF_INTERVAL_SECS` (default 1800),
/// DIGANDAKAN kalau jumlah favorit (TOTAL seluruh akun) > 50 (BIG_LIST_THRESHOLD).
/// Satu sumber kebenaran untuk jarak minimum antar siklus di `GET /api/notif/list`.
fn effective_interval(favorites_len: usize) -> Duration {
    let base = Duration::from_secs(interval_secs());
    if favorites_len > BIG_LIST_THRESHOLD {
        base.saturating_mul(2)
    } else {
        base
    }
}

// ------------------------------------------------------------------ handler

/// PUT /api/notif/favorites — replace-all snapshot MILIK akun; balas segera,
/// lalu spawn baseline-fill async utk favorit baru (respons TIDAK menunggu fill).
async fn put_favorites(headers: HeaderMap, Json(req): Json<PutFavoritesReq>) -> Res<Value> {
    let username = require_user(&headers)?;
    let store = store();
    let (count, new_keys) = {
        let mut map = store.state.lock().await;
        let st = NotifStore::ensure_user(&store.dir, &mut map, &username);
        let new_keys = apply_favorites(&mut st.favorites, req.favorites);
        let count = st.favorites.len();
        store.save_locked(&username, st);
        (count, new_keys)
    };
    let filling = new_keys.len();
    if filling > 0 {
        let s = store.clone();
        let user = username.clone();
        tokio::spawn(async move {
            for key in new_keys {
                fill_baselines(&s, &user, &key).await;
            }
        });
    }
    Ok(Json(
        json!({ "ok": true, "count": count, "filling": filling }),
    ))
}

/// GET /api/notif/favorites — favorit MILIK akun (hydrate rak di web).
async fn get_favorites(headers: HeaderMap) -> Res<Value> {
    let username = require_user(&headers)?;
    let favorites = store().favorites(&username).await;
    Ok(Json(json!({ "favorites": favorites })))
}

/// GET /api/notif/list — notifikasi MILIK akun (urut `at` DESC), unread,
/// last_check_at. Kalau sudah lewat TTL dan tak ada cycle berjalan: picu check
/// cycle async (fire-and-forget; respons tidak menunggu).
async fn get_list(headers: HeaderMap) -> Res<Value> {
    let username = require_user(&headers)?;
    let store = store();
    let now = now_millis();
    let (items, unread, last_check_at, should_check) = {
        let mut map = store.state.lock().await;
        let _ = NotifStore::ensure_user(&store.dir, &mut map, &username); // muat dulu
        let total: usize = map.values().map(|s| s.favorites.len()).sum();
        let st = map.get_mut(&username).expect("baru dimuat");
        let unread = st.notifications.iter().filter(|n| !n.read).count();
        let mut items = st.notifications.clone();
        items.sort_by(|a, b| b.at.cmp(&a.at));
        // TTL = interval efektif (jarak minimum antar siklus on-demand,
        // termasuk penggandaan saat total favorit > 50) supaya cadence check
        // konsisten dan tidak memblok request ini.
        let ttl = effective_interval(total).as_millis() as i64;
        let should_check = store.checking.try_lock().is_ok()
            && st
                .last_check_at
                .map_or(true, |t| now.saturating_sub(t) > ttl);
        (items, unread, st.last_check_at, should_check)
    };
    if should_check {
        let s = store.clone();
        tokio::spawn(async move { run_check_cycle(s).await });
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

/// POST /api/notif/read — {"ids":[...]} atau {"all":true}: tandai terbaca
/// (hanya notifikasi MILIK akun).
async fn mark_read(headers: HeaderMap, Json(req): Json<ReadReq>) -> Res<Value> {
    let username = require_user(&headers)?;
    let store = store();
    let mut map = store.state.lock().await;
    let st = NotifStore::ensure_user(&store.dir, &mut map, &username);
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
        store.save_locked(&username, st);
    }
    Ok(Json(json!({ "ok": true, "marked": marked })))
}

#[derive(Deserialize)]
struct DismissReq {
    id: String,
}

/// POST /api/notif/dismiss — {"id":"..."}: hapus satu notifikasi MILIK akun
/// (404 kalau tidak ada).
async fn dismiss(headers: HeaderMap, Json(req): Json<DismissReq>) -> Res<Value> {
    let username = require_user(&headers)?;
    let store = store();
    let removed = {
        let mut map = store.state.lock().await;
        let st = NotifStore::ensure_user(&store.dir, &mut map, &username);
        let before = st.notifications.len();
        st.notifications.retain(|n| n.id != req.id);
        let removed = st.notifications.len() != before;
        if removed {
            store.save_locked(&username, st);
        }
        removed
    };
    if removed {
        Ok(Json(json!({ "ok": true })))
    } else {
        Err(AppError::not_found(format!(
            "notifikasi {} tidak ditemukan",
            req.id
        )))
    }
}

// ------------------------------------------------------------------ router

/// Sub-router /api/notif. Stateless (store global), jadi Router<()> bisa
/// langsung di-`.merge()`. CORS permissive mengikuti router /api lain.
pub fn notif_routes() -> Router {
    Router::new()
        .route(
            "/api/notif/favorites",
            get(get_favorites).put(put_favorites),
        )
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

    /// Bug handle dobel: `Favorite.handle` unified sudah ber-prefix sumber,
    /// jadi menempelkan prefix lagi bikin "komiku:komiku:6426" → resolve
    /// gagal → baseline kosong → notifikasi chapter baru mati.
    #[test]
    fn full_handle_tidak_menempel_prefix_ganda() {
        // unified: handle sudah "sumber:native_id" -> dipakai apa adanya
        assert_eq!(
            full_handle("shinigami", "shinigami:6915ddaf-380a-47d8-aa8a-c48ba8778db5"),
            "shinigami:6915ddaf-380a-47d8-aa8a-c48ba8778db5"
        );
        // legacy komiku: native id polos -> prefix ditambahkan
        assert_eq!(full_handle("komiku", "3922"), "komiku:3922");
        // native id UUID tanpa prefix -> prefix ditambahkan
        assert_eq!(full_handle("kiryuu", "solo-leveling"), "kiryuu:solo-leveling");
        // tak boleh ada handle dobel
        assert!(!full_handle("komiku", "komiku:6426").contains("komiku:komiku"));
        // handle kosong -> tetap bentuk handle yang bisa dipakai
        assert_eq!(full_handle("komiku", ""), "komiku:");
    }

    #[test]
    fn effective_interval_doubles_above_threshold() {
        // <= 50 favorit: TTL dasar (override NOTIF_INTERVAL_SECS dihormati)
        assert_eq!(effective_interval(0), Duration::from_secs(interval_secs()));
        assert_eq!(
            effective_interval(BIG_LIST_THRESHOLD),
            Duration::from_secs(interval_secs()),
            "tepat 50 TIDAK digandakan (batas > 50)"
        );
        // > 50 favorit: digandakan (dipakai sebagai TTL pemicu GET /list)
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
        // (bukan "nyangkut true" seperti AtomicBool saat task gagal).
        let dir = temp_dir("checking-guard");
        let store = NotifStore::open(&dir).unwrap();
        assert!(store.checking.try_lock().is_ok(), "guard bebas saat idle");
        drop(store.checking.try_lock().unwrap());
        run_check_cycle(store.clone()).await; // tanpa akun: no-op
        assert!(
            store.checking.try_lock().is_ok(),
            "guard harus dilepas setelah cycle selesai"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn save_failure_keeps_store_alive() {
        // file user berupa DIREKTORI -> setiap save pasti gagal. Store harus
        // tetap terpakai (tidak panic, lock tetap bisa diambil).
        let dir = temp_dir("save-fail");
        std::fs::create_dir_all(&dir).unwrap();
        let store = NotifStore::open(&dir).unwrap();
        // bikin users/<u>.json sebagai DIREKTORI supaya write_json gagal.
        std::fs::create_dir_all(user_file(&dir, "alif")).unwrap();
        {
            let mut map = store.state.lock().await;
            let st = NotifStore::ensure_user(&store.dir, &mut map, "alif");
            st.notifications.push(notif("x", now_millis()));
            store.save_locked("alif", st); // gagal tulis -> ERROR log, tanpa panic
        }
        // store tetap hidup setelah kegagalan tulis
        assert!(store.checking.try_lock().is_ok());
        drop(store.checking.try_lock().unwrap());
        let mut map = store.state.lock().await;
        let st = NotifStore::ensure_user(&store.dir, &mut map, "alif");
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
        assert_eq!(
            detect_new(&base, &cur10),
            None,
            "string compare: 'extra-10' < 'extra-9'"
        );

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

    // ---- state persistence per-akun -----------------------------------

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
            let mut map = store.state.lock().await;
            let st = NotifStore::ensure_user(&store.dir, &mut map, "alif");
            let mut f = fav("3215", "komiku");
            f.baselines.insert("komiku".to_string(), "1195".to_string());
            st.favorites.insert("k1".to_string(), f);
            st.notifications.push(notif(&notif_id("k1", "1195"), now));
            st.last_check_at = Some(now);
            store.save_locked("alif", st);
        }
        // buka ulang dari disk
        let store2 = NotifStore::open(&dir).unwrap();
        let mut map = store2.state.lock().await;
        let st2 = NotifStore::ensure_user(&store2.dir, &mut map, "alif");
        assert_eq!(st2.favorites.len(), 1);
        assert_eq!(
            st2.favorites.get("k1").unwrap().baselines.get("komiku"),
            Some(&"1195".to_string())
        );
        assert_eq!(st2.notifications.len(), 1);
        assert_eq!(st2.notifications[0].id, notif_id("k1", "1195"));
        assert_eq!(st2.last_check_at, Some(now));
        // file benar-benar ada di lokasi schema per-akun
        assert!(
            user_file(&dir, "alif").ends_with("users/alif.json")
                || user_file(&dir, "alif")
                    .to_string_lossy()
                    .replace('\\', "/")
                    .ends_with("users/alif.json")
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn retention_purges_notifications_older_than_7_days() {
        let dir = temp_dir("retention");
        {
            let store = NotifStore::open(&dir).unwrap();
            let mut map = store.state.lock().await;
            let st = NotifStore::ensure_user(&store.dir, &mut map, "alif");
            let now = now_millis();
            st.notifications
                .push(notif("old", now - 8 * 24 * 60 * 60 * 1000));
            st.notifications.push(notif("fresh", now - 1000));
            store.save_locked("alif", st); // save = purge lalu tulis
        }
        let store2 = NotifStore::open(&dir).unwrap();
        let mut map = store2.state.lock().await;
        let st2 = NotifStore::ensure_user(&store2.dir, &mut map, "alif");
        assert_eq!(st2.notifications.len(), 1, "yang >7 hari dibuang");
        assert_eq!(st2.notifications[0].id, "fresh");
        let _ = std::fs::remove_dir_all(&dir);
    }

    // ---- ISOLASI LINTAS-AKUN ------------------------------------------

    #[tokio::test]
    async fn favorit_terpisah_per_akun() {
        let dir = temp_dir("iso-fav");
        let store = NotifStore::open(&dir).unwrap();
        {
            let mut map = store.state.lock().await;
            {
                let a = NotifStore::ensure_user(&store.dir, &mut map, "alif");
                a.favorites
                    .insert("one piece".into(), fav("3215", "komiku"));
            }
            {
                let b = NotifStore::ensure_user(&store.dir, &mut map, "budi");
                b.favorites.insert("naruto".into(), fav("99", "komiku"));
            }
            // simpan supaya juga teruji lewat disk
            {
                let a = NotifStore::ensure_user(&store.dir, &mut map, "alif");
                store.save_locked("alif", a);
            }
            {
                let b = NotifStore::ensure_user(&store.dir, &mut map, "budi");
                store.save_locked("budi", b);
            }
        }
        let fa = store.favorites("alif").await;
        let fb = store.favorites("budi").await;
        assert_eq!(fa.len(), 1);
        assert_eq!(fa[0].title_key, "one piece");
        assert_eq!(fb.len(), 1);
        assert_eq!(fb[0].title_key, "naruto");
        // favorit A tidak muncul di B.
        assert!(!fb.iter().any(|f| f.title_key == "one piece"));
        assert!(!fa.iter().any(|f| f.title_key == "naruto"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn notifikasi_dan_baseline_terpisah_per_akun() {
        let dir = temp_dir("iso-notif");
        let store = NotifStore::open(&dir).unwrap();
        let now = now_millis();
        {
            let mut map = store.state.lock().await;
            {
                let a = NotifStore::ensure_user(&store.dir, &mut map, "alif");
                let mut f = fav("3215", "komiku");
                f.baselines.insert("komiku".into(), "100".into());
                a.favorites.insert("k1".into(), f);
                a.notifications.push(notif("only-a", now));
            }
            {
                let b = NotifStore::ensure_user(&store.dir, &mut map, "budi");
                b.notifications.push(notif("only-b", now));
            }
        }
        let mut map = store.state.lock().await;
        let (a_notifs, a_baseline) = {
            let a = NotifStore::ensure_user(&store.dir, &mut map, "alif");
            (
                a.notifications
                    .iter()
                    .map(|n| n.id.clone())
                    .collect::<Vec<_>>(),
                a.favorites
                    .get("k1")
                    .and_then(|f| f.baselines.get("komiku").cloned()),
            )
        };
        let (b_notifs, b_fav_empty) = {
            let b = NotifStore::ensure_user(&store.dir, &mut map, "budi");
            (
                b.notifications
                    .iter()
                    .map(|n| n.id.clone())
                    .collect::<Vec<_>>(),
                b.favorites.is_empty(),
            )
        };
        assert_eq!(a_notifs, vec!["only-a".to_string()]);
        assert_eq!(b_notifs, vec!["only-b".to_string()]);
        // baseline milik alif tidak muncul di budi.
        assert!(b_fav_empty, "budi tidak punya favorit/baseline");
        assert_eq!(a_baseline, Some("100".to_string()));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn apply_favorites_hanya_menyentuh_akun_satu() {
        // replace-all satu akun tidak boleh menghapus favorit akun lain.
        let dir = temp_dir("iso-replace");
        let store = NotifStore::open(&dir).unwrap();
        {
            let mut map = store.state.lock().await;
            let a = NotifStore::ensure_user(&store.dir, &mut map, "alif");
            a.favorites
                .insert("one piece".into(), fav("3215", "komiku"));
            let b = NotifStore::ensure_user(&store.dir, &mut map, "budi");
            b.favorites.insert("naruto".into(), fav("99", "komiku"));
        }
        // alif push daftar KOSONG (replace-all) -> favoritnya hilang.
        {
            let mut map = store.state.lock().await;
            let a = NotifStore::ensure_user(&store.dir, &mut map, "alif");
            let new_keys = apply_favorites(&mut a.favorites, vec![]);
            assert!(new_keys.is_empty());
            store.save_locked("alif", a);
        }
        assert!(store.favorites("alif").await.is_empty(), "alif dikosongkan");
        assert_eq!(
            store.favorites("budi").await.len(),
            1,
            "budi TIDAK tersentuh"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    // ---- PUT replace-all semantics (per-akun, pure) -------------------

    #[test]
    fn replace_all_preserves_baselines_marks_new_and_drops_absent() {
        let mut state: BTreeMap<String, Favorite> = BTreeMap::new();
        // favorit lama k1 sudah punya baseline.
        let mut existing = fav("3215", "komiku");
        existing
            .baselines
            .insert("komiku".to_string(), "100".to_string());
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
        assert_eq!(
            k1.baselines.get("komiku"),
            Some(&"100".to_string()),
            "baseline lama tak hilang"
        );
        assert_eq!(k1.title, "Judul 1 baru");
        assert_eq!(k1.cover_url.as_deref(), Some("https://x/c.jpg"));
        // k2 baru dengan baselines kosong (butuh baseline-fill).
        assert!(state.get("k2").unwrap().baselines.is_empty());
        // k3 dibuang (replace-all).
        assert!(
            !state.contains_key("k3"),
            "favorit tak ada di input dibuang"
        );
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
