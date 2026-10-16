//! Store unduhan PDF server (Lane A plan `rak-buku.md`).
//!
//! Semua state di satu direktori (default `D:/project/komiku-server/downloads`,
//! bisa dioverride lewat env `KOMIKU_DOWNLOADS_DIR` untuk test):
//! - `<id>.pdf`      — file PDF hasil generate
//! - `index.json`    — daftar entri unduhan (metadata + LRU timestamp)
//! - `evictions.json`— log eviction (untuk badge/notifikasi web)
//! - `settings.json` — pengaturan (limit_bytes, default 2 GiB)
//!
//! Kebijakan eviction (keputusan 8 plan):
//! - Saat unduhan baru membuat total > `limit_bytes`, hapus kandidat LRU
//!   (paling lama tidak dibuka) sampai muat.
//! - TENGGANG 7 hari: entri dengan `downloaded_at` < 7 hari TIDAK boleh
//!   dihapus (baru diunduh tapi belum sempat dibaca = aman). Kalau setelah
//!   semua kandidat tenggang habis masih > limit, unduhan tetap disimpan
//!   (best-effort; limit adalah target lunak, data user tidak dibuang paksa).
//! - Tiap eviction dicatat di `evictions.json` + log `tracing::info!`.
//!
//! ID unduhan = hash (fnv1a 64-bit hex) dari `handle|number` — deterministik,
//! aman untuk nama file, dan unduhan ulang chapter yang sama menimpa entri
//! lama alih-alih menduplikasi.

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use tokio::sync::Mutex;

/// Default limit disk unduhan: 2 GiB (keputusan 8 plan).
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

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Settings {
    pub limit_bytes: u64,
}

impl Default for Settings {
    fn default() -> Self {
        Settings { limit_bytes: DEFAULT_LIMIT_BYTES }
    }
}

/// Store unduhan: direktori + state index/settings di memory, ditulis balik
/// ke disk setiap mutasi (satu file kecil; tahan restart server).
pub struct DownloadStore {
    dir: PathBuf,
    /// Semua state di balik satu mutex: generate (yang butuh lock panjang),
    /// eviction, dan update LRU harus serial supaya limit tidak dilanggar dua
    /// request paralel.
    state: Mutex<State>,
}

struct State {
    index: Index,
    evictions: EvictionLog,
    settings: Settings,
}

impl DownloadStore {
    /// Buka store dari direktori (dibuat kalau belum ada). Index/settings yang
    /// rusak di-reset (bukan bikin server gagal start).
    pub fn open(dir: impl Into<PathBuf>) -> anyhow::Result<Arc<Self>> {
        let dir = dir.into();
        std::fs::create_dir_all(&dir)?;
        let index: Index = read_json(&dir.join("index.json")).unwrap_or_default();
        let evictions: EvictionLog = read_json(&dir.join("evictions.json")).unwrap_or_default();
        let settings: Settings = read_json(&dir.join("settings.json")).unwrap_or_default();
        Ok(Arc::new(DownloadStore {
            dir,
            state: Mutex::new(State { index, evictions, settings }),
        }))
    }

    /// Path file PDF satu entri.
    pub fn pdf_path(&self, id: &str) -> PathBuf {
        self.dir.join(format!("{id}.pdf"))
    }
    fn index_path(&self) -> PathBuf {
        self.dir.join("index.json")
    }

    fn evictions_path(&self) -> PathBuf {
        self.dir.join("evictions.json")
    }

    fn settings_path(&self) -> PathBuf {
        self.dir.join("settings.json")
    }

    /// ID deterministik dari identitas chapter.
    pub fn download_id(handle: &str, number: &str) -> String {
        format!("{:016x}", fnv1a64(format!("{handle}|{number}").as_bytes()))
    }

    /// Nama file attachment yang aman + informatif.
    pub fn filename_for(series_title: &str, number: &str) -> String {
        format!("{} - Chapter {}.pdf", sanitize(series_title), sanitize(number))
    }

    /// Daftar unduhan (urut terbaru dulu) + total + limit.
    pub async fn list(&self) -> (Vec<DownloadEntry>, u64, u64) {
        let st = self.state.lock().await;
        let mut items = st.index.items.clone();
        items.sort_by(|a, b| b.downloaded_at.cmp(&a.downloaded_at));
        let total = items.iter().map(|e| e.size_bytes).sum();
        (items, total, st.settings.limit_bytes)
    }

