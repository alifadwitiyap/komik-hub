//! Store unduhan PDF server — state PER-AKUN, file PDF DIBAGI.
//!
//! Semua state di satu direktori (default `D:/project/komiku-server/downloads`,
//! bisa dioverride lewat env `KOMIKU_DOWNLOADS_DIR` untuk test):
//! - `<id>.pdf`             — file PDF hasil generate (DIBAGI antar-akun)
//! - `index/<username>.json`     — daftar unduhan milik satu akun
//! - `evictions/<username>.json` — log eviction milik satu akun
//! - `settings/<username>.json`  — limit unduhan milik satu akun
//! - `refs.json`            — {download_id: jumlah akun yang masih memegang}
//!
//! ## Kenapa per-akun
//! Dulu satu index global: PDF yang diunduh satu orang muncul di rak semua
//! orang. Index/evictions/settings kini per-akun; SATU file per akun (bukan
//! satu file besar) supaya satu akun menulis tidak menyentuh akun lain.
//!
//! ## File PDF tetap DIBAGI + refcount
//! `download_id = fnv1a64("handle|number")` (`download_id`) sudah
//! content-addressed: chapter yang sama = ID yang sama = satu file, walau 10
//! akun membacanya (disk dipakai sekali). Karena file dibagi tapi index
//! per-akun, menghapus unduhan HANYA boleh menghapus file fisik saat
//! `refs[id]` mencapai 0 — kalau tidak, satu orang hapus = orang lain
//! kehilangan PDF-nya. Refcount dinaikkan saat akun PERTAMA mengunduh id itu,
//! diturunkan saat akun menghapus/meng-evict entri terakhirnya.
//!
//! ## Kebijakan eviction (keputusan 8 plan, kini per-akun)
//! - Saat unduhan baru membuat total AKUN itu > `limit_bytes` (limit akun),
//!   hapus kandidat LRU milik akun itu sampai muat.
//! - TENGGANG 7 hari: entri dengan `downloaded_at` < 7 hari TIDAK boleh
//!   dihapus (baru diunduh tapi belum sempat dibaca = aman). Kalau setelah
//!   semua kandidat tenggang habis masih > limit, unduhan tetap disimpan
//!   (best-effort; limit adalah target lunak, data user tidak dibuang paksa).
//! - Tiap eviction dicatat di `evictions/<username>.json` + log `tracing::info!`.
//!
//! Satu mutex (`Mutex<State>`) memegang SEMUA akun + refcount: eviction &
//! refcount tetap serial, dan tidak ada beberapa lock yang bisa deadlock.
//! Setiap akses ke satu akun me-lazy-load file akun itu dari disk lebih dulu,
//! jadi state tetap benar setelah restart server.

use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use tokio::sync::Mutex;

/// Default limit disk unduhan per-akun: 2 GiB (keputusan 8 plan).
pub const DEFAULT_LIMIT_BYTES: u64 = 2 * 1024 * 1024 * 1024;
/// Tenggang eviction: entri lebih muda dari ini tidak boleh dihapus (keputusan 8).
pub const EVICTION_GRACE_SECS: i64 = 7 * 24 * 60 * 60;
/// Batas jumlah item log eviction yang disimpan.
const EVICTIONS_MAX: usize = 200;
/// Batas halaman per chapter saat generate PDF (pengaman memori).
pub const MAX_PAGES: usize = 300;

/// Satu entri unduhan (persis bentuk `items[]` kontrak API).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DownloadEntry {
    pub id: String,
    pub handle: String,
    pub number: String,
    pub title: String,
    pub series_title: String,
    /// Kunci judul ternormalisasi (untuk fitur lintas-sumber web).
    pub title_key: String,
    pub filename: String,
    pub size_bytes: u64,
    /// epoch millis
    pub downloaded_at: i64,
    /// epoch millis, di-update setiap GET file (LRU)
    pub last_opened_at: i64,
}

/// Satu baris log eviction (bentuk `items[]` kontrak `/api/unified/evictions`).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EvictionEntry {
    pub series_title: String,
    pub chapter_title: String,
    pub size_bytes: u64,
    /// epoch millis
    pub evicted_at: i64,
}

#[derive(Debug, Default, Serialize, Deserialize)]
struct Index {
    items: Vec<DownloadEntry>,
}

#[derive(Debug, Default, Serialize, Deserialize)]
struct EvictionLog {
    items: Vec<EvictionEntry>,
}

