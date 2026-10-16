//! Cache dua tingkat: TtlCache (in-memory, untuk server) + DiskCache (file JSON
//! di `~/.komik/cache/`, TTL 10 menit, untuk CLI). Keduanya diakses lewat satu
//! interface `Cache` (get / fresh / set) sehingga caller tidak peduli tier mana
//! yang melayani.
//!
//! Nilai disimpan sebagai `serde_json::Value` (bukan `TtlCache<T>` per-tipe)
//! supaya satu map melayani semua bentuk payload; helper `get_json`/`set_json`
//! memberi tipenya di sisi pemanggil.
//!
//! Stale-while-revalidate: `lookup` mengembalikan `(nilai, masih_segar)`, jadi
//! pemanggil boleh memakai data kedaluwarsa sambil menyegarkan di background.
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

/// TTL default: 10 menit (CLI disk cache + server in-memory).
pub const DEFAULT_TTL: Duration = Duration::from_secs(10 * 60);

/// TTL PENDEK untuk penanda negatif ("chapter ini tidak ada di sumber X",
/// "series kosong"): kalau terlalu panjang, chapter yang baru terbit akan
/// kelihatan hilang. Kegagalan jaringan/429/timeout TIDAK BOLEH masuk sini —
/// hanya kesimpulan pasti dari sumber yang berhasil diakses.
pub const NEGATIVE_TTL: Duration = Duration::from_secs(60);

/// Sumber waktu yang bisa diinjeksi (test deterministik; bukan `Instant`
/// supaya entri disk bisa dipromosikan ke memory tanpa kehilangan sisa umur).
pub type Clock = std::sync::Arc<dyn Fn() -> u64 + Send + Sync>;

pub fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    // Jangan panic kalau thread lain sempat poisoning mutex.
    m.lock().unwrap_or_else(|e| e.into_inner())
}

// ---------------------------------------------------------------- TtlCache

/// Tier in-memory (server, atau proses CLI yang sama).
pub struct TtlCache {
    ttl_ms: u64,
    clock: Clock,
    map: Mutex<HashMap<String, Entry>>,
}

struct Entry {
    expires_at_ms: u64,
    value: Value,
}

impl TtlCache {
    pub fn new(ttl: Duration) -> Self {
        TtlCache {
            ttl_ms: ttl.as_millis() as u64,
            clock: std::sync::Arc::new(now_ms),
            map: Mutex::new(HashMap::new()),
        }
    }

    pub fn with_clock(ttl: Duration, clock: Clock) -> Self {
        TtlCache {
            ttl_ms: ttl.as_millis() as u64,
            clock,
            map: Mutex::new(HashMap::new()),
        }
    }
    pub fn ttl_ms(&self) -> u64 {
        self.ttl_ms
    }

    pub fn is_fresh(&self, key: &str) -> bool {
        self.lookup(key).map(|(_, f)| f).unwrap_or(false)
    }

    /// `(nilai, masih_segar)`; `None` kalau kunci tidak ada sama sekali.
    pub fn lookup(&self, key: &str) -> Option<(Value, bool)> {
        let now = (self.clock)();
        let map = lock(&self.map);
        map.get(key).map(|e| (e.value.clone(), now < e.expires_at_ms))
    }

    /// Entri segar saja; `None` kalau absen atau kedaluwarsa.
    pub fn fresh(&self, key: &str) -> Option<Value> {
        self.lookup(key).and_then(|(v, f)| f.then_some(v))
    }

    /// Entri apa adanya (segar maupun stale).
    pub fn get(&self, key: &str) -> Option<Value> {
        self.lookup(key).map(|(v, _)| v)
    }

    pub fn set(&self, key: &str, value: Value) {
        let expires_at_ms = (self.clock)().saturating_add(self.ttl_ms);
        lock(&self.map).insert(key.to_string(), Entry { expires_at_ms, value });
    }

    /// Set dengan deadline absolut (dipakai saat mempromosikan entri disk).
    pub fn set_expiring_at(&self, key: &str, expires_at_ms: u64, value: Value) {
        lock(&self.map).insert(
            key.to_string(),
            Entry { expires_at_ms, value },
        );
    }

