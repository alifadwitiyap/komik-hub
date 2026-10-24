//! read.rs — chapter yang SUDAH pernah dibuka, per-akun ("sudah dibaca").
//!
//! State: `<users_dir>/read/<username>.json`
//! Bentuk: `{ "marks": { "<title_key>": { "<nomor chapter>": <at_ms> } } }`
//!
//! `title_key` = identitas series lintas-sumber (sudah dipakai rak/favorit),
//! nomor chapter = string ("1195", "1.5", "extra-9"). Pasangan ini = satu
//! chapter secara global, jadi satu file cukup untuk semua sumber.
//!
//! Merge = UNION (monotonik), BUKAN replace-all seperti progress: daftar
//! "sudah dibaca" hanya bertambah, jadi push dari device lain tidak boleh
//! menghapus mark chapter yang sudah ada. Kalau nanti ada fitur "tandai
//! belum dibaca", barulah union perlu dikasih operasi hapus per key.
//!
//! Handler stateless (baca/tulis file), di-`.merge()` tanpa `AppState`.

use axum::{extract::Query, http::HeaderMap, routing::get, Json, Router};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

use crate::routes::{AppError, Res};
use crate::user::{require_user, users_dir};

type Marks = BTreeMap<String, BTreeMap<String, i64>>;

/// Batas jumlah mark chapter per series (pertahankan yang terbaru).
///
/// HARUS lebih besar dari chapter terpanjang sebuah manga — One Piece punya
/// 1215 chapter. Cap yang lebih kecil membuat chapter lama yang SUDAH dibaca
/// ter-prune dan muncul lagi sebagai "belum dibaca" (bug-find A11).
const PER_SERIES_CAP: usize = 2_000;
/// Batas total mark per akun (buang yang paling lama).
const GLOBAL_CAP: usize = 20_000;
/// Batas ukuran body PUT (byte).
const MAX_BODY_BYTES: usize = 1024 * 1024;

/// Kunci akses tulis state read.
///
/// PUT doing read → merge → write (bukan atomic). Dua request bersamaan
/// bisa sama-sama membaca state LAMA lalu menulis → mark yang baru hilang
/// (bug-find A13: 24 push paralel → hanya 5 tersimpan). Kunci ini
/// menyerialisasi read-modify-write per akun.
fn write_lock() -> &'static Mutex<()> {
    static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| Mutex::new(()))
}

fn read_file(username: &str) -> PathBuf {
    users_dir().join("read").join(format!("{username}.json"))
}

/// Versi skema state. Naikkan saat bentuk JSON berubah; beri migrasi di
/// `CURRENT_SCHEMA_VERSION` sebelum baca.
const CURRENT_SCHEMA_VERSION: u32 = 1;

#[derive(Debug, Default, Serialize, Deserialize)]
struct ReadState {
    /// Versi skema file. `#[serde(default)]` → file lama (tanpa field) dibaca
    /// sebagai versi 1 — tidak pernah panic.
    #[serde(default = "schema_v1")]
    schema_version: u32,
    #[serde(default)]
    marks: Marks,
}

fn schema_v1() -> u32 {
    1
}

fn read_state(path: &Path) -> ReadState {
    let mut st = std::fs::read(path)
        .ok()
        .and_then(|b| serde_json::from_slice::<ReadState>(&b).ok())
        .unwrap_or_default();
    // Normalisasi: file baru (default) atau file lama tanpa schema_version
    // dianggap versi 1. Jangan biarkan 0 tertulis — 0 bukan versi valid.
    if st.schema_version == 0 {
        st.schema_version = CURRENT_SCHEMA_VERSION;
    }
    debug_assert!(st.schema_version <= CURRENT_SCHEMA_VERSION);
    st
}

/// Tulis atomik (temp + rename) — pola sama `progress.rs`/`notif.rs`.
///
/// Dua penyesuaian untuk Windows:
///  - nama file temp UNIK per tulis (pid + counter). Kalau temp-nya shared,
///    dua penulis bisa saling menimpa file temp lalu renamePartial yang
///    salah → state korup.
///  - `rename` di Windows GAGAL kalau file tujuan sedang dibuka proses lain
///    (mis. GET paralel yang sedang membaca) → retry singkat.
fn write_state(path: &Path, st: &ReadState) -> anyhow::Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    static SEQ: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let seq = SEQ.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let tmp = path.with_extension(format!("json.tmp.{}.{}", std::process::id(), seq));
    std::fs::write(&tmp, serde_json::to_vec(st)?)?;
    let mut last: Option<std::io::Error> = None;
    for attempt in 0..10 {
        match std::fs::rename(&tmp, path) {
            Ok(()) => return Ok(()),
            Err(e) => {
                last = Some(e);
                // Windows: file tujuan sedang dibuka → tunggu sebentar, coba lagi.
                std::thread::sleep(std::time::Duration::from_millis(5 * (attempt + 1)));
            }
        }
    }
    let _ = std::fs::remove_file(&tmp);
    Err(anyhow::anyhow!(
        "gagal rename state baca: {}",
        last.map(|e| e.to_string()).unwrap_or_default()
    ))
}

