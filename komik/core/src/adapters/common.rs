//! Helper bersama untuk semua adapter. Hanya potongan yang benar-benar identik
//! (atau beda-tipis yang bisa dinormalisasi) lintas sumber yang ditaruh di sini,
//! supaya perilaku parsing tetap satu sumber kebenaran.
//!
//! Yang sengaja TETAP di adapter masing-masing (karena spesifik-sumber):
//! - pemetaan `Manga`/`Chapter` tiap situs (field & quirk beda-beda),
//! - ekstraksi URL gambar (struktur `image`/`chapter` tiap sumber beda),
//! - parser tanggal relatif Indonesia milik komiku (`parse_komik_date`),
//! - `num_str` ala shinigami (string diterima apa adanya, tanpa trim).

use serde_json::Value;

// ---------------------------------------------------------------------------
// Normalisasi field JSON
// ---------------------------------------------------------------------------

/// String field generik: trim; kosong dan "-" (placeholder situs) jadi None;
/// angka JSON jadi string. Perilaku sama dengan `str_field` komiku dan `str_of`
/// mangaku — keduanya dialihkan ke sini.
pub fn str_field(v: Option<&Value>) -> Option<String> {
    match v? {
        Value::String(s) => Some(s.trim().to_string()),
        Value::Number(n) => Some(n.to_string()),
        Value::Bool(b) => Some(b.to_string()),
        _ => None,
    }
    .filter(|s| !s.is_empty() && s != "-")
}

/// `str_field` dengan nama key: `str_field_key(v, "title")`.
pub fn str_field_key(v: &Value, key: &str) -> Option<String> {
    str_field(v.get(key))
}

/// Format angka f64 jadi string tampilan tanpa ".0" yang tak perlu ("921"
/// bukan "921.0"). Dipakai mangaku (`fmt_num`) & shinigami (`num_str`).
pub fn number_to_string(f: f64) -> String {
    if f.fract() == 0.0 && f.abs() < 1e15 {
        format!("{}", f as i64)
    } else {
        format!("{f}")
    }
}

/// Field angka (JSON number atau teks desimal) -> string. String di-trim;
/// kosong dan "-" jadi None. `210.0` -> "210", `1.1` -> "1.1".
/// Ini `num_of` mangaku apa adanya.
pub fn num_field(v: Option<&Value>) -> Option<String> {
    match v? {
        Value::Number(n) => Some(number_to_string(n.as_f64()?)),
        Value::String(s) => {
            let t = s.trim();
            if t.is_empty() || t == "-" {
                None
            } else {
                Some(t.to_string())
            }
        }
        _ => None,
    }
}

/// Nama-nama dari list objek ber-`name` (`[{"name":"Action"},...]`).
/// Entri tanpa nama / nama kosong dibuang. Dipakai komiku (`statusmanga`,
/// `tipe`), shinigami (`taxonomy.*`), dan kiryuu (`wp:term`).
pub fn name_list(items: &[Value]) -> Vec<String> {
    items
        .iter()
        .filter_map(|x| x.get("name").and_then(|n| n.as_str()))
        .filter(|s| !s.is_empty())
        .map(str::to_string)
        .collect()
}

/// `name_list` yang langsung digabung "A, B"; kosong -> None.
pub fn names_joined(items: &[Value]) -> Option<String> {
    let names = name_list(items);
    (!names.is_empty()).then(|| names.join(", "))
}

// ---------------------------------------------------------------------------
// Tanggal -> epoch millis
// ---------------------------------------------------------------------------

/// Hari sejak 1970-01-01 (algoritma days_from_civil, Howard Hinnant).
/// Sebelumnya di-duplikasi di komiku, mangaku, dan shinigami.
pub fn days_from_civil(y: i64, m: u32, d: u32) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400;
    let mp = if m > 2 { m - 3 } else { m + 9 } as i64;
    let doy = (153 * mp + 2) / 5 + d as i64 - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