    /// Set dengan TTL spesifik per-entri (dipakai negative-cache).
    pub fn set_expiring_in(&self, key: &str, ttl: Duration, value: Value) {
        let expires_at_ms = (self.clock)().saturating_add(ttl.as_millis() as u64);
        lock(&self.map).insert(key.to_string(), Entry { expires_at_ms, value });
    }

    pub fn remove(&self, key: &str) {
        lock(&self.map).remove(key);
    }

    pub fn clear(&self) {
        lock(&self.map).clear();
    }

    pub fn len(&self) -> usize {
        lock(&self.map).len()
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }

    pub fn fresh_json<T: for<'de> Deserialize<'de>>(&self, key: &str) -> Option<T> {
        self.fresh(key).and_then(|v| serde_json::from_value(v).ok())
    }

    /// Alias API lama: entri segar saja.
    pub fn get_json<T: for<'de> Deserialize<'de>>(&self, key: &str) -> Option<T> {
        self.fresh_json(key)
    }

    pub fn set_json<T: Serialize>(&self, key: &str, value: &T) -> anyhow::Result<()> {
        self.set(key, serde_json::to_value(value)?);
        Ok(())
    }
}

// --------------------------------------------------------------- DiskCache

/// Tier disk (CLI). Satu file JSON per kunci; tulisan atomic (tmp + rename)
/// supaya cache tidak pernah separuh tertulis.
pub struct DiskCache {
    dir: PathBuf,
    ttl_ms: u64,
    clock: Clock,
}

#[derive(Serialize, Deserialize)]
struct DiskEntry {
    key: String,
    expires_at_ms: u64,
    value: Value,
}

impl DiskCache {
    pub fn new(dir: impl Into<PathBuf>, ttl: Duration) -> Self {
        DiskCache {
            dir: dir.into(),
            ttl_ms: ttl.as_millis() as u64,
            clock: std::sync::Arc::new(now_ms),
        }
    }

    pub fn with_clock(dir: impl Into<PathBuf>, ttl: Duration, clock: Clock) -> Self {
        DiskCache {
            dir: dir.into(),
            ttl_ms: ttl.as_millis() as u64,
            clock,
        }
    }

    pub fn dir(&self) -> &Path {
        &self.dir
    }

    /// Direktori default CLI: `~/.komik/cache`.
    pub fn default_dir() -> PathBuf {
        let home = std::env::var_os("USERPROFILE")
            .or_else(|| std::env::var_os("HOME"))
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from("."));
        home.join(".komik").join("cache")
    }

    fn path_for(&self, key: &str) -> PathBuf {
        let safe: String = key
            .chars()
            .map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == '.' { c } else { '_' })
            .take(48)
            .collect();
        self.dir
            .join(format!("{:016x}-{}.json", fnv1a(key.as_bytes()), safe))
    }

    fn load(&self, key: &str) -> Option<DiskEntry> {
        let raw = fs::read_to_string(self.path_for(key)).ok()?;
        serde_json::from_str(&raw).ok()
    }

    pub fn lookup(&self, key: &str) -> Option<(Value, bool)> {
        let entry = self.load(key)?;
        let fresh = (self.clock)() < entry.expires_at_ms;
        Some((entry.value, fresh))
    }

    /// Deadline absolut entri (dipakai saat mempromosikan ke tier memory).
    pub fn expires_at_ms(&self, key: &str) -> Option<u64> {
        self.load(key).map(|e| e.expires_at_ms)
    }

    pub fn fresh(&self, key: &str) -> Option<Value> {
        self.lookup(key).and_then(|(v, f)| f.then_some(v))
    }

    pub fn get(&self, key: &str) -> Option<Value> {
        self.lookup(key).map(|(v, _)| v)
    }

    pub fn set(&self, key: &str, value: Value) -> anyhow::Result<()> {
        self.set_expiring_in(key, Duration::from_millis(self.ttl_ms), value)
    }

    /// Set dengan TTL spesifik per-entri (negative-cache: TTL pendek).
    pub fn set_expiring_in(&self, key: &str, ttl: Duration, value: Value) -> anyhow::Result<()> {
        fs::create_dir_all(&self.dir)?;
        let entry = DiskEntry {
            key: key.to_string(),
            expires_at_ms: (self.clock)().saturating_add(ttl.as_millis() as u64),
            value,
        };
        let path = self.path_for(key);
        let tmp = self
            .dir
            .join(format!(".tmp-{}-{}.json", std::process::id(), nonce()));
        let write = (|| -> anyhow::Result<()> {
            let mut f = fs::File::create(&tmp)?;
            f.write_all(&serde_json::to_vec(&entry)?)?;
            f.flush()?;
            Ok(())
        })()
        .and_then(|()| fs::rename(&tmp, &path).map_err(Into::into));
        if write.is_err() {
            let _ = fs::remove_file(&tmp);
        }
        write
    }

    pub fn remove(&self, key: &str) -> anyhow::Result<()> {
        match fs::remove_file(self.path_for(key)) {
            Ok(()) => Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(e) => Err(e.into()),
        }
    }
}