/// Gabung mark baru ke state lama: per key ambil `at` yang lebih baru.
/// Monotonik — mark yang ada TIDAK PERNAH hilang.
fn merge(state: &mut ReadState, incoming: &Marks) {
    for (series, chapters) in incoming {
        let slot = state.marks.entry(series.clone()).or_default();
        for (chapter, at) in chapters {
            match slot.get_mut(chapter) {
                Some(prev) if *prev >= *at => {}
                Some(prev) => *prev = *at,
                None => {
                    slot.insert(chapter.clone(), *at);
                }
            }
        }
    }
}

/// Buang mark paling lama biar file tidak tumbuh tanpa batas.
/// Dua lapis: per series (terbaru) lalu global (terbaru).
fn prune(state: &mut ReadState) {
    for chapters in state.marks.values_mut() {
        if chapters.len() > PER_SERIES_CAP {
            let mut items: Vec<(String, i64)> = std::mem::take(chapters).into_iter().collect();
            items.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| a.0.cmp(&b.0)));
            items.truncate(PER_SERIES_CAP);
            for (k, v) in items {
                chapters.insert(k, v);
            }
        }
    }
    let total: usize = state.marks.values().map(|m| m.len()).sum();
    if total > GLOBAL_CAP {
        let mut all: Vec<(String, String, i64)> = Vec::new();
        for (series, chapters) in &state.marks {
            for (chapter, at) in chapters {
                all.push((series.clone(), chapter.clone(), *at));
            }
        }
        all.sort_by(|a, b| b.2.cmp(&a.2).then_with(|| a.0.cmp(&b.0)).then_with(|| a.1.cmp(&b.1)));
        all.truncate(GLOBAL_CAP);
        let mut fresh: Marks = BTreeMap::new();
        for (series, chapter, at) in all {
            fresh.entry(series).or_default().insert(chapter, at);
        }
        state.marks = fresh;
    }
}

fn total_marks(state: &ReadState) -> usize {
    state.marks.values().map(|m| m.len()).sum()
}

/// GET /api/read[?series=<title_key>] -> {marks, count}
///
/// Tanpa `series` → seluruh state akun. Dengan `series` → hanya mark untuk
/// series itu (dipakai halaman series: jangan tarik semua mark setiap buka).
async fn get_read(headers: HeaderMap, Query(q): Query<ReadQuery>) -> Res<Value> {
    let username = require_user(&headers)?;
    let state = read_state(&read_file(&username));
    let marks = match q.series.as_deref() {
        Some(series) => match state.marks.get(series) {
            Some(m) => {
                let mut one = BTreeMap::new();
                one.insert(series.to_string(), m.clone());
                one
            }
            None => BTreeMap::new(),
        },
        None => state.marks.clone(),
    };
    Ok(Json(json!({
        "marks": marks,
        "count": total_marks(&state),
    })))
}

#[derive(Deserialize)]
struct ReadQuery {
    /// title_key series — opsional.
    #[serde(default)]
    series: Option<String>,
}

#[derive(Deserialize)]
struct PutReadReq {
    #[serde(default)]
    marks: Marks,
}

