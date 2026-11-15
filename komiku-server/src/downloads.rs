//! Store unduhan PDF server — state PER-AKUN, file PDF DIBAGI, retensi TTL 24 JAM.
//!
//! Layout (default `D:/project/komiku-server/downloads`, override via env
//! `KOMIKU_DOWNLOADS_DIR` untuk test):
//! - `<id>.pdf`              — file PDF hasil generate (DIBAGI antar-akun)
//! - `index/<username>.json` — daftar unduhan milik satu akun
//!
//! `download_id = fnv1a64("handle|number")` content-addressed: chapter sama =
//! ID sama = satu file, walau banyak akun membacanya. Index per-akun, jadi file
//! fisik hanya dihapus saat TIDAK ADA lagi akun yang menunjuk id itu.
//!
//! ## Retensi: TTL ABSOLUT 24 JAM (menggantikan LRU + limit 2 GiB)
//! Entri hidup tepat `TTL_SECS` sejak `downloaded_at`; tidak ada limit byte,
//! eviction LRU, tenggang 7 hari, atau settings per-akun. `sweep_expired` (task
//! berkala) menghapus entri yang lebih tua dari TTL di SEMUA akun, lalu file
//! fisiknya bila tak ada pemegang lain.
//!
//! ## Refcount DIHAPUS (pilihan paling sederhana)
//! Dulu ada `refs.json`. Satu-satunya pemakaiannya adalah keputusan hapus
//! file. Index per-akun SUDAH sumber kebenaran tunggal, jadi refcount cuma
//! duplikat state yang bisa desinkron. Maka refs dibuang: "masih dipegang
//! akun mana pun?" dijawab dengan memindai index semua akun
//! (`any_holder_locked`).
//!
//! Satu mutex (`Mutex<State>`) memegang SEMUA akun; tiap akses me-lazy-load file
//! akun itu dari disk lebih dulu, jadi state benar setelah restart server.

use anyhow::Context;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use tokio::sync::Mutex;

/// Retensi unduhan: entri hidup 24 jam sejak `downloaded_at` (epoch millis).
pub const TTL_SECS: i64 = 24 * 60 * 60;
/// Batas halaman per chapter saat generate PDF (pengaman memori).
pub const MAX_PAGES: usize = 300;
/// Kuota default disk untuk direktori unduhan: 1 GiB. Override via env
/// `KOMIKU_DOWNLOADS_QUOTA_BYTES` (angka byte desimal).
pub(crate) const MAX_DOWNLOADS_DIR_BYTES_DEFAULT: u64 = 1 << 30;

/// Metadata satu PDF yang akan disimpan. Dikelompokkan supaya `store_pdf`
/// tidak punya 7 parameter posisional yang mudah tertukar.
pub struct PdfMeta<'a> {
    pub username: &'a str,
    pub handle: &'a str,
    pub number: &'a str,
    pub title: &'a str,
    pub series_title: &'a str,
    pub title_key: &'a str,
}

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
    /// epoch millis — satu-satunya cap waktu (dasar TTL).
    pub downloaded_at: i64,
}

#[derive(Debug, Default, Serialize, Deserialize)]
struct Index {
    items: Vec<DownloadEntry>,
}

/// State satu akun (index saja; evictions/settings sudah dibuang).
#[derive(Default)]
struct UserState {
    index: Index,
}

impl UserState {
    /// Muat state satu akun dari disk (file rusak/hilang -> default).
    fn load(dir: &Path, username: &str) -> Self {
        UserState {
            index: read_json(&index_path(dir, username)).unwrap_or_default(),
        }
    }
}

/// State seluruh akun.
struct State {
    /// username -> index
    users: BTreeMap<String, UserState>,
}

/// Store unduhan: direktori + state per-akun di memory, ditulis balik ke disk
/// setiap mutasi (file kecil per akun; tahan restart server).
pub struct DownloadStore {
    dir: PathBuf,
    /// Semua state di balik SATU mutex: generate (yang butuh lock panjang),
    /// hapus, dan sweep TTL harus serial.
    state: Mutex<State>,
}

// ---- path helper (per-akun) -----------------------------------------------

fn index_path(dir: &Path, username: &str) -> PathBuf {
    dir.join("index").join(format!("{username}.json"))
}