fn nonce() -> u64 {
    use std::sync::atomic::{AtomicU64, Ordering};
    static N: AtomicU64 = AtomicU64::new(0);
    N.fetch_add(1, Ordering::Relaxed)
}

/// FNV-1a 64-bit: nama file cache pendek & stabil tanpa dep baru.
fn fnv1a(bytes: &[u8]) -> u64 {
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    for b in bytes {
        h ^= *b as u64;
        h = h.wrapping_mul(0x0000_0100_0000_01b3);
    }
    h
}

// -------------------------------------------------------------------- Cache

/// Satu interface untuk kedua tier: memory selalu aktif, disk opsional.
pub struct Cache {
    mem: TtlCache,
    disk: Option<DiskCache>,
}

impl Cache {
    /// Mode server: in-memory saja.
    pub fn memory(ttl: Duration) -> Self {
        Cache { mem: TtlCache::new(ttl), disk: None }
    }

    /// In-memory dengan clock injeksi (test deterministik).
    pub fn memory_with_clock(ttl: Duration, clock: Clock) -> Self {
        Cache { mem: TtlCache::with_clock(ttl, clock), disk: None }
    }

    /// Mode CLI: memory + disk.
    pub fn with_disk(ttl: Duration, dir: impl Into<PathBuf>) -> Self {
        Cache {
            mem: TtlCache::new(ttl),
            disk: Some(DiskCache::new(dir, ttl)),
        }
    }

    pub fn default_disk(ttl: Duration) -> Self {
        Cache::with_disk(ttl, DiskCache::default_dir())
    }

    pub fn has_disk(&self) -> bool {
        self.disk.is_some()
    }

    pub fn disk_dir(&self) -> Option<&Path> {
        self.disk.as_ref().map(|d| d.dir())
    }

    /// `(nilai, masih_segar)`; mem-promote hit disk ke memory supaya
    /// pembacaan berikutnya tidak menyentuh filesystem.
    pub fn lookup(&self, key: &str) -> Option<(Value, bool)> {
        if let Some(hit) = self.mem.lookup(key) {
            return Some(hit);
        }
        let disk = self.disk.as_ref()?;
        let (value, fresh) = disk.lookup(key)?;
        // Sisa umur dari disk dipertahankan supaya memory & disk kedaluwarsa
        // serentak (bukan memory "segar lagi" karena baru dipromosikan).
        if let Some(exp) = disk.expires_at_ms(key) {
            self.mem.set_expiring_at(key, exp, value.clone());
        } else {
            self.mem.set(key, value.clone());
        }
        Some((value, fresh))
    }

    /// Entri segar saja (jalur normal CLI).
    pub fn fresh(&self, key: &str) -> Option<Value> {
        self.lookup(key).and_then(|(v, f)| f.then_some(v))
    }

    pub fn fresh_json<T: for<'de> Deserialize<'de>>(&self, key: &str) -> Option<T> {
        self.fresh(key).and_then(|v| serde_json::from_value(v).ok())
    }

    /// Entri apa adanya (segar maupun stale).
    pub fn get(&self, key: &str) -> Option<Value> {
        self.lookup(key).map(|(v, _)| v)
    }

    /// Write-through memory + disk. Kegagalan disk tidak menggagalkan caller;
    /// dikembalikan sebagai Err agar CLI bisa memunculkan peringatan.
    pub fn set(&self, key: &str, value: Value) -> anyhow::Result<()> {
        self.mem.set(key, value.clone());
        match &self.disk {
            Some(d) => d.set(key, value),
            None => Ok(()),
        }
    }