/// PUT /api/read {marks:{title_key:{chapter:at}}} -> {ok, count}
///
/// Union: mark yang sudah ada tidak hilang. `count` = total mark akun.
async fn put_read(headers: HeaderMap, body: axum::body::Bytes) -> Res<Value> {
    let username = require_user(&headers)?;
    if body.len() > MAX_BODY_BYTES {
        return Err(AppError::bad_request(format!(
            "payload terlalu besar: {} byte (maks {MAX_BODY_BYTES})",
            body.len()
        )));
    }
    let req: PutReadReq = serde_json::from_slice(&body)
        .map_err(|e| AppError::bad_request(format!("payload bukan JSON yang valid: {e}")))?;

    // Serialisasi read → merge → write. Tanpa ini, dua PUT bersamaan bisa
    // sama-sama membaca state LAMA lalu menulis → mark yang baru hilang
    // (bug-find A13: 24 push paralel → hanya 5 tersimpan).
    // `read_state` HARUS di dalam lock — lock hanya_merge tidak berguna.
    // Poisoning (thread panic di dalam lock) diambil dengan `into_inner`:
    // state file sudah atomic, jadi lock yg 'racun' tetap aman dipakai.
    let _guard = write_lock()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let mut state = read_state(&read_file(&username));
    merge(&mut state, &req.marks);
    prune(&mut state);
    let count = total_marks(&state);
    write_state(&read_file(&username), &state)
        .map_err(|e| AppError::new(anyhow::anyhow!("gagal simpan state baca: {e}")))?;
    Ok(Json(json!({ "ok": true, "count": count })))
}

/// Sub-router /api/read. Stateless -> `Router<()>`.
pub fn read_routes() -> Router {
    Router::new()
        .route("/api/read", get(get_read).put(put_read))
        .layer(tower_http::cors::CorsLayer::permissive())
}

