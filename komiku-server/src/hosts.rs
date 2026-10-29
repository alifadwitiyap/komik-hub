//! Allowlist host gambar (SSRF guard) untuk fetch gambar server-side.
//!
//! Modul ini HANYA memuat daftar host + pencocokannya; tidak ada handler
//! HTTP di sini. Proxy `/img` sudah dibuang (Q21: hotlink CDN aman, jadi
//! byte gambar tak lagi dilewatkan server untuk keperluan tampilan). Yang
//! tersisa memakai allowlist ini adalah `unified::fetch_image` (mengambil
//! gambar chapter untuk dirakit jadi PDF), sehingga guard SSRF tetap wajib.
//!
//! Keamanan: host di-allowlist eksplisit per host — TIDAK ada
//! wildcard/subdomain matching.

/// Host gambar yang diizinkan (SSRF guard): eksplisit per host, TANPA
/// wildcard — subdomain liar / host user-request langsung ditolak.
/// Sumber: img.komiku.org (komiku), image2..image11.komiku.to (komiku+mangaku
/// CDN, semuanya resolve live 2026-10-15), thumbnail.komiku.org (cover
/// komiku), assets/storage.shngm.id (shinigami), cdnkuma.my.id (mangaku),
/// cdn.jsdelivr.net + v2.yuucdn.net + v7.kiryuu.to + cdn.kiryuu.io (kiryuu —
/// host HTML + CDN gambar halaman; terverifikasi 2026-10-29: chapter kiryuu
/// mengembalikan gambar dari cdn.kiryuu.io, 200 image/jpeg 690x5620).
///
/// `cdn.kiryuu.io` WAJIB ada di sini: tanpa itu proxy `/img` menjawab 403,
/// sehingga unduh-offline dan PDF kiryuu gagal total — reader tampilan masih
/// jalan karena memakai CDN langsung, jadi bug ini tidak kelihatan di UI.
const ALLOWED_HOSTS: &[&str] = &[
    "img.komiku.org",
    "thumbnail.komiku.org",
    "image2.komiku.to",
    "image3.komiku.to",
    "image4.komiku.to",
    "image5.komiku.to",
    "image6.komiku.to",
    "image7.komiku.to",
    "image8.komiku.to",
    "image9.komiku.to",
    "image10.komiku.to",
    "image11.komiku.to",
    "assets.shngm.id",
    "storage.shngm.id",
    "cdnkuma.my.id",
    "cdn.jsdelivr.net",
    "v2.yuucdn.net",
    "v7.kiryuu.to",
    "cdn.kiryuu.io",
];

/// Ambil host dari `https://host/...` tanpa crate `url` (cukup allowlist).
fn https_host(u: &str) -> Option<&str> {
    let rest = u.strip_prefix("https://")?;
    let host = rest.split(['/', '?', '#']).next()?;
    if host.is_empty() {
        None
    } else {
        Some(host)
    }
}

/// Host gambar yang diizinkan (bandingkan eksak, case-insensitive): host tidak
/// dikenal — termasuk subdomain — ditolak. Dipakai `unified` saat mengambil
/// gambar chapter untuk PDF (allowlist SSRF yang sama).
pub fn host_allowed(u: &str) -> bool {
    match https_host(u) {
        Some(h) => ALLOWED_HOSTS
            .iter()
            .any(|allowed| h.eq_ignore_ascii_case(allowed)),
        None => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn allowlist_komiku_cdn_lengkap() {
        // image2..image11 (komiku+mangaku CDN) harus lolos; tanpa ini gambar
        // dari host baru ditolak dan PDF chapter kosong.
        for h in [
            "img.komiku.org",
            "thumbnail.komiku.org",
            "image2.komiku.to",
            "image11.komiku.to",
        ] {
            assert!(
                host_allowed(&format!("https://{h}/x/1.webp")),
                "{h} harus diizinkan"
            );
        }
        // host asing + subdomain liar tetap ditolak (guard SSRF)
        assert!(!host_allowed("https://evil.example.com/1.webp"));
        assert!(!host_allowed("https://image12.komiku.to/1.webp"));
        assert!(!host_allowed("https://komiku.to.evil.net/1.webp"));
        // skema http ditolak (fetch gambar hanya https)
        assert!(!host_allowed("http://img.komiku.org/1.webp"));
    }
}