/// Refcount file PDF yang DIBAGI: download_id -> jumlah akun yang memegang.
#[derive(Debug, Default, Serialize, Deserialize)]
struct RefsLog {
    #[serde(default)]
    refs: BTreeMap<String, usize>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Settings {
    pub limit_bytes: u64,
}

impl Default for Settings {
    fn default() -> Self {
        Settings { limit_bytes: DEFAULT_LIMIT_BYTES }
    }
}

/// State satu akun (index + evictions + settings).
#[derive(Default)]
struct UserState {
    index: Index,
    evictions: EvictionLog,
    settings: Settings,
}

impl UserState {
    /// Muat state satu akun dari disk (file rusak/hilang -> default).
    fn load(dir: &Path, username: &str) -> Self {
        UserState {
            index: read_json(&index_path(dir, username)).unwrap_or_default(),
            evictions: read_json(&evictions_path(dir, username)).unwrap_or_default(),
            settings: read_json(&settings_path(dir, username)).unwrap_or_default(),
        }
    }
}

/// State seluruh akun + refcount file yang dibagi.
struct State {
    /// username -> index + evictions + settings
    users: BTreeMap<String, UserState>,
    /// download_id -> jumlah akun yang masih memegang file PDF itu
    refs: BTreeMap<String, usize>,
}

/// Store unduhan: direktori + state per-akun di memory, ditulis balik ke disk
/// setiap mutasi (file kecil per akun; tahan restart server).
pub struct DownloadStore {
    dir: PathBuf,
    /// Semua state di balik SATU mutex: generate (yang butuh lock panjang),
    /// eviction, refcount, dan update LRU harus serial.
    state: Mutex<State>,
}

// ---- path helper (per-akun + refs) ----------------------------------------

fn index_path(dir: &Path, username: &str) -> PathBuf {
    dir.join("index").join(format!("{username}.json"))
}
fn evictions_path(dir: &Path, username: &str) -> PathBuf {
    dir.join("evictions").join(format!("{username}.json"))
}
fn settings_path(dir: &Path, username: &str) -> PathBuf {
    dir.join("settings").join(format!("{username}.json"))
}
fn refs_path(dir: &Path) -> PathBuf {
    dir.join("refs.json")
}

/// Username yang punya file index di disk (untuk `get_any` lintas restart).
fn index_users(dir: &Path) -> Vec<String> {
    let mut out = Vec::new();
    let Ok(rd) = std::fs::read_dir(dir.join("index")) else {
        return out;
    };
    for e in rd.flatten() {
        let p = e.path();
        if p.extension().and_then(|x| x.to_str()) != Some("json") {
            continue;
        }
        if let Some(stem) = p.file_stem().and_then(|s| s.to_str()) {
            if crate::user::normalize_username(stem).is_some() {
                out.push(stem.to_string());
            }
        }
    }
    out
}

impl DownloadStore {
    /// Buka store dari direktori (sub-dir per-akun dibuat kalau belum ada).
    /// Index/settings/refs yang rusak di-reset (bukan bikin server gagal start).
    pub fn open(dir: impl Into<PathBuf>) -> anyhow::Result<Arc<Self>> {
        let dir = dir.into();
        std::fs::create_dir_all(&dir)?;
        for sub in ["index", "evictions", "settings"] {
            let _ = std::fs::create_dir_all(dir.join(sub));
        }
        let refs: RefsLog = read_json(&refs_path(&dir)).unwrap_or_default();
        Ok(Arc::new(DownloadStore {
            dir,
            state: Mutex::new(State { users: BTreeMap::new(), refs: refs.refs }),
        }))
    }