    pub fn remove(&self, key: &str) -> anyhow::Result<()> {
        self.mem.remove(key);
        match &self.disk {
            Some(d) => d.remove(key),
            None => Ok(()),
        }
    }

    pub fn clear(&self) -> anyhow::Result<()> {
        self.mem.clear();
        if let Some(d) = &self.disk {
            if d.dir().exists() {
                for entry in fs::read_dir(d.dir())? {
                    let path = entry?.path();
                    if path.extension().map(|e| e == "json").unwrap_or(false) {
                        let _ = fs::remove_file(path);
                    }
                }
            }
        }
        Ok(())
    }

    pub fn get_json<T: for<'de> Deserialize<'de>>(&self, key: &str) -> Option<T> {
        self.fresh_json(key)
    }

    pub fn set_json<T: Serialize>(&self, key: &str, value: &T) -> anyhow::Result<()> {
        self.set(key, serde_json::to_value(value)?)
    }

    /// Tulis penanda negatif dengan [`NEGATIVE_TTL`] (memory + disk, TTL
    /// pendek — bukan `DEFAULT_TTL`). Nilai apa adanya; hanya KEBERADAAN
    /// entri yang berarti ("tidak ada"). Kegagalan jaringan/429/timeout
    /// tidak boleh lewat sini.
    pub fn set_negative(&self, key: &str, value: Value) -> anyhow::Result<()> {
        self.mem.set_expiring_in(key, NEGATIVE_TTL, value.clone());
        match &self.disk {
            Some(d) => d.set_expiring_in(key, NEGATIVE_TTL, value),
            None => Ok(()),
        }
    }

    pub fn set_negative_json<T: Serialize>(&self, key: &str, value: &T) -> anyhow::Result<()> {
        self.set_negative(key, serde_json::to_value(value)?)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::sync::Arc;

    /// Clock uji yang bisa dimajukan: `Clock` menangkap Arc, bukan salinan u64.
    fn test_clock(start: u64) -> (Clock, Arc<AtomicU64>) {
        let cell = Arc::new(AtomicU64::new(start));
        let c = cell.clone();
        (Arc::new(move || c.load(Ordering::SeqCst)), cell)
    }

    #[test]
    fn memory_ttl_expires() {
        let (clock, t) = test_clock(1_000);
        let cache = TtlCache::with_clock(Duration::from_secs(10), clock);
        cache.set("k", json!({"a": 1}));
        assert!(cache.fresh("k").is_some());
        t.store(10_000, Ordering::SeqCst);
        assert!(cache.fresh("k").is_some(), "masih segar");
        t.store(11_002, Ordering::SeqCst); // lewat 10s
        assert!(cache.fresh("k").is_none(), "harus kedaluwarsa");
        assert!(cache.get("k").is_some(), "stale masih bisa dibaca (SWR)");
        assert_eq!(cache.len(), 1);
    }

    #[test]
    fn disk_roundtrip_and_expiry() {
        let dir = std::env::temp_dir().join(format!("komik-cache-ut-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        let (clock, t) = test_clock(500);
        let cache = DiskCache::with_clock(&dir, Duration::from_secs(60), clock);
        cache.set("a:b", json!([1, 2, 3])).unwrap();
        assert_eq!(cache.fresh("a:b"), Some(json!([1, 2, 3])));
        t.store(60_500, Ordering::SeqCst); // 60s TTL dari 500ms
        assert!(cache.fresh("a:b").is_none());
        assert!(cache.get("a:b").is_some());
        cache.remove("a:b").unwrap();
        assert!(cache.get("a:b").is_none());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn unified_promotes_disk_to_memory() {
        let dir = std::env::temp_dir().join(format!("komik-cache-ut2-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        let cache = Cache::with_disk(Duration::from_secs(60), &dir);
        assert!(cache.has_disk());
        cache.set("x", json!("v")).unwrap();
        // proses baru biasanya memory kosong: hapus memory-nya, disk harus
        // tetap melayani.
        cache.mem.clear();
        assert_eq!(cache.fresh("x"), Some(json!("v")));
        let _ = fs::remove_dir_all(&dir);
    }
}