    /// Satu entri by id.
    pub async fn get(&self, id: &str) -> Option<DownloadEntry> {
        let st = self.state.lock().await;
        st.index.items.iter().find(|e| e.id == id).cloned()
    }

    /// Tandai entri dibuka sekarang (LRU) dan kembalikan entri terbaru.
    pub async fn touch(&self, id: &str) -> Option<DownloadEntry> {
        let mut st = self.state.lock().await;
        let now = now_millis();
        let entry = st.index.items.iter_mut().find(|e| e.id == id)?;
        entry.last_opened_at = now;
        let out = entry.clone();
        let _ = write_json(&self.index_path(), &st.index);
        Some(out)
    }

    /// Hapus entri + file PDF-nya. `false` = tidak ada entri itu.
    pub async fn delete(&self, id: &str) -> bool {
        let mut st = self.state.lock().await;
        let before = st.index.items.len();
        st.index.items.retain(|e| e.id != id);
        if st.index.items.len() == before {
            return false;
        }
        let _ = std::fs::remove_file(self.pdf_path(id));
        let _ = write_json(&self.index_path(), &st.index);
        true
    }

    /// Hapus SEMUA unduhan (modal settings: "hapus semua"). `true` kalau ada
    /// yang terhapus.
    pub async fn clear_all(&self) -> bool {
        let mut st = self.state.lock().await;
        if st.index.items.is_empty() {
            return false;
        }
        for e in st.index.items.drain(..) {
            let _ = std::fs::remove_file(self.pdf_path(&e.id));
        }
        let _ = write_json(&self.index_path(), &st.index);
        true
    }

    pub async fn settings(&self) -> Settings {
        let st = self.state.lock().await;
        st.settings.clone()
    }

    /// Set limit baru; langsung eviction kalau total sekarang melewatinya.
    /// Mengembalikan (settings baru, jumlah eviction yang terjadi).
    pub async fn set_limit(&self, limit_bytes: u64) -> (Settings, usize) {
        let mut st = self.state.lock().await;
        st.settings.limit_bytes = limit_bytes;
        let _ = write_json(&self.settings_path(), &st.settings);
        let evicted = self.evict_locked(&mut st);
        (st.settings.clone(), evicted)
    }

    /// Daftar eviction (terbaru dulu).
    pub async fn evictions(&self) -> Vec<EvictionEntry> {
        let st = self.state.lock().await;
        let mut items = st.evictions.items.clone();
        items.sort_by(|a, b| b.evicted_at.cmp(&a.evicted_at));
        items
    }

    /// Kosongkan log eviction (dismiss badge).
    pub async fn dismiss_evictions(&self) {
        let mut st = self.state.lock().await;
        st.evictions.items.clear();
        let _ = write_json(&self.evictions_path(), &st.evictions);
    }

    /// Simpan PDF yang sudah jadi: tulis file, upsert entri, lalu eviction
    /// sampai total (termasuk file baru) <= limit. Mengembalikan entri.
    pub async fn store_pdf(
        &self,
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
        // upsert: unduhan ulang menimpa entri lama (id deterministik).
        st.index.items.retain(|e| e.id != id);
        st.index.items.push(entry.clone());
        let _ = write_json(&self.index_path(), &st.index);
        let evicted = self.evict_locked(&mut st);
        if evicted > 0 {
            tracing::info!("unduhan {id}: {evicted} entri di-evict untuk memenuhi limit");
        }
        Ok(entry)
    }