/// Hasil parse ISO8601 dasar: basis epoch millis (UTC-naif) + info fraksi detik
/// + sisa string setelah bagian waktu ("", "Z", "+07:00", ...). Interpretasi
///   sisa & padding fraksi diserahkan ke adapter karena beda: mangaku menolak
///   offset & tidak men-pad fraksi (`.5` -> 5ms); shinigami menerima offset &
///   men-pad ke 3 digit (`.5` -> 500ms).
pub struct IsoParsed {
    pub millis: i64,
    /// 3 digit pertama fraksi detik sebagai integer (0 kalau tanpa fraksi).
    pub frac_value: i64,
    /// Banyak digit yang dikumpulkan untuk `frac_value` (<= 3).
    pub frac_digits: u32,
    pub tail: String,
}

/// Parse "YYYY-MM-DDTHH:MM:SS[.fff]" -> basis millis UTC-naif + info fraksi
/// + sisa string. Format buruk / nilai di luar rentang -> None.
pub fn iso8601_parse(s: &str) -> Option<IsoParsed> {
    let s = s.trim();
    let b = s.as_bytes();
    // minimal "YYYY-MM-DDTHH:MM:SS"
    if b.len() < 19 || b[4] != b'-' || b[7] != b'-' || b[10] != b'T' || b[13] != b':' || b[16] != b':'
    {
        return None;
    }
    let num = |i: usize, j: usize| -> Option<i64> {
        let t = s.get(i..j)?;
        if !t.bytes().all(|c| c.is_ascii_digit()) {
            return None;
        }
        t.parse().ok()
    };
    let (y, mo, dy, hh, mm, ss) = (
        num(0, 4)?,
        num(5, 7)?,
        num(8, 10)?,
        num(11, 13)?,
        num(14, 16)?,
        num(17, 19)?,
    );
    if !(1..=12).contains(&mo) || !(1..=31).contains(&dy) || hh > 23 || mm > 59 || ss > 60 {
        return None;
    }
    let millis =
        days_from_civil(y, mo as u32, dy as u32) * 86_400_000 + hh * 3_600_000 + mm * 60_000 + ss * 1000;
    // fraksi detik opsional; ambil maksimal 3 digit pertama
    let mut i = 19;
    let mut frac_value: i64 = 0;
    let mut frac_digits: u32 = 0;
    if b.get(i) == Some(&b'.') {
        i += 1;
        let start = i;
        while i < b.len() && b[i].is_ascii_digit() && frac_digits < 3 {
            frac_value = frac_value * 10 + i64::from(b[i] - b'0');
            frac_digits += 1;
            i += 1;
        }
        // lewati sisa digit fraksi (lebih dari 3)
        while i < b.len() && b[i].is_ascii_digit() {
            i += 1;
        }
        // titik tanpa angka setelahnya ("...T00:00:00.Z") — tolak, sama
        // seperti perilaku asli mangaku & shinigami.
        if i == start {
            return None;
        }
    }
    let tail = s.get(i..)?.to_string();
    Some(IsoParsed {
        millis,
        frac_value,
        frac_digits,
        tail,
    })
}

/// ISO8601 UTC-only (mangaku/Laravel): sisa setelah detik harus kosong atau
/// "Z". Offset lain ditolak supaya tak salah-tafsir jadi UTC. Fraksi TIDAK
/// di-pad (`.5` -> 5ms) — perilaku asli mangaku dipertahankan.
pub fn iso8601_to_millis_utc(s: &str) -> Option<i64> {
    let p = iso8601_parse(s)?;
    if p.tail.is_empty() || p.tail.eq_ignore_ascii_case("z") {
        Some(p.millis + p.frac_value)
    } else {
        None
    }
}