    /// Ambil/buat state akun (lazy dari disk). Dibuat sekali lalu di-cache di
    /// memory; file disk hanya ditulis untuk akun yang berubah.
    fn ensure_user<'a>(dir: &Path, st: &'a mut State, username: &str) -> &'a mut UserState {
        st.users
            .entry(username.to_string())
            .or_insert_with(|| UserState::load(dir, username))
    }

    /// Path file PDF satu entri (DIBAGI antar-akun, content-addressed).
    pub fn pdf_path(&self, id: &str) -> PathBuf {
        self.dir.join(format!("{id}.pdf"))
    }

    /// ID deterministik dari identitas chapter.
    pub fn download_id(handle: &str, number: &str) -> String {
        format!("{:016x}", fnv1a64(format!("{handle}|{number}").as_bytes()))
    }

    /// Nama file attachment yang aman + informatif.
    pub fn filename_for(series_title: &str, number: &str) -> String {
        format!("{} - Chapter {}.pdf", sanitize(series_title), sanitize(number))
    }

    /// Daftar unduhan MILIK `username` (urut terbaru dulu) + total + limit akun.
    pub async fn list(&self, username: &str) -> (Vec<DownloadEntry>, u64, u64) {
        let mut st = self.state.lock().await;
        let u = Self::ensure_user(&self.dir, &mut st, username);
        let mut items = u.index.items.clone();
        items.sort_by(|a, b| b.downloaded_at.cmp(&a.downloaded_at));
        let total = items.iter().map(|e| e.size_bytes).sum();
        (items, total, u.settings.limit_bytes)
    }

    /// Satu entri milik `username` by id (akun lain tidak bisa melihatnya).
    pub async fn get(&self, username: &str, id: &str) -> Option<DownloadEntry> {
        let mut st = self.state.lock().await;
        let u = Self::ensure_user(&self.dir, &mut st, username);
        u.index.items.iter().find(|e| e.id == id).cloned()
    }

    /// Cari entri `id` di SEMUA akun (untuk melayani unduhan file yang dibagi
    /// lewat navigasi browser tanpa header — metadata-nya diambil dari pemegang
    /// mana pun). Dipakai HANYA setelah refcount dipastikan > 0.
    pub async fn get_any(&self, id: &str) -> Option<DownloadEntry> {
        let mut st = self.state.lock().await;
        // kandidat: akun yang sudah di memory + yang punya file index di disk
        // (penting lintas restart: map in-memory masih kosong saat request
        // pertama datang lewat navigasi browser tanpa header).
        let mut names: Vec<String> = st.users.keys().cloned().collect();
        for u in index_users(&self.dir) {
            if !names.contains(&u) {
                names.push(u);
            }
        }
        for name in names {
            if let Some(e) = Self::ensure_user(&self.dir, &mut st, &name)
                .index
                .items
                .iter()
                .find(|e| e.id == id)
                .cloned()
            {
                return Some(e);
            }
        }
        None
    }

    /// Berapa akun yang masih memegang file PDF `id` (0 = tidak ada).
    pub async fn refcount(&self, id: &str) -> usize {
        let st = self.state.lock().await;
        st.refs.get(id).copied().unwrap_or(0)
    }

    /// Tandai entri MILIK `username` dibuka sekarang (LRU) + kembalikan entri.
    pub async fn touch(&self, username: &str, id: &str) -> Option<DownloadEntry> {
        let mut st = self.state.lock().await;
        let u = Self::ensure_user(&self.dir, &mut st, username);
        let now = now_millis();
        let entry = u.index.items.iter_mut().find(|e| e.id == id)?;
        entry.last_opened_at = now;
        let out = entry.clone();
        Self::save_index(&self.dir, username, &u.index);
        Some(out)
    }

    /// Hapus entri `id` MILIK `username` (+ turunkan refcount file). `false`
    /// kalau akun itu tidak punya entri tersebut. File fisik hanya dihapus
    /// saat refcount mencapai 0 (akun lain mungkin masih memakainya).
    pub async fn delete(&self, username: &str, id: &str) -> bool {
        let mut st = self.state.lock().await;
        let u = Self::ensure_user(&self.dir, &mut st, username);
        let before = u.index.items.len();
        u.index.items.retain(|e| e.id != id);
        if u.index.items.len() == before {
            return false;
        }
        Self::save_index(&self.dir, username, &u.index);
        Self::release_refs(&self.dir, &mut st, std::iter::once(id.to_string()));
        true
    }

    /// Hapus SEMUA unduhan MILIK `username` (modal settings "hapus semua").
    /// `true` kalau ada yang terhapus. File fisik dihapus hanya saat refcount 0.
    pub async fn clear_all(&self, username: &str) -> bool {
        let mut st = self.state.lock().await;
        let u = Self::ensure_user(&self.dir, &mut st, username);
        if u.index.items.is_empty() {
            return false;
        }
        let ids: Vec<String> = u.index.items.drain(..).map(|e| e.id).collect();
        Self::save_index(&self.dir, username, &u.index);
        Self::release_refs(&self.dir, &mut st, ids.into_iter());
        true
    }

    /// Settings unduhan MILIK `username`.
    pub async fn settings(&self, username: &str) -> Settings {
        let mut st = self.state.lock().await;
        Self::ensure_user(&self.dir, &mut st, username).settings.clone()
    }

    /// Set limit MILIK `username`; langsung eviction kalau total akun itu
    /// melewatinya. Mengembalikan (settings baru, jumlah eviction).
    pub async fn set_limit(&self, username: &str, limit_bytes: u64) -> (Settings, usize) {
        let mut st = self.state.lock().await;
        Self::ensure_user(&self.dir, &mut st, username).settings.limit_bytes = limit_bytes;
        let settings = Self::ensure_user(&self.dir, &mut st, username).settings.clone();
        Self::save_settings(&self.dir, username, &settings);
        let evicted = self.evict_locked(username, &mut st);
        (settings, evicted)
    }

    /// Daftar eviction MILIK `username` (terbaru dulu).
    pub async fn evictions(&self, username: &str) -> Vec<EvictionEntry> {
        let mut st = self.state.lock().await;
        let u = Self::ensure_user(&self.dir, &mut st, username);
        let mut items = u.evictions.items.clone();
        items.sort_by(|a, b| b.evicted_at.cmp(&a.evicted_at));
        items
    }

    /// Kosongkan log eviction MILIK `username` (dismiss badge).
    pub async fn dismiss_evictions(&self, username: &str) {
        let mut st = self.state.lock().await;
        let u = Self::ensure_user(&self.dir, &mut st, username);
        u.evictions.items.clear();
        Self::save_evictions(&self.dir, username, &u.evictions);
    }

    /// Simpan PDF yang sudah jadi untuk `username`: tulis file (dibagi),
    /// upsert entri di index akun, naikkan refcount kalau id ini BARU bagi akun
    /// itu, lalu eviction per-akun sampai total akun <= limit akun.
    pub async fn store_pdf(
        &self,
        username: &str,
        handle: &str,
        number: &str,
        title: &str,
        series_title: &str,
        title_key: &str,
        bytes: Vec<u8>,
    ) -> anyhow::Result<DownloadEntry> {
        let id = Self::download_id(handle, number);
        let filename = Self::filename_for(series_title, number);
        let size = bytes.len() as u64;
        let now = now_millis();

        let mut st = self.state.lock().await;
        std::fs::write(self.pdf_path(&id), &bytes)?;
        let entry = DownloadEntry {
            id: id.clone(),
            handle: handle.to_string(),
            number: number.to_string(),
            title: title.to_string(),
            series_title: series_title.to_string(),
            title_key: title_key.to_string(),
            filename,
            size_bytes: size,
            downloaded_at: now,
            last_opened_at: now,
        };
        let is_new = {
            let u = Self::ensure_user(&self.dir, &mut st, username);
            let is_new = !u.index.items.iter().any(|e| e.id == id);
            // upsert: unduhan ulang menimpa entri lama (id deterministik).
            u.index.items.retain(|e| e.id != id);
            u.index.items.push(entry.clone());
            Self::save_index(&self.dir, username, &u.index);
            is_new
        };
        if is_new {
            *st.refs.entry(id.clone()).or_insert(0) += 1;
            Self::save_refs(&self.dir, &st);
        }
        let evicted = self.evict_locked(username, &mut st);
        if evicted > 0 {
            tracing::info!(
                "unduhan {id} ({username}): {evicted} entri di-evict untuk memenuhi limit"
            );
        }
        Ok(entry)
    }

    /// Eviction LRU MILIK `username` sampai total akun <= limit akun. File fisik
    /// yang di-evict hanya dihapus saat refcount 0. Mengembalikan jumlah dihapus.
    fn evict_locked(&self, username: &str, st: &mut State) -> usize {
        let now = now_millis();
        let limit = match st.users.get(username) {
            Some(u) => u.settings.limit_bytes,
            None => return 0,
        };
        let mut removed: Vec<String> = Vec::new();
        {
            let Some(u) = st.users.get_mut(username) else {
                return 0;
            };
            loop {
                let total: u64 = u.index.items.iter().map(|e| e.size_bytes).sum();
                if total <= limit {
                    break;
                }
                // Kandidat: di luar tenggang 7 hari, terlama dibuka dulu.
                let Some(victim_idx) = u
                    .index
                    .items
                    .iter()
                    .enumerate()
                    .filter(|(_, e)| now - e.downloaded_at >= EVICTION_GRACE_SECS * 1000)
                    .min_by_key(|(_, e)| e.last_opened_at)
                    .map(|(i, _)| i)
                else {
                    // Semua kandidat masih dalam tenggang — berhenti (limit lunak).
                    break;
                };
                let victim = u.index.items.remove(victim_idx);
                u.evictions.items.push(EvictionEntry {
                    series_title: victim.series_title.clone(),
                    chapter_title: victim.title.clone(),
                    size_bytes: victim.size_bytes,
                    evicted_at: now,
                });
                tracing::info!(
                    "eviction: {} {} ({} byte, dibuka terakhir {})",
                    victim.series_title,
                    victim.title,
                    victim.size_bytes,
                    victim.last_opened_at
                );
                removed.push(victim.id);
            }
            if !removed.is_empty() {
                if u.evictions.items.len() > EVICTIONS_MAX {
                    let keep = u.evictions.items.len() - EVICTIONS_MAX;
                    u.evictions.items.drain(..keep);
                }
                Self::save_index(&self.dir, username, &u.index);
                Self::save_evictions(&self.dir, username, &u.evictions);
            }
        }
        let evicted = removed.len();
        if !removed.is_empty() {
            Self::release_refs(&self.dir, st, removed.into_iter());
        }
        evicted
    }

    /// Turunkan refcount untuk sekumpulan id; hapus file fisik + entri refs saat
    /// mencapai 0. Selalu menulis `refs.json` (satu file kecil).
    fn release_refs(dir: &Path, st: &mut State, ids: impl Iterator<Item = String>) {
        for id in ids {
            if let Some(rc) = st.refs.get_mut(&id) {
                *rc = rc.saturating_sub(1);
                if *rc == 0 {
                    st.refs.remove(&id);
                    let _ = std::fs::remove_file(dir.join(format!("{id}.pdf")));
                }
            }
        }
        let _ = write_json(&refs_path(dir), &RefsLog { refs: st.refs.clone() });
    }

    fn save_refs(dir: &Path, st: &State) {
        let _ = write_json(&refs_path(dir), &RefsLog { refs: st.refs.clone() });
    }

    fn save_index(dir: &Path, username: &str, idx: &Index) {
        let _ = write_json(&index_path(dir, username), idx);
    }
    fn save_evictions(dir: &Path, username: &str, ev: &EvictionLog) {
        let _ = write_json(&evictions_path(dir, username), ev);
    }
    fn save_settings(dir: &Path, username: &str, s: &Settings) {
        let _ = write_json(&settings_path(dir, username), s);
    }
}