    /// Eviction LRU sampai total <= limit. Mengembalikan jumlah yang dihapus.
    fn evict_locked(&self, st: &mut State) -> usize {
        let limit = st.settings.limit_bytes;
        let now = now_millis();
        let mut evicted = 0usize;
        loop {
            let total: u64 = st.index.items.iter().map(|e| e.size_bytes).sum();
            if total <= limit {
                break;
            }
            // Kandidat: di luar tenggang 7 hari, terlama dibuka dulu.
            let Some(victim_idx) = st
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
            let victim = st.index.items.remove(victim_idx);
            let _ = std::fs::remove_file(self.pdf_path(&victim.id));
            st.evictions.items.push(EvictionEntry {
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
            evicted += 1;
        }
        if evicted > 0 {
            if st.evictions.items.len() > EVICTIONS_MAX {
                let keep = st.evictions.items.len() - EVICTIONS_MAX;
                st.evictions.items.drain(..keep);
            }
            let _ = write_json(&self.index_path(), &st.index);
            let _ = write_json(&self.evictions_path(), &st.evictions);
        }
        evicted
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
    let raw = serde_json::to_vec_pretty(value)?;
    // tulis atomik: tmp lalu rename, supaya index tidak setengah tertulis
    // kalau proses mati di tengah.
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, raw)?;
    std::fs::rename(&tmp, path)?;
    Ok(())
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

    #[tokio::test]
    async fn store_roundtrip_list_get_delete() {
        let dir = temp_dir("roundtrip");
        let store = DownloadStore::open(&dir).unwrap();
        let entry = store
            .store_pdf("komiku:1", "1", "Chapter 1", "Judul Seri", "judul seri", vec![1u8; 100])
            .await
            .unwrap();
        assert_eq!(entry.size_bytes, 100);
        assert_eq!(entry.title_key, "judul seri");

        let (items, total, limit) = store.list().await;
        assert_eq!(items.len(), 1);
        assert_eq!(total, 100);
        assert_eq!(limit, DEFAULT_LIMIT_BYTES);

        let id = entry.id.clone();
        assert!(store.get(&id).await.is_some());
        assert!(store.pdf_path(&id).exists());

        // LRU touch
        let before = store.get(&id).await.unwrap().last_opened_at;
        tokio::time::sleep(std::time::Duration::from_millis(5)).await;
        let touched = store.touch(&id).await.unwrap();
        assert!(touched.last_opened_at >= before);

        assert!(store.delete(&id).await);
        assert!(!store.pdf_path(&id).exists());
        assert!(store.get(&id).await.is_none());
        assert!(!store.delete(&id).await, "hapus dua kali = false");
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
            st.settings.limit_bytes = 250; // -> 300 byte harus jadi <= 250
            st.index.items.push(entry("a", 100, old, old)); // paling lama dibuka
            st.index.items.push(entry("b", 100, old, old + 1000));
            st.index.items.push(entry("c", 100, old, now)); // terbaru
            let _ = write_json(&store.index_path(), &st.index);
        }
        // unduhan baru (100 byte) -> total 400, limit 250 -> buang 2 LRU
        store
            .store_pdf("komiku:9", "9", "Ch 9", "Series", "series", vec![2u8; 100])
            .await
            .unwrap();
        let (items, total, limit) = store.list().await;
        assert_eq!(limit, 250);
        assert!(total <= limit, "total {total} harus <= limit {limit}");
        let ids: Vec<String> = items.iter().map(|e| e.id.clone()).collect();
        assert!(!ids.contains(&"a".to_string()), "a (LRU) harus dibuang");
        assert!(!ids.contains(&"b".to_string()), "b harus dibuang");
        assert!(ids.contains(&"c".to_string()), "c terbaru tetap");
        let evictions = store.evictions().await;
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
            st.settings.limit_bytes = 50;
            // baru diunduh (dalam tenggang) — TIDAK boleh dihapus
            st.index.items.push(entry("fresh", 100, now, now));
        }
        store
            .store_pdf("komiku:2", "2", "Ch 2", "Series", "series", vec![3u8; 100])
            .await
            .unwrap();
        let (items, total, _) = store.list().await;
        assert_eq!(items.len(), 2, "yang masih tenggang dipertahankan");
        assert!(total > 50, "limit lunak: data user tidak dibuang paksa");
        assert!(store.evictions().await.is_empty());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn settings_persist_and_dismiss_evictions() {
        let dir = temp_dir("settings");
        let store = DownloadStore::open(&dir).unwrap();
        let (s, evicted) = store.set_limit(1234).await;
        assert_eq!(s.limit_bytes, 1234);
        assert_eq!(evicted, 0);
        store.dismiss_evictions().await;
        drop(store);

        let store2 = DownloadStore::open(&dir).unwrap();
        assert_eq!(store2.settings().await.limit_bytes, 1234, "settings persisten");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn set_limit_triggers_immediate_eviction() {
        let dir = temp_dir("setlimit");
        let store = DownloadStore::open(&dir).unwrap();
        let old = now_millis() - (EVICTION_GRACE_SECS + 60) * 1000;
        {
            let mut st = store.state.lock().await;
            st.index.items.push(entry("x", 1000, old, old));
        }
        let (s, evicted) = store.set_limit(10).await;
        assert_eq!(s.limit_bytes, 10);
        assert_eq!(evicted, 1, "limit baru langsung memicu eviction");
        assert!(store.list().await.0.is_empty());
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
