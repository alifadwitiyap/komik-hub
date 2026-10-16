//! Kripto Komiku+ — port dari hasil reverse-engineering APK v2.3.0.
//!
//! Sumber: `Utility.e()` / `Utility.s()` + `SecurityUtil` di APK.
//! Semua byte mengikuti bytecode Android apa adanya, bukan karangan.
//!
//! Alur kunci (identik dengan CLI Python `komiku-cli`):
//! ```text
//! seed     = "qyGjx5h7Bs"                      (Base64 "cXlHang1aDdCcw==")
//! keypart  = seed[..6] + "V46Tkh" + seed[6..len-1]   // "V48Tkh" dengan 8->6
//! password = "org.komiku." + keypart + "s"
//! key      = PBKDF2-HMAC-SHA1(password, salt="179", 65536 iter, 32 byte)
//! cipher   = AES-256-CBC, IV = bytes(0..15), padding PKCS7
//! ```

use aes::cipher::{block_padding::Pkcs7, BlockDecryptMut, BlockEncryptMut, KeyIvInit};
use anyhow::{anyhow, Context, Result};
use base64::Engine;

type Aes256CbcEnc = cbc::Encryptor<aes::Aes256>;
type Aes256CbcDec = cbc::Decryptor<aes::Aes256>;

/// IV tetap yang di-hardcode di APK: 0,1,2,...,15
const IV: [u8; 16] = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15];

/// Sama dengan `Base64.decode("cXlHang1aDdCcw==").decodeToString()` di Kotlin.
fn seed() -> &'static str {
    "qyGjx5h7Bs"
}

/// `substring(0,6) + "V48Tkh".replace("8","6") + substring(6, length-1)`
fn key_part() -> String {
    let s = seed();
    let head = &s[0..6];
    let tail = &s[6..s.len() - 1];
    format!("{head}V46Tkh{tail}")
}

/// `"org.komiku." + str + "s"` — lihat `Utility.e()`/`Utility.s()`.
fn password() -> String {
    format!("org.komiku.{}s", key_part())
}

/// PBKDF2-HMAC-SHA1, 65536 iterasi, keluaran 32 byte (AES-256).
///
/// Diimplementasi langsung di atas `hmac`+`sha1` alih-alih pakai crate `pbkdf2`:
/// API crate 0.12 meminta tipe "core" yang berbeda dari `Hmac<Sha1>`, dan
/// menambahkan batasan versi hanya untuk satu fungsi. Derivatif ini aman
/// di-cache karena tidak punya state yang berubah.
use hmac::{Hmac, Mac};
type HmacSha1 = Hmac<sha1::Sha1>;

fn prf(key: &[u8], data: &[u8]) -> [u8; 20] {
    let mut m = <HmacSha1 as Mac>::new_from_slice(key).expect("HMAC menerima key apa panjangnya");
    m.update(data);
    m.finalize().into_bytes().into()
}

fn pbkdf2_sha1(password: &[u8], salt: &[u8], rounds: u32, out_len: usize) -> Vec<u8> {
    // RFC 2898: T_i = F(P, S, c, i) = U_1 xor U_2 ... xor U_c
    let mut out = Vec::with_capacity(out_len);
    let mut block_index: u32 = 1;
    while out.len() < out_len {
        let mut salt_int = salt.to_vec();
        salt_int.extend_from_slice(&block_index.to_be_bytes());
        let mut u = prf(password, &salt_int);
        let mut t = u;
        for _ in 1..rounds {
            u = prf(password, &u);
            for (a, b) in t.iter_mut().zip(u.iter()) {
                *a ^= *b;
            }
        }
        out.extend_from_slice(&t);
        block_index += 1;
    }
    out.truncate(out_len);
    out
}

/// Kunci AES-256. DI-CACHE: tiap request hanya butuh beberapa ratus µs, dan
/// derivasi ini jauh lebih mahal daripada request jaringan yang sudah di-cache.
fn key() -> [u8; 32] {
    use once_cell::sync::Lazy;
    static K: Lazy<[u8; 32]> = Lazy::new(|| {
        let v = pbkdf2_sha1(password().as_bytes(), b"179", 65_536, 32);
        v.try_into().expect("32 byte pasti bisa jadi [u8; 32]")
    });
    *K
}

/// `x-secure-seeds` = hex(AES-CBC(timestamp_millis)). Server menolak kalau basi,
/// jadi harus digenerate per request.
pub fn x_secure_seeds() -> String {
    let ts = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or_default();

    // `encrypt_padded_mut` butuh buffer dengan RUANG untuk padding PKCS7,
    // bukan hanya sepanjang plaintext. Tanpa ruang ini -> PanError (dulu panic).
    let plain = ts.to_string().into_bytes();
    let mut buf = plain.clone();
    buf.resize(plain.len() + 16, 0);

    let ct = Aes256CbcEnc::new(key().as_slice().into(), &IV.into())
        .encrypt_padded_mut::<Pkcs7>(&mut buf, plain.len())
        .expect("16 byte ruang padding selalu cukup");
    hex::encode(ct)
}

// --- helper ---

/// Base64 APK memakai `NO_PADDING` -> tambah '=' sampai kelipatan 4.
fn b64_decode_unpadded(s: &str) -> Result<Vec<u8>> {
    let mut t = s.trim().to_string();
    while !t.len().is_multiple_of(4) {
        t.push('=');
    }
    base64::engine::general_purpose::STANDARD
        .decode(t)
        .context("base64 tidak valid")
}

// --- payload terenkripsi ---

/// Blob `chapter` / `chapter.image` -> plaintext UTF-8 (JSON).
pub fn decrypt_blob(blob: &str) -> Result<String> {
    let mut ct = b64_decode_unpadded(blob)?;
    if ct.is_empty() || ct.len() % 16 != 0 {
        return Err(anyhow!(
            "panjang ciphertext {} tidak kelipatan blok AES",
            ct.len()
        ));
    }
    let pt = Aes256CbcDec::new(key().as_slice().into(), &IV.into())
        .decrypt_padded_mut::<Pkcs7>(&mut ct)
        .map_err(|_| anyhow!("dekripsi/padding gagal (kunci berubah atau blob korup)"))?;
    String::from_utf8(pt.to_vec()).context("plaintext bukan UTF-8")
}

/// Blob terenkripsi -> nilai JSON. Kalau bukan blob (atau gagal), kembalikan
/// nilai asli supaya endpoint tetap melayani data polos.
pub fn maybe_json(value: serde_json::Value) -> serde_json::Value {
    if let serde_json::Value::String(s) = &value {
        if s.len() > 40 {
            if let Ok(pt) = decrypt_blob(s) {
                if let Ok(v) = serde_json::from_str(&pt) {
                    return v;
                }
            }
        }
    }
    value
}