// ------------------------------------------------------------------ test

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "komiku-read-{tag}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// Bentuk payload `marks` dari pasangan (chapter, at).
    fn marks_of(series: &str, pairs: &[(&str, i64)]) -> Marks {
        let mut chapters = BTreeMap::new();
        for (c, at) in pairs {
            chapters.insert((*c).to_string(), *at);
        }
        let mut root = BTreeMap::new();
        root.insert(series.to_string(), chapters);
        root
    }

    #[test]
    fn merge_union_tidak_menghapus_mark_lama() {
        let mut st = ReadState::default();
        let mut a = BTreeMap::new();
        a.insert("1195".to_string(), 100i64);
        let mut root = BTreeMap::new();
        root.insert("one piece".to_string(), a);
        merge(&mut st, &root);

        let mut b = BTreeMap::new();
        b.insert("1194".to_string(), 200i64);
        let mut root2 = BTreeMap::new();
        root2.insert("one piece".to_string(), b);
        merge(&mut st, &root2);

        let chapters = st.marks.get("one piece").unwrap();
        assert_eq!(chapters.len(), 2, "mark lama harus tetap ada");
        assert_eq!(chapters.get("1195"), Some(&100));
        assert_eq!(chapters.get("1194"), Some(&200));
    }

    #[test]
    fn merge_mark_baru_berganti_at_yang_lama() {
        let mut st = ReadState::default();
        let mut a = BTreeMap::new();
        a.insert("1195".to_string(), 100i64);
        let mut root = BTreeMap::new();
        root.insert("s".to_string(), a);
        merge(&mut st, &root);

        let mut b = BTreeMap::new();
        b.insert("1195".to_string(), 900i64);
        let mut root2 = BTreeMap::new();
        root2.insert("s".to_string(), b);
        merge(&mut st, &root2);

        assert_eq!(st.marks.get("s").unwrap().get("1195"), Some(&900));
    }

    #[test]
    fn prune_buang_yang_paling_lama_per_series() {
        let mut st = ReadState::default();
        let mut chapters = BTreeMap::new();
        for i in 0..(PER_SERIES_CAP + 50) {
            chapters.insert(format!("c{i}"), i as i64);
        }
        st.marks.insert("s".to_string(), chapters);
        prune(&mut st);
        let kept = st.marks.get("s").unwrap();
        assert_eq!(kept.len(), PER_SERIES_CAP);
        // yang tertua dibuang, yang terbaru disimpan
        assert!(!kept.contains_key("c0"));
        assert!(kept.contains_key(&format!("c{}", PER_SERIES_CAP + 49)));
    }

    #[test]
    fn prune_buang_yang_paling_lama_global() {
        let mut st = ReadState::default();
        let per = GLOBAL_CAP / 2 + 10;
        for s in 0..2 {
            let mut chapters = BTreeMap::new();
            for i in 0..per {
                chapters.insert(format!("c{i}"), (s * per + i) as i64);
            }
            st.marks.insert(format!("s{s}"), chapters);
        }
        prune(&mut st);
        assert!(total_marks(&st) <= GLOBAL_CAP, "total mark harus <= cap");
    }

    #[test]
    fn file_hilang_atau_korup_jadi_state_kosong() {
        let missing = std::env::temp_dir().join("komiku-read-tidak-ada-xyz.json");
        assert!(read_state(&missing).marks.is_empty());

        let bad = std::env::temp_dir().join(format!("komiku-read-bad-{}.json", std::process::id()));
        std::fs::write(&bad, b"{bukan json").unwrap();
        assert!(read_state(&bad).marks.is_empty());
        let _ = std::fs::remove_file(&bad);
    }

    #[test]
    fn state_berada_di_bawah_users_dir() {
        let f = read_file("alif");
        assert!(f.to_string_lossy().contains("read"));
        assert!(f.to_string_lossy().ends_with("alif.json"));
    }

    /// Bug A11: cap per-series harus cukup untuk manga terpanjang. One Piece
    /// punya 1215 chapter — cap yang lebih kecil membuat chapter lama yang
    /// SUDAH dibaca ter-prune lalu muncul lagi sebagai "belum dibaca".
    #[test]
    fn cap_per_series_mencukupi_manga_panjang() {
        assert!(
            PER_SERIES_CAP >= 1215,
            "PER_SERIES_CAP ({PER_SERIES_CAP}) < chapter terpanjang (1215)"
        );
    }

    /// Bug A13: file temp harus unik per tulis. Kalau shared, dua penulis
    /// bisa saling menimpa temp lalu rename yang salah.
    #[test]
    fn write_state_temp_unik_per_tulis() {
        let dir = temp_dir("temp-unik");
        let path = dir.join("alif.json");
        let st = ReadState::default();
        write_state(&path, &st).expect("tulis 1");
        write_state(&path, &st).expect("tulis 2");
        // tidak ada file temp tersisa
        let leftovers: Vec<_> = std::fs::read_dir(&dir)
            .unwrap()
            .filter_map(|e| e.ok())
            .map(|e| e.file_name().to_string_lossy().to_string())
            .filter(|n| n.contains(".tmp."))
            .collect();
        assert!(leftovers.is_empty(), "file temp tertinggal: {leftovers:?}");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Bug A13: dua tulisan berurutan pada file yang sama tidak boleh
    /// saling menghapus (lock read-modify-write).
    #[test]
    fn dua_tulis_berurutan_tidak_saling_menghapus() {
        let dir = temp_dir("r-m-w");
        let path = dir.join("alif.json");
        let mut first = ReadState::default();
        merge(&mut first, &marks_of("s", &[("1", 1)]));
        write_state(&path, &first).expect("tulis 1");

        let mut second = read_state(&path);
        merge(&mut second, &marks_of("s", &[("2", 2)]));
        write_state(&path, &second).expect("tulis 2");

        let back = read_state(&path);
        let chapters = back.marks.get("s").unwrap();
        assert_eq!(chapters.len(), 2, "mark dari tulis pertama harus tetap ada");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Bug A13 (bentuk paralel): banyak penulis ke file yang sama. Tanpa
    /// kunci RMW, sebagian mark hilang. Dengan kunci, semua tersimpan.
    /// Dipakai juga untuk membuktikan file temp tak pernah bentrok.
    #[test]
    fn banyak_tulis_paralel_semua_tersimpan() {
        let dir = temp_dir("paralel");
        let path = dir.join("alif.json");
        let n = 24u32;
        let handles: Vec<_> = (0..n)
            .map(|i| {
                let path = path.clone();
                std::thread::spawn(move || {
                    let _guard = write_lock()
                        .lock()
                        .unwrap_or_else(|poisoned| poisoned.into_inner());
                    let mut st = read_state(&path);
                    merge(&mut st, &marks_of("s", &[(&i.to_string(), i64::from(i) + 1)]));
                    write_state(&path, &st).expect("tulis paralel");
                })
            })
            .collect();
        for h in handles {
            h.join().expect("thread tulis");
        }
        let back = read_state(&path);
        let chapters = back.marks.get("s").expect("series s");
        assert_eq!(
            chapters.len(),
            n as usize,
            "semua mark paralel harus tersimpan (tanpa lock ada yang hilang)"
        );
        // tak boleh ada file temp tersisa
        let leftovers: Vec<_> = std::fs::read_dir(&dir)
            .unwrap()
            .filter_map(|e| e.ok())
            .map(|e| e.file_name().to_string_lossy().to_string())
            .filter(|name| name.contains(".tmp."))
            .collect();
        assert!(leftovers.is_empty(), "file temp tertinggal: {leftovers:?}");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