// ------------------------------------------------------------------- util

fn now_millis() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// Ganti karakter yang tidak aman untuk nama file (Windows + header HTTP).
fn sanitize(s: &str) -> String {
    let out: String = s
        .chars()
        .map(|c| match c {
            '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|' | '\n' | '\r' | '\t' => '-',
            c if c.is_control() => '-',
            c => c,
        })
        .collect();
    let trimmed = out.trim().trim_matches('.').trim();
    if trimmed.is_empty() {
        "chapter".into()
    } else {
        // batasi panjang supaya header Content-Disposition tetap waras
        trimmed.chars().take(120).collect()
    }
}

/// fnv1a 64-bit (hash deterministik untuk id; tidak perlu kripto).
fn fnv1a64(bytes: &[u8]) -> u64 {
    let mut hash: u64 = 0xcbf29ce484222325;
    for b in bytes {
        hash ^= *b as u64;
        hash = hash.wrapping_mul(0x100000001b3);
    }
    hash
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
    // tulis atomik: tmp lalu rename, supaya index tidak setengah tertulis
    // kalau proses mati di tengah. Retry pendek untuk sharing violation
    // Windows (AV/pembaca lain memegang file sesaat).
    let tmp = path.with_extension("json.tmp");
    let mut last_err: Option<std::io::Error> = None;
    for attempt in 0..5u32 {
        match std::fs::write(&tmp, &raw).and_then(|()| std::fs::rename(&tmp, path)) {
            Ok(()) => return Ok(()),
            Err(e) => {
                last_err = Some(e);
                if attempt + 1 < 5 {
                    std::thread::sleep(std::time::Duration::from_millis(20 * (attempt as u64 + 1)));
                }
            }
        }
    }
    match last_err {
        Some(e) => Err(anyhow::Error::new(e).context(format!("gagal tulis {}", path.display()))),
        None => Err(anyhow::anyhow!("gagal tulis {}", path.display())),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "komiku-dl-{tag}-{}-{}",
            std::process::id(),
            now_millis()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        dir
    }

    fn entry(id: &str, size: u64, downloaded_at: i64, last_opened_at: i64) -> DownloadEntry {
        DownloadEntry {
            id: id.into(),
            handle: "komiku:1".into(),
            number: id.into(),
            title: format!("Chapter {id}"),
            series_title: "Series".into(),
            title_key: "series".into(),
            filename: format!("{id}.pdf"),
            size_bytes: size,
            downloaded_at,
            last_opened_at,
        }
    }

    // ---- ISOLASI LINTAS-AKUN ------------------------------------------

    #[tokio::test]
    async fn list_terpisah_per_akun() {
        let dir = temp_dir("iso-list");
        let store = DownloadStore::open(&dir).unwrap();
        let a = store
            .store_pdf("alif", "komiku:1", "1", "Ch 1", "Seri", "seri", vec![1u8; 100])
            .await
            .unwrap();
        let b = store
            .store_pdf("budi", "komiku:2", "2", "Ch 2", "Seri Lain", "seri lain", vec![2u8; 50])
            .await
            .unwrap();
        let (ia, ta, _) = store.list("alif").await;
        let (ib, tb, _) = store.list("budi").await;
        assert_eq!(ia.len(), 1);
        assert_eq!(ia[0].id, a.id);
        assert_eq!(ib.len(), 1);
        assert_eq!(ib[0].id, b.id);
        assert_eq!(ta, 100);
        assert_eq!(tb, 50);
        // A tidak bisa lihat entri B lewat get, dan sebaliknya.
        assert!(store.get("alif", &b.id).await.is_none());
        assert!(store.get("budi", &a.id).await.is_none());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn settings_per_akun() {
        let dir = temp_dir("settings-iso");
        let store = DownloadStore::open(&dir).unwrap();
        let (sa, _) = store.set_limit("alif", 1234).await;
        assert_eq!(sa.limit_bytes, 1234);
        assert_eq!(store.settings("alif").await.limit_bytes, 1234);
        assert_eq!(
            store.settings("budi").await.limit_bytes,
            DEFAULT_LIMIT_BYTES,
            "limit budi tidak ikut berubah"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn eviction_per_akun_tidak_menyentuh_akun_lain() {
        let dir = temp_dir("evict-iso");
        let store = DownloadStore::open(&dir).unwrap();
        let now = now_millis();
        let old = now - (EVICTION_GRACE_SECS + 60) * 1000;
        {
            // alif punya 3 entri lama (di luar tenggang), budi punya 1 entri lama.
            let mut st = store.state.lock().await;
            let u = DownloadStore::ensure_user(&store.dir, &mut st, "alif");
            u.settings.limit_bytes = 250;
            u.index.items.push(entry("a", 100, old, old));
            u.index.items.push(entry("b", 100, old, old + 1000));
            u.index.items.push(entry("c", 100, old, now));
            let ub = DownloadStore::ensure_user(&store.dir, &mut st, "budi");
            ub.index.items.push(entry("z", 100, old, old));
            st.refs.insert("z".into(), 1);
        }
        // unduhan baru alif -> total 400 > 250 -> buang 2 LRU milik alif saja.
        store
            .store_pdf("alif", "komiku:9", "9", "Ch 9", "S", "s", vec![2u8; 100])
            .await
            .unwrap();
        let (ia, ta, limit) = store.list("alif").await;
        assert_eq!(limit, 250);
        assert!(ta <= limit, "total alif {ta} harus <= {limit}");
        let ids: Vec<String> = ia.iter().map(|e| e.id.clone()).collect();
        assert!(!ids.contains(&"a".to_string()));
        assert!(!ids.contains(&"b".to_string()));
        assert!(ids.contains(&"c".to_string()));
        // budi tidak tersentuh.
        assert_eq!(store.list("budi").await.0.len(), 1);
        assert_eq!(store.refcount("z").await, 1, "refcount budi utuh");
        let _ = std::fs::remove_dir_all(&dir);
    }

    // ---- REFCOUNT file PDF yang DIBAGI --------------------------------

    #[tokio::test]
    async fn refcount_file_dibagi_hapus_terakhir() {
        let dir = temp_dir("refcount");
        let store = DownloadStore::open(&dir).unwrap();
        let ea = store
            .store_pdf("alif", "komiku:6426", "1195", "Ch 1195", "One Piece", "one piece", vec![7u8; 200])
            .await
            .unwrap();
        let eb = store
            .store_pdf("budi", "komiku:6426", "1195", "Ch 1195", "One Piece", "one piece", vec![7u8; 200])
            .await
            .unwrap();
        assert_eq!(ea.id, eb.id, "chapter sama -> satu id (content-addressed)");
        assert!(store.pdf_path(&ea.id).exists());
        assert_eq!(store.refcount(&ea.id).await, 2, "dua akun memegang file yang sama");

        // A hapus -> file HARUS masih ada, B tetap bisa ambil.
        assert!(store.delete("alif", &ea.id).await);
        assert!(store.pdf_path(&ea.id).exists(), "file masih dipakai budi");
        assert!(store.get("budi", &ea.id).await.is_some());
        assert_eq!(store.refcount(&ea.id).await, 1);
        assert!(store.list("alif").await.0.is_empty());

        // B hapus -> refcount 0 -> file hilang.
        assert!(store.delete("budi", &eb.id).await);
        assert!(!store.pdf_path(&eb.id).exists(), "refcount 0 -> file dihapus");
        assert_eq!(store.refcount(&eb.id).await, 0);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn unduh_ulang_akun_sama_tidak_menambah_refcount() {
        let dir = temp_dir("refcount-redo");
        let store = DownloadStore::open(&dir).unwrap();
        store.store_pdf("alif", "komiku:9", "9", "Ch 9", "S", "s", vec![1u8; 10]).await.unwrap();
        let e2 = store.store_pdf("alif", "komiku:9", "9", "Ch 9", "S", "s", vec![1u8; 10]).await.unwrap();
        assert_eq!(store.refcount(&e2.id).await, 1, "akun sama unduh ulang tidak menggandakan ref");
        assert_eq!(store.list("alif").await.0.len(), 1, "tetap satu entri (upsert)");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn state_per_akun_bertahan_lintas_restart() {
        // Buka-tutup store: index/settings/refs dibaca ulang dari disk, dan
        // `get_any` (jalur navigasi tanpa header) tetap menemukan file.
        let dir = temp_dir("restart");
        let id = {
            let store = DownloadStore::open(&dir).unwrap();
            store.set_limit("alif", 999).await;
            store
                .store_pdf("alif", "komiku:5", "5", "Ch 5", "S", "s", vec![4u8; 40])
                .await
                .unwrap()
                .id
        };
        let store2 = DownloadStore::open(&dir).unwrap();
        assert_eq!(store2.list("alif").await.0.len(), 1, "index akun bertahan");
        assert_eq!(store2.settings("alif").await.limit_bytes, 999, "settings bertahan");
        assert_eq!(store2.refcount(&id).await, 1, "refcount bertahan");
        assert!(store2.get_any(&id).await.is_some(), "get_any menemukan file lintas restart");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn clear_all_hanya_akun_itu() {
        let dir = temp_dir("clear-one");
        let store = DownloadStore::open(&dir).unwrap();
        let a = store.store_pdf("alif", "komiku:1", "1", "Ch 1", "S", "s", vec![1u8; 10]).await.unwrap();
        let b = store.store_pdf("budi", "komiku:2", "2", "Ch 2", "S", "s", vec![2u8; 10]).await.unwrap();
        assert!(store.clear_all("alif").await);
        assert!(store.list("alif").await.0.is_empty());
        assert_eq!(store.list("budi").await.0.len(), 1, "budi tak tersentuh");
        assert!(!store.pdf_path(&a.id).exists(), "file alif (ref 0) dihapus");
        assert!(store.pdf_path(&b.id).exists(), "file budi tetap");
        assert_eq!(store.refcount(&a.id).await, 0);
        assert_eq!(store.refcount(&b.id).await, 1);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn eviction_menurunkan_refcount_dan_menghapus_file_saat_nol() {
        let dir = temp_dir("evict-ref");
        let store = DownloadStore::open(&dir).unwrap();
        let now = now_millis();
        let old = now - (EVICTION_GRACE_SECS + 60) * 1000;
        // alif & budi sama-sama memegang id "shared"; alif juga punya entri lama
        // yang akan di-evict oleh limit kecil -> file "shared" TIDAK boleh hilang.
        {
            let mut st = store.state.lock().await;
            let u = DownloadStore::ensure_user(&store.dir, &mut st, "alif");
            u.settings.limit_bytes = 150;
            u.index.items.push(entry("shared", 100, old, old));
            u.index.items.push(entry("victim", 100, old, now));
            let ub = DownloadStore::ensure_user(&store.dir, &mut st, "budi");
            ub.index.items.push(entry("shared", 100, old, old));
            st.refs.insert("shared".into(), 2);
            st.refs.insert("victim".into(), 1);
        }
        // tulis file fisik kedua id supaya bisa dicek keberadaannya
        std::fs::write(store.pdf_path("shared"), b"x").unwrap();
        std::fs::write(store.pdf_path("victim"), b"x").unwrap();
        // unduhan baru alif (100 byte) -> total 300 > 150 -> evict 2 entri lama alif.
        store.store_pdf("alif", "komiku:9", "9", "Ch 9", "S", "s", vec![3u8; 100]).await.unwrap();
        // "shared" masih dipakai budi -> refcount turun ke 1, file tetap ada.
        assert!(store.pdf_path("shared").exists(), "shared masih dipakai budi");
        assert_eq!(store.refcount("shared").await, 1);
        // "victim" hanya milik alif -> refcount 0 -> file hilang.
        assert!(!store.pdf_path("victim").exists(), "victim ref 0 -> file dihapus");
        assert_eq!(store.refcount("victim").await, 0);
        let _ = std::fs::remove_dir_all(&dir);
    }

    // ---- perilaku lama (kini per-akun) --------------------------------

    #[tokio::test]
    async fn store_roundtrip_list_get_delete() {
        let dir = temp_dir("roundtrip");
        let store = DownloadStore::open(&dir).unwrap();
        let entry = store
            .store_pdf("alif", "komiku:1", "1", "Chapter 1", "Judul Seri", "judul seri", vec![1u8; 100])
            .await
            .unwrap();
        assert_eq!(entry.size_bytes, 100);
        assert_eq!(entry.title_key, "judul seri");

        let (items, total, limit) = store.list("alif").await;
        assert_eq!(items.len(), 1);
        assert_eq!(total, 100);
        assert_eq!(limit, DEFAULT_LIMIT_BYTES);

        let id = entry.id.clone();
        assert!(store.get("alif", &id).await.is_some());
        assert!(store.pdf_path(&id).exists());

        // LRU touch
        let before = store.get("alif", &id).await.unwrap().last_opened_at;
        tokio::time::sleep(std::time::Duration::from_millis(5)).await;
        let touched = store.touch("alif", &id).await.unwrap();
        assert!(touched.last_opened_at >= before);

        assert!(store.delete("alif", &id).await);
        assert!(!store.pdf_path(&id).exists());
        assert!(store.get("alif", &id).await.is_none());
        assert!(!store.delete("alif", &id).await, "hapus dua kali = false");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn eviction_respects_grace_and_lru() {
        let dir = temp_dir("evict");
        let store = DownloadStore::open(&dir).unwrap();
        let now = now_millis();
        let old = now - (EVICTION_GRACE_SECS + 60) * 1000;
        {
            // isi index manual: 3 entri 100 byte, semua di luar tenggang
            let mut st = store.state.lock().await;
            let u = DownloadStore::ensure_user(&store.dir, &mut st, "alif");
            u.settings.limit_bytes = 250; // -> 300 byte harus jadi <= 250
            u.index.items.push(entry("a", 100, old, old)); // paling lama dibuka
            u.index.items.push(entry("b", 100, old, old + 1000));
            u.index.items.push(entry("c", 100, old, now)); // terbaru
            st.refs.insert("a".into(), 1);
            st.refs.insert("b".into(), 1);
            st.refs.insert("c".into(), 1);
        }
        // unduhan baru (100 byte) -> total 400, limit 250 -> buang 2 LRU
        store
            .store_pdf("alif", "komiku:9", "9", "Ch 9", "Series", "series", vec![2u8; 100])
            .await
            .unwrap();
        let (items, total, limit) = store.list("alif").await;
        assert_eq!(limit, 250);
        assert!(total <= limit, "total {total} harus <= limit {limit}");
        let ids: Vec<String> = items.iter().map(|e| e.id.clone()).collect();
        assert!(!ids.contains(&"a".to_string()), "a (LRU) harus dibuang");
        assert!(!ids.contains(&"b".to_string()), "b harus dibuang");
        assert!(ids.contains(&"c".to_string()), "c terbaru tetap");
        let evictions = store.evictions("alif").await;
        assert_eq!(evictions.len(), 2);
        assert!(evictions.iter().any(|e| e.chapter_title == "Chapter a"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn eviction_skips_entries_inside_grace() {
        let dir = temp_dir("grace");
        let store = DownloadStore::open(&dir).unwrap();
        let now = now_millis();
        {
            let mut st = store.state.lock().await;
            let u = DownloadStore::ensure_user(&store.dir, &mut st, "alif");
            u.settings.limit_bytes = 50;
            // baru diunduh (dalam tenggang) — TIDAK boleh dihapus
            u.index.items.push(entry("fresh", 100, now, now));
            st.refs.insert("fresh".into(), 1);
        }
        store
            .store_pdf("alif", "komiku:2", "2", "Ch 2", "Series", "series", vec![3u8; 100])
            .await
            .unwrap();
        let (items, total, _) = store.list("alif").await;
        assert_eq!(items.len(), 2, "yang masih tenggang dipertahankan");
        assert!(total > 50, "limit lunak: data user tidak dibuang paksa");
        assert!(store.evictions("alif").await.is_empty());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn settings_persist_and_dismiss_evictions() {
        let dir = temp_dir("settings");
        let store = DownloadStore::open(&dir).unwrap();
        let (s, evicted) = store.set_limit("alif", 1234).await;
        assert_eq!(s.limit_bytes, 1234);
        assert_eq!(evicted, 0);
        store.dismiss_evictions("alif").await;
        drop(store);

        let store2 = DownloadStore::open(&dir).unwrap();
        assert_eq!(store2.settings("alif").await.limit_bytes, 1234, "settings persisten");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn set_limit_triggers_immediate_eviction() {
        let dir = temp_dir("setlimit");
        let store = DownloadStore::open(&dir).unwrap();
        let old = now_millis() - (EVICTION_GRACE_SECS + 60) * 1000;
        {
            let mut st = store.state.lock().await;
            let u = DownloadStore::ensure_user(&store.dir, &mut st, "alif");
            u.index.items.push(entry("x", 1000, old, old));
            st.refs.insert("x".into(), 1);
        }
        let (s, evicted) = store.set_limit("alif", 10).await;
        assert_eq!(s.limit_bytes, 10);
        assert_eq!(evicted, 1, "limit baru langsung memicu eviction");
        assert!(store.list("alif").await.0.is_empty());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn id_deterministic_and_filename_safe() {
        assert_eq!(
            DownloadStore::download_id("komiku:6426", "1195"),
            DownloadStore::download_id("komiku:6426", "1195")
        );
        assert_ne!(
            DownloadStore::download_id("komiku:6426", "1195"),
            DownloadStore::download_id("komiku:6426", "1196")
        );
        let f = DownloadStore::filename_for("One Piece: Romance Dawn /", "1195");
        assert!(!f.contains('/') && !f.contains(':'), "nama file: {f}");
        assert!(f.ends_with(".pdf"));
    }
}