/// ISO8601 dengan offset (shinigami): "Z"/naif/"±HH:MM"/"±HHMM". Offset
/// dikurangkan supaya hasilnya selalu UTC. Fraksi DI-pad ke 3 digit (`.5` ->
/// 500ms) — perilaku asli shinigami dipertahankan.
pub fn iso8601_to_millis_offset(s: &str) -> Option<i64> {
    let p = iso8601_parse(s)?;
    let frac = if p.frac_digits > 0 {
        p.frac_value * 10_i64.pow(3 - p.frac_digits)
    } else {
        0
    };
    let millis = p.millis + frac;
    if p.tail.is_empty() || p.tail.eq_ignore_ascii_case("z") {
        return Some(millis);
    }
    let rest = p.tail.as_str();
    let sign: i64 = match rest.as_bytes().first()? {
        b'+' => 1,
        b'-' => -1,
        _ => return None,
    };
    let off = rest.get(1..)?.replace(':', "");
    if off.len() != 4 {
        return None;
    }
    let oh: i64 = off.get(0..2)?.parse().ok()?;
    let om: i64 = off.get(2..4)?.parse().ok()?;
    Some(millis - sign * (oh * 3_600_000 + om * 60_000))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn str_field_normalisasi_kosong_dan_placeholder() {
        let v = serde_json::json!({
            "a": "  One Piece  ", "b": "  ", "c": "-", "d": 42, "e": true, "f": null
        });
        assert_eq!(str_field_key(&v, "a").as_deref(), Some("One Piece"));
        assert_eq!(str_field_key(&v, "b"), None, "spasi saja harus None");
        assert_eq!(str_field_key(&v, "c"), None, "placeholder \"-\" harus None");
        assert_eq!(str_field_key(&v, "d").as_deref(), Some("42"));
        assert_eq!(str_field_key(&v, "e").as_deref(), Some("true"));
        assert_eq!(str_field_key(&v, "f"), None);
        assert_eq!(str_field_key(&v, "tidak-ada"), None);
    }

    #[test]
    fn num_field_tanpa_trailing_zero() {
        let v = serde_json::json!({"a": 210.0, "b": 1.1, "c": "1.1", "d": "-", "e": "", "f": 921});
        assert_eq!(num_field(v.get("a")).as_deref(), Some("210"));
        assert_eq!(num_field(v.get("b")).as_deref(), Some("1.1"));
        assert_eq!(num_field(v.get("c")).as_deref(), Some("1.1"));
        assert_eq!(num_field(v.get("d")), None);
        assert_eq!(num_field(v.get("e")), None);
        assert_eq!(num_field(v.get("f")).as_deref(), Some("921"));
        assert_eq!(num_field(None), None);
    }

    #[test]
    fn name_list_dan_join() {
        let items = serde_json::json!([
            {"name": "Ongoing", "id": 1},
            {"name": ""},
            {"id": 3},
            {"name": "Manhua"}
        ]);
        let arr = items.as_array().unwrap();
        assert_eq!(name_list(arr), vec!["Ongoing", "Manhua"]);
        assert_eq!(names_joined(arr).as_deref(), Some("Ongoing, Manhua"));
        assert_eq!(names_joined(&[]), None, "kosong harus None, bukan \"\"");
    }

    #[test]
    fn days_from_civil_acuan() {
        assert_eq!(days_from_civil(1970, 1, 1), 0);
        assert_eq!(days_from_civil(2026, 10, 9), 20_735);
        // kabisat
        assert_eq!(days_from_civil(2024, 2, 29) - days_from_civil(2024, 2, 28), 1);
    }

    #[test]
    fn iso_utc_menolak_offset() {
        assert_eq!(
            iso8601_to_millis_utc("2026-09-26T01:00:22.000000Z"),
            Some(1_790_384_422_000)
        );
        assert_eq!(
            iso8601_to_millis_utc("2026-09-26T01:00:22"),
            Some(1_790_384_422_000)
        );
        assert_eq!(iso8601_to_millis_utc("2026-09-26T01:00:22+07:00"), None);
        assert_eq!(iso8601_to_millis_utc("26 September 2026"), None);
    }

    #[test]
    fn iso_offset_dinormalkan_ke_utc() {
        assert_eq!(iso8601_to_millis_offset("1970-01-01T00:00:00Z"), Some(0));
        assert_eq!(iso8601_to_millis_offset("1970-01-01T07:00:00+07:00"), Some(0));
        assert_eq!(
            iso8601_to_millis_offset("2026-10-11T01:00:21"),
            Some(1_791_680_421_000)
        );
        assert_eq!(
            iso8601_to_millis_offset("2000-02-29T12:00:00.500Z"),
            Some(951_825_600_500)
        );
        assert_eq!(iso8601_to_millis_offset("2026-13-01T00:00:00Z"), None);
        assert_eq!(iso8601_to_millis_offset("2026-09-26T01:00:22+0700"), Some(
            1_790_384_422_000 - 7 * 3_600_000
        ));
        assert_eq!(iso8601_to_millis_offset("bukan tanggal"), None);
    }
}