/// Username yang punya file index di disk (akun yang hanya ada di disk ikut
/// dipindai saat sapu TTL / hapus file).
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
    /// Buka store dari direktori (sub-dir index dibuat kalau belum ada).
    /// Index yang rusak di-reset (bukan bikin server gagal start), TAPI galat
    /// direktori TIDAK ditelan: direktori yang tidak bisa dibuat/ditulis
    /// dilaporkan dengan path jelas supaya boot bisa fail-fast (P0-1).
    pub fn open(dir: impl Into<PathBuf>) -> anyhow::Result<Arc<Self>> {
        let dir = dir.into();
        std::fs::create_dir_all(&dir)
            .with_context(|| format!("gagal membuat direktori unduhan {}", dir.display()))?;
        let index = dir.join("index");
        std::fs::create_dir_all(&index).with_context(|| {
            format!("gagal membuat direktori index unduhan {}", index.display())
        })?;
        // Cek tulis NYATA (bukan sekadar ada): direktori bisa ada tapi dimiliki
        // user lain / read-only — persis kasus QA yang dulu berakhir 502.
        ensure_writable(&dir)?;
        ensure_writable(&index)?;
        Ok(Arc::new(DownloadStore {
            dir,
            state: Mutex::new(State {
                users: BTreeMap::new(),
            }),
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
        format!(
            "{} - Chapter {}.pdf",
            sanitize(series_title),
            sanitize(number)
        )
    }

    /// Daftar unduhan MILIK `username` (urut terbaru dulu) + total byte.
    /// Tidak ada limit lagi — total hanya untuk informasi.
    pub async fn list(&self, username: &str) -> (Vec<DownloadEntry>, u64) {
        let mut st = self.state.lock().await;
        let u = Self::ensure_user(&self.dir, &mut st, username);
        let mut items = u.index.items.clone();
        items.sort_by_key(|e| std::cmp::Reverse(e.downloaded_at));
        let total = items.iter().map(|e| e.size_bytes).sum();
        (items, total)
    }

    /// Satu entri milik `username` by id (akun lain tidak bisa melihatnya).
    pub async fn get(&self, username: &str, id: &str) -> Option<DownloadEntry> {
        let mut st = self.state.lock().await;
        let u = Self::ensure_user(&self.dir, &mut st, username);
        u.index.items.iter().find(|e| e.id == id).cloned()
    }

    /// Hapus entri `id` MILIK `username`. `false` kalau akun itu tidak punya
    /// entri tersebut. File fisik hanya dihapus bila akun lain tidak lagi
    /// menunjuk id itu.
    pub async fn delete(&self, username: &str, id: &str) -> bool {
        let mut st = self.state.lock().await;
        let u = Self::ensure_user(&self.dir, &mut st, username);
        let before = u.index.items.len();
        u.index.items.retain(|e| e.id != id);
        if u.index.items.len() == before {
            return false;
        }
        if let Err(e) = Self::save_index(&self.dir, username, &u.index) {
            tracing::error!("{e:#}");
        }
        Self::drop_file_if_unheld(&self.dir, &mut st, id);
        true
    }

    /// Hapus SEMUA unduhan MILIK `username` (modal "hapus semua").
    /// `true` kalau ada yang terhapus. File fisik dihapus hanya saat tak ada
    /// akun lain yang menunjuknya.
    pub async fn clear_all(&self, username: &str) -> bool {
        let mut st = self.state.lock().await;
        let u = Self::ensure_user(&self.dir, &mut st, username);
        if u.index.items.is_empty() {
            return false;
        }
        let ids: Vec<String> = u.index.items.drain(..).map(|e| e.id).collect();
        if let Err(e) = Self::save_index(&self.dir, username, &u.index) {
            tracing::error!("{e:#}");
        }
        for id in ids {
            Self::drop_file_if_unheld(&self.dir, &mut st, &id);
        }
        true
    }

    /// Simpan PDF yang sudah jadi untuk `username`: tulis file (dibagi) lalu
    /// upsert entri di index akun (id deterministik -> unduhan ulang menimpa).
    /// `downloaded_at` di-reset ke sekarang, jadi TTL 24 jam mulai dari unduhan
    /// terakhir.
    pub async fn store_pdf(&self, meta: PdfMeta<'_>, bytes: Vec<u8>) -> anyhow::Result<DownloadEntry> {
        let quota = quota_bytes();
        self.store_pdf_quota(meta, bytes, quota).await
    }

    /// Inti `store_pdf` dengan kuota eksplisit. Dipisah supaya test bisa
    /// menyuntik kuota mungil tanpa menyentuh env/OnceLock produksi.
    async fn store_pdf_quota(
        &self,
        meta: PdfMeta<'_>,
        bytes: Vec<u8>,
        quota: u64,
    ) -> anyhow::Result<DownloadEntry> {
        let PdfMeta { username, handle, number, title, series_title, title_key } = meta;
        let id = Self::download_id(handle, number);
        let filename = Self::filename_for(series_title, number);
        let size = bytes.len() as u64;
        let now = now_millis();

        // Kuota disk: tolak SEBELUM mutex/fs::write bila total byte PDF di
        // direktori + kiriman ini melebihi kuota. Mencegah disk-exhaustion.
        if dir_bytes(&self.dir).saturating_add(size) > quota {
            anyhow::bail!("downloads disk quota exceeded");
        }

        let mut st = self.state.lock().await;
        let path = self.pdf_path(&id);
        std::fs::write(&path, &bytes)
            .with_context(|| format!("gagal menulis PDF {}", path.display()))?;
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
        };
        let u = Self::ensure_user(&self.dir, &mut st, username);
        u.index.items.retain(|e| e.id != id);
        u.index.items.push(entry.clone());
        Self::save_index(&self.dir, username, &u.index)?;
        Ok(entry)
    }

    /// Sapu entri kedaluwarsa (TTL 24 jam) di SEMUA akun, lalu hapus file fisik
    /// yang tak lagi ditunjuk akun mana pun, dan hapus file `<id>.pdf` yatim
    /// (tak ditunjuk index memory/disk mana pun) yang lebih tua dari TTL/2.
    /// Mengembalikan jumlah entri index kedaluwarsa + file yatim yang dihapus.
    /// Dipanggil task berkala (`unified::store`).
    pub async fn sweep_expired(&self) -> usize {
        let now = now_millis();
        let ttl_ms = TTL_SECS * 1000;
        let mut st = self.state.lock().await;
        let mut removed = 0usize;
        let mut gone_ids: Vec<String> = Vec::new();
        for name in Self::all_usernames(&self.dir, &st) {
            let u = Self::ensure_user(&self.dir, &mut st, &name);
            let before = u.index.items.len();
            u.index.items.retain(|e| {
                // kedaluwarsa bila now - downloaded_at >= TTL; sisanya disimpan.
                if now - e.downloaded_at >= ttl_ms {
                    gone_ids.push(e.id.clone());
                    false
                } else {
                    true
                }
            });
            if u.index.items.len() != before {
                removed += before - u.index.items.len();
                if let Err(e) = Self::save_index(&self.dir, &name, &u.index) {
                    tracing::error!("{e:#}");
                }
            }
        }
        // File fisik dicek SETELAH semua index dibersihkan: id yang masih
        // dipegang akun lain (belum kedaluwarsa) tidak ikut terhapus.
        gone_ids.sort();
        gone_ids.dedup();
        for id in gone_ids {
            Self::drop_file_if_unheld(&self.dir, &mut st, &id);
        }
        // GC yatim: file `<id>.pdf` yang TIDAK ditunjuk index mana pun
        // (memory maupun disk) dan lebih tua dari TTL/2 dihapus. Batas TTL/2
        // supaya file in-flight (baru ditulis, index belum tersimpan) yang
        // kebetulan yatim tidak ikut tersapu.
        let indexed = all_indexed_ids(&self.dir, &st);
        let orphan_cutoff = std::time::SystemTime::now()
            - std::time::Duration::from_secs((TTL_SECS / 2) as u64);
        if let Ok(rd) = std::fs::read_dir(&self.dir) {
            for entry in rd.flatten() {
                let path = entry.path();
                let is_pdf = path
                    .extension()
                    .and_then(|ext| ext.to_str())
                    .is_some_and(|ext| ext.eq_ignore_ascii_case("pdf"));
                if !is_pdf {
                    continue;
                }
                let Some(id) = path
                    .file_stem()
                    .and_then(|s| s.to_str())
                    .map(|s| s.to_string())
                else {
                    continue;
                };
                if indexed.contains(&id) {
                    continue;
                }
                let is_old = entry
                    .metadata()
                    .and_then(|m| m.modified())
                    .is_ok_and(|mtime| mtime < orphan_cutoff);
                if !is_old {
                    continue;
                }
                if std::fs::remove_file(&path).is_ok() {
                    removed += 1;
                }
            }
        }
        removed
    }

    /// Semua username yang relevan: yang ada di memory + yang punya file index
    /// di disk (penting lintas restart / task sapu yang jalan di latar).
    fn all_usernames(dir: &Path, st: &State) -> Vec<String> {
        let mut names: Vec<String> = st.users.keys().cloned().collect();
        for u in index_users(dir) {
            if !names.contains(&u) {
                names.push(u);
            }
        }
        names
    }

    /// Hapus file fisik `id` bila tidak ada akun yang masih menunjuknya.
    fn drop_file_if_unheld(dir: &Path, st: &mut State, id: &str) {
        if !Self::any_holder_locked(dir, st, id) {
            let _ = std::fs::remove_file(dir.join(format!("{id}.pdf")));
        }
    }

    /// Apakah ada akun mana pun yang masih menunjuk `id`? Pindai akun di
    /// memory + akun yang hanya ada di disk (lazy-load saat dipindai).
    fn any_holder_locked(dir: &Path, st: &mut State, id: &str) -> bool {
        if st
            .users
            .values()
            .any(|u| u.index.items.iter().any(|e| e.id == id))
        {
            return true;
        }
        for name in index_users(dir) {
            if st.users.contains_key(&name) {
                continue;
            }
            if Self::ensure_user(dir, st, &name)
                .index
                .items
                .iter()
                .any(|e| e.id == id)
            {
                return true;
            }
        }
        false
    }

    /// Tulis index satu akun. Galat TIDAK ditelan: pemanggil kritis
    /// (store_pdf) meneruskannya, pemanggil best-effort mencatatnya sebagai
    /// error (bukan hilang tanpa jejak).
    fn save_index(dir: &Path, username: &str, idx: &Index) -> anyhow::Result<()> {
        let path = index_path(dir, username);
        write_json(&path, idx).with_context(|| format!("gagal menyimpan {}", path.display()))
    }
}

// ------------------------------------------------------------------- util

/// Total byte semua file `*.pdf` langsung di `dir`. Tahan terhadap error
/// (dir hilang, metadata gagal, file berubah/terhapus saat dipindai) —
/// apa pun yang gagal dibaca diskip, bukan menggagalkan caller.
pub(crate) fn dir_bytes(dir: &std::path::Path) -> u64 {
    let mut total = 0u64;
    let Ok(rd) = std::fs::read_dir(dir) else {
        return 0;
    };
    for entry in rd.flatten() {
        let is_pdf = entry
            .path()
            .extension()
            .and_then(|ext| ext.to_str())
            .is_some_and(|ext| ext.eq_ignore_ascii_case("pdf"));
        if !is_pdf {
            continue;
        }
        if let Ok(meta) = entry.metadata() {
            total = total.saturating_add(meta.len());
        }
    }
    total
}

/// Kuota byte direktori unduhan. Dibaca dari env `KOMIKU_DOWNLOADS_QUOTA_BYTES`
/// SEKALI (OnceLock); tidak diset / tidak bisa diparse -> default 1 GiB.
fn quota_bytes() -> u64 {
    static QUOTA: std::sync::OnceLock<u64> = std::sync::OnceLock::new();
    *QUOTA.get_or_init(|| {
        std::env::var("KOMIKU_DOWNLOADS_QUOTA_BYTES")
            .ok()
            .and_then(|v| v.trim().parse::<u64>().ok())
            .unwrap_or(MAX_DOWNLOADS_DIR_BYTES_DEFAULT)
    })
}

/// Kumpulan id yang ditunjuk SEMUA index: yang sedang di memory + yang hanya
/// ada di disk (dir/index/*.json). Dipakai GC yatim di sweep_expired;
/// side-effect free (read_json langsung, tidak ensure_user).
fn all_indexed_ids(dir: &Path, st: &State) -> std::collections::HashSet<String> {
    let mut ids = std::collections::HashSet::new();
    for u in st.users.values() {
        for e in &u.index.items {
            ids.insert(e.id.clone());
        }
    }
    for name in index_users(dir) {
        if let Some(idx) = read_json::<Index>(&index_path(dir, &name)) {
            for e in &idx.items {
                ids.insert(e.id.clone());
            }
        }
    }
    ids
}

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

/// Pastikan direktori BENAR-BENAR bisa ditulis: buat file probe lalu hapus.
/// create_dir_all saja tidak cukup - direktori bisa sudah ada tapi dimiliki
/// user lain / read-only (kasus QA: data/downloads milik root). Galat memuat
/// path supaya log boot langsung menunjuk penyebabnya.
pub fn ensure_writable(dir: &Path) -> anyhow::Result<()> {
    let probe = dir.join(format!(
        ".write-probe-{}-{}",
        std::process::id(),
        now_millis()
    ));
    std::fs::write(&probe, b"ok")
        .with_context(|| format!("direktori {} tidak bisa ditulis", dir.display()))?;
    let _ = std::fs::remove_file(&probe);
    Ok(())
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

    fn entry(id: &str, size: u64, downloaded_at: i64) -> DownloadEntry {
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
        }
    }

    // ---- ISOLASI LINTAS-AKUN ------------------------------------------

    #[tokio::test]
    async fn list_terpisah_per_akun() {
        let dir = temp_dir("iso-list");
        let store = DownloadStore::open(&dir).unwrap();
        let a = store
            .store_pdf(
                PdfMeta { username: "alif", handle: "komiku:1", number: "1", title: "Ch 1", series_title: "Seri", title_key: "seri", },
                vec![1u8; 100],
            )
            .await
            .unwrap();
        let b = store
            .store_pdf(
                PdfMeta { username: "budi", handle: "komiku:2", number: "2", title: "Ch 2", series_title: "Seri Lain", title_key: "seri lain", },
                vec![2u8; 50],
            )
            .await
            .unwrap();
        let (ia, ta) = store.list("alif").await;
        let (ib, tb) = store.list("budi").await;
        assert_eq!((ia.len(), ib.len()), (1, 1));
        assert_eq!(ia[0].id, a.id);
        assert_eq!(ib[0].id, b.id);
        assert_eq!((ta, tb), (100, 50));
        // A tidak bisa lihat entri B lewat get, dan sebaliknya.
        assert!(store.get("alif", &b.id).await.is_none());
        assert!(store.get("budi", &a.id).await.is_none());
        let _ = std::fs::remove_dir_all(&dir);
    }

    // ---- TTL 24 JAM (menggantikan eviction/limit/settings/LRU) --------

    /// Entri lebih tua dari 24 jam dihapus sweep; entri muda bertahan.
    #[tokio::test]
    async fn sweep_hapus_kedaluwarsa_pertahankan_muda() {
        let dir = temp_dir("ttl-basic");
        let store = DownloadStore::open(&dir).unwrap();
        let now = now_millis();
        {
            let mut st = store.state.lock().await;
            let u = DownloadStore::ensure_user(&store.dir, &mut st, "alif");
            u.index
                .items
                .push(entry("old", 100, now - (TTL_SECS + 60) * 1000));
            u.index.items.push(entry("fresh", 100, now));
        }
        std::fs::write(store.pdf_path("old"), b"x").unwrap();
        std::fs::write(store.pdf_path("fresh"), b"x").unwrap();

        assert_eq!(
            store.sweep_expired().await,
            1,
            "hanya entri kedaluwarsa yang dihapus"
        );
        let ids: Vec<String> = store
            .list("alif")
            .await
            .0
            .iter()
            .map(|e| e.id.clone())
            .collect();
        assert!(!ids.contains(&"old".to_string()), "entri > 24 jam hilang");
        assert!(
            ids.contains(&"fresh".to_string()),
            "entri < 24 jam bertahan"
        );
        assert!(!store.pdf_path("old").exists(), "file kedaluwarsa dihapus");
        assert!(store.pdf_path("fresh").exists(), "file muda tetap");
        assert_eq!(store.sweep_expired().await, 0, "sweep kedua = no-op");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Batas: entri berumur >= TTL dihapus, yang lebih muda bertahan.
    #[tokio::test]
    async fn sweep_batas_tepat_ttl_dianggap_kedaluwarsa() {
        let dir = temp_dir("ttl-boundary");
        let store = DownloadStore::open(&dir).unwrap();
        let now = now_millis();
        {
            let mut st = store.state.lock().await;
            let u = DownloadStore::ensure_user(&store.dir, &mut st, "alif");
            u.index
                .items
                .push(entry("edge", 100, now - TTL_SECS * 1000)); // umur persis TTL
            u.index
                .items
                .push(entry("keep", 100, now - (TTL_SECS - 60) * 1000)); // 60s lebih muda
        }
        assert_eq!(store.sweep_expired().await, 1);
        let items = store.list("alif").await.0;
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].id, "keep");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Sweep menyapu SEMUA akun; file yang masih ditunjuk akun lain (belum
    /// kedaluwarsa) TIDAK dihapus.
    #[tokio::test]
    async fn sweep_lintas_akun_dan_jaga_file_dibagi() {
        let dir = temp_dir("ttl-cross");
        let store = DownloadStore::open(&dir).unwrap();
        let now = now_millis();
        let old = now - (TTL_SECS + 60) * 1000;
        {
            let mut st = store.state.lock().await;
            // "shared": alif kedaluwarsa, budi masih muda -> file harus tetap.
            let ua = DownloadStore::ensure_user(&store.dir, &mut st, "alif");
            ua.index.items.push(entry("shared", 100, old));
            ua.index.items.push(entry("only_a", 100, old));
            let ub = DownloadStore::ensure_user(&store.dir, &mut st, "budi");
            ub.index.items.push(entry("shared", 100, now));
        }
        std::fs::write(store.pdf_path("shared"), b"x").unwrap();
        std::fs::write(store.pdf_path("only_a"), b"x").unwrap();

        assert_eq!(store.sweep_expired().await, 2, "dua entri alif kedaluwarsa");
        assert!(store.list("alif").await.0.is_empty(), "index alif bersih");
        assert_eq!(store.list("budi").await.0.len(), 1, "budi tak tersentuh");
        assert!(store.pdf_path("shared").exists(), "masih dipakai budi");
        assert!(
            !store.pdf_path("only_a").exists(),
            "tak ada pemegang -> file hilang"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    // ---- file PDF yang DIBAGI (tanpa refcount) ------------------------

    #[tokio::test]
    async fn file_dibagi_dipertahankan_selama_akun_lain_pegang() {
        let dir = temp_dir("shared-file");
        let store = DownloadStore::open(&dir).unwrap();
        let ea = store
            .store_pdf(
                PdfMeta { username: "alif", handle: "komiku:6426", number: "1195", title: "Ch 1195", series_title: "One Piece", title_key: "one piece", },
                vec![7u8; 200],
            )
            .await
            .unwrap();
        let eb = store
            .store_pdf(
                PdfMeta { username: "budi", handle: "komiku:6426", number: "1195", title: "Ch 1195", series_title: "One Piece", title_key: "one piece", },
                vec![7u8; 200],
            )
            .await
            .unwrap();
        assert_eq!(ea.id, eb.id, "chapter sama -> satu id (content-addressed)");
        assert!(store.pdf_path(&ea.id).exists());

        // A hapus -> file HARUS masih ada, B tetap bisa ambil.
        assert!(store.delete("alif", &ea.id).await);
        assert!(store.pdf_path(&ea.id).exists(), "file masih dipakai budi");
        assert!(store.get("budi", &ea.id).await.is_some());
        assert!(store.list("alif").await.0.is_empty());

        // B hapus -> tak ada pemegang -> file hilang.
        assert!(store.delete("budi", &eb.id).await);
        assert!(
            !store.pdf_path(&eb.id).exists(),
            "tak ada pemegang -> file dihapus"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn unduh_ulang_akun_sama_upsert_tetap_satu_entri() {
        let dir = temp_dir("upsert");
        let store = DownloadStore::open(&dir).unwrap();
        store
            .store_pdf(PdfMeta { username: "alif", handle: "komiku:9", number: "9", title: "Ch 9", series_title: "S", title_key: "s" }, vec![1u8; 10])
            .await
            .unwrap();
        store
            .store_pdf(PdfMeta { username: "alif", handle: "komiku:9", number: "9", title: "Ch 9", series_title: "S", title_key: "s" }, vec![1u8; 10])
            .await
            .unwrap();
        assert_eq!(
            store.list("alif").await.0.len(),
            1,
            "tetap satu entri (upsert)"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn state_per_akun_bertahan_lintas_restart() {
        // Buka-tutup store: index dibaca ulang dari disk dan entri akun
        // tetap bisa ditemukan setelah restart.
        let dir = temp_dir("restart");
        let id = {
            let store = DownloadStore::open(&dir).unwrap();
            store
                .store_pdf(PdfMeta { username: "alif", handle: "komiku:5", number: "5", title: "Ch 5", series_title: "S", title_key: "s" }, vec![4u8; 40])
                .await
                .unwrap()
                .id
        };
        let store2 = DownloadStore::open(&dir).unwrap();
        assert_eq!(store2.list("alif").await.0.len(), 1, "index akun bertahan");
        assert!(
            store2.get("alif", &id).await.is_some(),
            "entri akun ditemukan lintas restart"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn clear_all_hanya_akun_itu() {
        let dir = temp_dir("clear-one");
        let store = DownloadStore::open(&dir).unwrap();
        let a = store
            .store_pdf(PdfMeta { username: "alif", handle: "komiku:1", number: "1", title: "Ch 1", series_title: "S", title_key: "s" }, vec![1u8; 10])
            .await
            .unwrap();
        let b = store
            .store_pdf(PdfMeta { username: "budi", handle: "komiku:2", number: "2", title: "Ch 2", series_title: "S", title_key: "s" }, vec![2u8; 10])
            .await
            .unwrap();
        assert!(store.clear_all("alif").await);
        assert!(store.list("alif").await.0.is_empty());
        assert_eq!(store.list("budi").await.0.len(), 1, "budi tak tersentuh");
        assert!(
            !store.pdf_path(&a.id).exists(),
            "file alif (tak dipegang) dihapus"
        );
        assert!(store.pdf_path(&b.id).exists(), "file budi tetap");
        let _ = std::fs::remove_dir_all(&dir);
    }

    // ---- perilaku lama (kini per-akun, tanpa LRU/limit) ---------------

    #[tokio::test]
    async fn store_roundtrip_list_get_delete() {
        let dir = temp_dir("roundtrip");
        let store = DownloadStore::open(&dir).unwrap();
        let entry = store
            .store_pdf(
                PdfMeta { username: "alif", handle: "komiku:1", number: "1", title: "Chapter 1", series_title: "Judul Seri", title_key: "judul seri", },
                vec![1u8; 100],
            )
            .await
            .unwrap();
        assert_eq!(entry.size_bytes, 100);
        assert_eq!(entry.title_key, "judul seri");

        let (items, total) = store.list("alif").await;
        assert_eq!((items.len(), total), (1, 100));

        let id = entry.id.clone();
        assert!(store.get("alif", &id).await.is_some());
        assert!(store.pdf_path(&id).exists());

        assert!(store.delete("alif", &id).await);
        assert!(!store.pdf_path(&id).exists());
        assert!(store.get("alif", &id).await.is_none());
        assert!(!store.delete("alif", &id).await, "hapus dua kali = false");
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

    // ---- WRITABILITY (P0-1) --------------------------------------------

    /// Direktori yang bisa ditulis lolos probe; file probe tidak tertinggal.
    #[test]
    fn ensure_writable_ok_tanpa_sisa_probe() {
        let dir = temp_dir("writable-ok");
        std::fs::create_dir_all(&dir).unwrap();
        ensure_writable(&dir).unwrap();
        assert_eq!(
            std::fs::read_dir(&dir).unwrap().count(),
            0,
            "probe harus dihapus"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Path yang bukan direktori (file biasa) HARUS gagal dengan path di
    /// pesan, bukan panic / diam-diam lolos.
    #[test]
    fn ensure_writable_gagal_jelas_untuk_file() {
        let dir = temp_dir("writable-file");
        std::fs::create_dir_all(&dir).unwrap();
        let f = dir.join("bukan-dir");
        std::fs::write(&f, b"x").unwrap();
        let err = ensure_writable(&f).unwrap_err();
        assert!(
            format!("{err:#}").contains("tidak bisa ditulis"),
            "pesan: {err:#}"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// open() meneruskan galat direktori (tidak ditelan): path yang menunjuk
    /// file biasa tidak bisa dijadikan store.
    /// DUA TAB, akun yang sama, chapter yang sama: dua request generate-PDF
    /// berjalan bersamaan. Mutex di State menyerialkan store_pdf; id-nya
    /// deterministik (fnv1a64 dari "handle|number") sehingga upsert menimpa,
    /// bukan menggandakan. Yang di-assert: tidak ada entri ganda, index
    /// konsisten, tepat satu file fisik.
    #[tokio::test]
    async fn dua_tab_simpan_chapter_sama_tidak_duplikat() {
        let dir = temp_dir("concurrent-same-chapter");
        let store = std::sync::Arc::new(DownloadStore::open(&dir).unwrap());
        let barrier = std::sync::Arc::new(tokio::sync::Barrier::new(2));

        let s1 = store.clone();
        let b1 = barrier.clone();
        let t1 = tokio::spawn(async move {
            b1.wait().await;
            s1.store_pdf(
                PdfMeta {
                    username: "alif",
                    handle: "komiku:42",
                    number: "7",
                    title: "Ch 7",
                    series_title: "Seri",
                    title_key: "seri",
                },
                vec![0xAAu8; 64],
            )
            .await
        });

        let s2 = store.clone();
        let b2 = barrier.clone();
        let t2 = tokio::spawn(async move {
            b2.wait().await;
            s2.store_pdf(
                PdfMeta {
                    username: "alif",
                    handle: "komiku:42",
                    number: "7",
                    title: "Ch 7",
                    series_title: "Seri",
                    title_key: "seri",
                },
                vec![0xBBu8; 64],
            )
            .await
        });

        let e1 = t1.await.unwrap().unwrap();
        let e2 = t2.await.unwrap().unwrap();
        assert_eq!(e1.id, e2.id, "handle|number sama harus menghasilkan id sama");

        let (items, total) = store.list("alif").await;
        assert_eq!(items.len(), 1, "tidak boleh ada dua entri untuk chapter yang sama");
        assert_eq!(total, 64);
        assert!(
            store.pdf_path(&e1.id).exists(),
            "satu file fisik tetap ada"
        );
        // isi file = salah satu dari dua penulis, tapi harus UTUH (bukan interleaved)
        let bytes = std::fs::read(store.pdf_path(&e1.id)).unwrap();
        assert_eq!(bytes.len(), 64);
        assert!(
            bytes.iter().all(|&b| b == 0xAA) || bytes.iter().all(|&b| b == 0xBB),
            "file harus utuh, bukan campuran dua penulis"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// DUA Akun berbeda, chapter yang sama: id identik → file dibagi; tiap akun
    /// punya entri sendiri yang menunjuk file yang sama. Hapus punya A tidak
    /// boleh menghapus file B.
    #[tokio::test]
    async fn dua_akun_chapter_sama_berbagi_file_tapi_index_terpisah() {
        let dir = temp_dir("concurrent-cross-account");
        let store = std::sync::Arc::new(DownloadStore::open(&dir).unwrap());
        let barrier = std::sync::Arc::new(tokio::sync::Barrier::new(2));

        let s1 = store.clone();
        let b1 = barrier.clone();
        let t1 = tokio::spawn(async move {
            b1.wait().await;
            s1.store_pdf(
                PdfMeta {
                    username: "alif",
                    handle: "komiku:42",
                    number: "7",
                    title: "Ch 7",
                    series_title: "Seri",
                    title_key: "seri",
                },
                vec![0xCCu8; 32],
            )
            .await
        });

        let s2 = store.clone();
        let b2 = barrier.clone();
        let t2 = tokio::spawn(async move {
            b2.wait().await;
            s2.store_pdf(
                PdfMeta {
                    username: "budi",
                    handle: "komiku:42",
                    number: "7",
                    title: "Ch 7",
                    series_title: "Seri",
                    title_key: "seri",
                },
                vec![0xDDu8; 32],
            )
            .await
        });

        let ea = t1.await.unwrap().unwrap();
        let eb = t2.await.unwrap().unwrap();
        assert_eq!(ea.id, eb.id, "id deterministik lintas akun");
        assert_eq!(store.list("alif").await.0.len(), 1);
        assert_eq!(store.list("budi").await.0.len(), 1);
        assert!(store.pdf_path(&ea.id).exists());
        // A menghapus miliknya: file dibagi B masih menunjuk id → file HARUS tetap ada
        assert!(store.delete("alif", &ea.id).await);
        assert!(
            store.pdf_path(&ea.id).exists(),
            "file fisik tidak boleh dihapus selagi akun lain masih menunjuk"
        );
        assert_eq!(store.list("budi").await.0.len(), 1);
        assert!(store.delete("budi", &ea.id).await);
        assert!(!store.pdf_path(&ea.id).exists());
        let _ = std::fs::remove_dir_all(&dir);
    }

    // ---- KUOTA DISK + GC YATIM ----------------------------------------

    #[test]
    fn dir_bytes_menjumlahkan_pdf_saja() {
        let dir = temp_dir("dirbytes");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("a.pdf"), vec![0u8; 100]).unwrap();
        std::fs::write(dir.join("b.PDF"), vec![0u8; 50]).unwrap();
        std::fs::write(dir.join("c.txt"), vec![0u8; 9999]).unwrap();
        assert_eq!(dir_bytes(&dir), 150);
        // dir hilang -> 0, bukan panic
        assert_eq!(dir_bytes(&dir.join("nope")), 0);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn sweep_menghapus_yatim_lama_tetapi_tahan_terindeks_dan_yatim_baru() {
        let dir = temp_dir("orphan-gc");
        let store = DownloadStore::open(&dir).unwrap();
        let now = now_millis();
        // "held" dipegang index memory akun alif; "diskheld" dipegang index
        // HANYA DI DISK akun budi (tidak pernah dimuat ke memory).
        {
            let mut st = store.state.lock().await;
            let u = DownloadStore::ensure_user(&store.dir, &mut st, "alif");
            u.index.items.push(entry("held", 10, now));
        }
        std::fs::create_dir_all(dir.join("index")).unwrap();
        let disk_idx = Index {
            items: vec![entry("diskheld", 10, now)],
        };
        write_json(&index_path(&dir, "budi"), &disk_idx).unwrap();

        let held = store.pdf_path("held");
        let diskheld = store.pdf_path("diskheld");
        let orphan_old = store.pdf_path("orphanold");
        let orphan_new = store.pdf_path("orphannew");
        std::fs::write(&held, b"held").unwrap();
        std::fs::write(&diskheld, b"diskheld").unwrap();
        std::fs::write(&orphan_old, b"orphanold").unwrap();
        std::fs::write(&orphan_new, b"orphannew").unwrap();
        // mundurkan mtime orphan_old (dan diskheld) jadi lebih tua dari TTL/2
        let tua = std::time::SystemTime::now()
            - std::time::Duration::from_secs((TTL_SECS / 2) as u64 + 3600);
        for p in [&orphan_old, &diskheld, &held] {
            let f = std::fs::File::options().write(true).open(p).unwrap();
            f.set_modified(tua).unwrap();
        }

        let removed = store.sweep_expired().await;
        assert!(!orphan_old.exists(), "yatim lama harus dihapus");
        assert!(held.exists(), "terindeks di memory harus selamat");
        assert!(diskheld.exists(), "terindeks di disk (file index) harus selamat");
        assert!(orphan_new.exists(), "yatim baru (< TTL/2) harus selamat");
        assert_eq!(removed, 1, "hanya 1 file yatim yang dihapus");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn store_pdf_gagal_saat_kuota_terlampaui_dan_lolos_saat_pas() {
        let dir = temp_dir("quota");
        let store = DownloadStore::open(&dir).unwrap();
        std::fs::write(store.pdf_path("existing"), vec![0u8; 100]).unwrap();
        // 100 (existing) + 50 (incoming) > 120 -> bail SEBELUM menulis
        let err = store
            .store_pdf_quota(
                PdfMeta { username: "alif", handle: "komiku:9", number: "9", title: "Ch 9", series_title: "Seri", title_key: "seri", },
                vec![0u8; 50],
                120,
            )
            .await
            .unwrap_err();
        assert!(format!("{err:#}").contains("downloads disk quota exceeded"));
        // hanya file existing yang tersisa
        let sisa: Vec<_> = std::fs::read_dir(&dir)
            .unwrap()
            .flatten()
            .filter(|e| e.path().extension().is_some_and(|x| x == "pdf"))
            .collect();
        assert_eq!(sisa.len(), 1);
        // 100 + 20 == 120 -> tidak over, boleh masuk
        store
            .store_pdf_quota(
                PdfMeta { username: "alif", handle: "komiku:10", number: "10", title: "Ch 10", series_title: "Seri", title_key: "seri", },
                vec![0u8; 20],
                120,
            )
            .await
            .unwrap();
        assert_eq!(dir_bytes(&dir), 120);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn open_gagal_jika_direktori_tidak_bisa_dibuat() {
        let dir = temp_dir("open-gagal");
        std::fs::create_dir_all(&dir).unwrap();
        let f = dir.join("file");
        std::fs::write(&f, b"x").unwrap();
        assert!(DownloadStore::open(&f).is_err());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
