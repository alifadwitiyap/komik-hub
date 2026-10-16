//! PDF writer khusus komik (CLI only).
//!
//! Dua jalur:
//! - Semua JPEG: LOSSLESS passthrough. Byte JPEG dibungkus `/DCTDecode` dalam
//!   PDF minimal yang ditulis tangan (xref table + trailer) — tanpa encode
//!   ulang, jadi byte gambar identik dengan yang diunduh.
//! - Campuran (PNG/WebP/GIF ikut di dalam): decode via crate `image`
//!   (dependency CLI saja, core tetap lean) lalu re-encode jadi JPEG.
//!
//! Magic-byte sniff juga dipakai pemanggil untuk menolak "HTML 200 senyap"
//! (halaman error yang balas 200 dengan body text) sebelum masuk PDF.
use image::codecs::jpeg::JpegEncoder;
use image::{ExtendedColorType, ImageReader};
use std::fs;
use std::io::Write;
use std::path::Path;

/// Format gambar yang didukung CLI (sniff via magic bytes, bukan ekstensi).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ImageFormat {
    Jpeg,
    Png,
    Gif,
    Webp,
}

impl ImageFormat {
    pub fn label(self) -> &'static str {
        match self {
            ImageFormat::Jpeg => "JPEG",
            ImageFormat::Png => "PNG",
            ImageFormat::Gif => "GIF",
            ImageFormat::Webp => "WebP",
        }
    }
}

/// Kenali format dari magic bytes. `None` = bukan gambar yang didukung
/// (termasuk HTML/text membalas HTTP 200).
pub fn sniff_format(bytes: &[u8]) -> Option<ImageFormat> {
    if bytes.len() >= 3 && bytes[0] == 0xFF && bytes[1] == 0xD8 && bytes[2] == 0xFF {
        return Some(ImageFormat::Jpeg);
    }
    if bytes.len() >= 8 && bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        return Some(ImageFormat::Png);
    }
    if bytes.len() >= 6 && (bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a")) {
        return Some(ImageFormat::Gif);
    }
    if bytes.len() >= 12 && bytes.starts_with(b"RIFF") && &bytes[8..12] == b"WEBP" {
        return Some(ImageFormat::Webp);
    }
    None
}

/// Alasan kenapa byte ditolak (untuk pesan error CLI yang spesifik).
pub fn reject_reason(bytes: &[u8]) -> String {
    if bytes.is_empty() {
        return "body kosong".into();
    }
    let head = String::from_utf8_lossy(&bytes[..bytes.len().min(64)]);
    let trimmed = head.trim_start();
    if trimmed.starts_with('<') {
        return format!("HTML/bukan gambar (mulai `{}...`)", first_n(&head, 40));
    }
    if trimmed.starts_with('{') {
        return format!("JSON/bukan gambar (mulai `{}...`)", first_n(&head, 40));
    }
    format!("magic bytes tidak dikenali ({})", first_n(&head, 40))
}

fn first_n(s: &str, n: usize) -> String {
    s.chars().take(n).collect()
}

/// Satu halaman PDF: byte gambar + URL asal (untuk pesan error).
#[derive(Debug, Clone)]
pub struct Page {
    pub url: String,
    pub bytes: Vec<u8>,
}

/// Ringkasan hasil penulisan PDF.
#[derive(Debug, Clone)]
pub struct PdfReport {
    pub pages: usize,
    /// Halaman yang JPEG-nya dibiarkan utuh (lossless).
    pub passthrough: usize,
    /// Halaman yang harus di-decode + re-encode JPEG.
    pub reencoded: usize,
    pub bytes: usize,
}

/// Encode JPEG dari format lain (PNG/WebP/GIF). Quality 85: cukup untuk
/// membaca teks manga tanpa blow-up ukuran.
fn to_jpeg(bytes: &[u8], idx: usize, url: &str) -> anyhow::Result<Vec<u8>> {
    let cursor = std::io::Cursor::new(bytes);
    let reader = ImageReader::new(cursor)
        .with_guessed_format()
        .map_err(|e| anyhow::anyhow!("halaman {idx} ({url}): format tidak terdeteksi: {e}"))?;
    let format = reader.format();
    let img = match format {
        Some(f) => image::load_from_memory_with_format(bytes, f),
        None => image::load_from_memory(bytes),
    }
    .map_err(|e| anyhow::anyhow!("halaman {idx} ({url}): gagal decode: {e}"))?;
    let rgb = img.to_rgb8();
    let (w, h) = rgb.dimensions();
    let mut out = Vec::new();
    JpegEncoder::new_with_quality(&mut out, 85)
        .encode(rgb.as_raw(), w, h, ExtendedColorType::Rgb8)
        .map_err(|e| anyhow::anyhow!("halaman {idx} ({url}): gagal encode JPEG: {e}"))?;
    Ok(out)
}

/// Tulis PDF dari halaman urut. Jalur lossless dipakai selama semua (atau
/// sebagian) halaman sudah JPEG; sisanya di-re-encode.
pub fn write_pdf(pages: &[Page], out: &Path) -> anyhow::Result<PdfReport> {
    if pages.is_empty() {
        anyhow::bail!("tidak ada halaman untuk ditulis ke PDF");
    }
    let mut jpegs: Vec<Vec<u8>> = Vec::with_capacity(pages.len());
    let mut passthrough = 0usize;
    let mut reencoded = 0usize;
    for (i, p) in pages.iter().enumerate() {
        match sniff_format(&p.bytes) {
            Some(ImageFormat::Jpeg) => {
                // Pastikan header-nya bisa dibaca PDF (butuh W/H + komponen).
                if jpeg_info(&p.bytes).is_none() {
                    anyhow::bail!(
                        "halaman {} ({}): header JPEG tidak terbaca (SOF tidak ditemukan)",
                        i + 1,
                        p.url
                    );
                }
                passthrough += 1;
                jpegs.push(p.bytes.clone());
            }
            Some(fmt) => {
                jpegs.push(to_jpeg(&p.bytes, i + 1, &p.url)?);
                reencoded += 1;
                let _ = fmt;
            }
            None => anyhow::bail!(
                "halaman {} ({}): {} — ditolak, PDF tidak ditulis",
                i + 1,
                p.url,
                reject_reason(&p.bytes)
            ),
        }
    }

    let pdf = build_pdf(&jpegs)?;
    if let Some(parent) = out.parent() {
        if !parent.as_os_str().is_empty() {
            fs::create_dir_all(parent)?;
        }
    }
    let mut f = fs::File::create(out)?;
    f.write_all(&pdf)?;
    f.flush()?;
    Ok(PdfReport {
        pages: pages.len(),
        passthrough,
        reencoded,
        bytes: pdf.len(),
    })
}

// ------------------------------------------------------- JPEG header parse

/// (width, height, components) dari marker SOF. `None` kalau SOF tak ketemu.
fn jpeg_info(bytes: &[u8]) -> Option<(u32, u32, u8)> {
    if bytes.len() < 4 || bytes[0] != 0xFF || bytes[1] != 0xD8 {
        return None;
    }
    let mut i = 2usize;
    while i + 1 < bytes.len() {
        if bytes[i] != 0xFF {
            i += 1; // resync (marker padding)
            continue;
        }
        let marker = bytes[i + 1];
        // Standalone marker tanpa payload.
        if marker == 0xD8 || marker == 0xD9 || (0xD0..=0xD7).contains(&marker) || marker == 0x01 {
            i += 2;
            continue;
        }
        if i + 4 > bytes.len() {
            return None;
        }
        let seg_len = u16::from_be_bytes([bytes[i + 2], bytes[i + 3]]) as usize;
        // SOF0..SOF15 kecuali C4 (DHT), C8 (JPG), CC (DAC).
        if (0xC0..=0xCF).contains(&marker)
            && marker != 0xC4
            && marker != 0xC8
            && marker != 0xCC
        {
            if i + 10 > bytes.len() {
                return None;
            }
            let height = u16::from_be_bytes([bytes[i + 5], bytes[i + 6]]) as u32;
            let width = u16::from_be_bytes([bytes[i + 7], bytes[i + 8]]) as u32;
            let comps = bytes[i + 9];
            if width == 0 || height == 0 {
                return None;
            }
            return Some((width, height, comps));
        }
        i += 2 + seg_len;
    }
    None
}

fn colorspace(components: u8) -> &'static str {
    match components {
        1 => "DeviceGray",
        3 => "DeviceRGB",
        4 => "DeviceCMYK",
        _ => "DeviceRGB",
    }
}

// --------------------------------------------------------- minimal PDF gen

struct PdfBuilder {
    buf: Vec<u8>,
    offsets: Vec<usize>,
}

impl PdfBuilder {
    fn new() -> Self {
        let mut b = PdfBuilder { buf: Vec::new(), offsets: Vec::new() };
        b.raw("%PDF-1.5\n");
        // Penanda biner: menghindari "text mode" translation di transfer file.
        b.buf.extend_from_slice(&[0x25, 0xE2, 0xE3, 0xCF, 0xD3, 0x0A]);
        b
    }

    fn raw(&mut self, s: &str) {
        self.buf.extend_from_slice(s.as_bytes());
    }

    fn begin(&mut self, num: usize) {
        assert_eq!(num, self.offsets.len() + 1, "objek harus urut");
        self.offsets.push(self.buf.len());
        self.raw(&format!("{num} 0 obj\n"));
    }

    fn end(&mut self) {
        self.buf.extend_from_slice(b"endobj\n");
    }

    /// xref + trailer + startxref. Mengembalikan error kalau offset > 9 digit
    /// (PDF > 1 GB — mustahil untuk chapter komik normal).
    fn finish(mut self, root: usize) -> anyhow::Result<Vec<u8>> {
        let count = self.offsets.len() + 1;
        let xref_pos = self.buf.len();
        self.raw(&format!("xref\n0 {count}\n"));
        self.buf.extend_from_slice(b"0000000000 65535 f \n");
        // Indeks (bukan referensi) supaya `self.raw` bisa pinjam mutable.
        for i in 0..self.offsets.len() {
            let off = self.offsets[i];
            if off > 99_999_999 {
                anyhow::bail!("PDF terlalu besar untuk xref 10-digit ({off} byte)");
            }
            self.raw(&format!("{off:010} 00000 n \n"));
        }
        self.raw(&format!(
            "trailer\n<< /Size {count} /Root {root} 0 R >>\nstartxref\n{xref_pos}\n%%EOF\n"
        ));
        Ok(self.buf)
    }
}

fn build_pdf(images: &[Vec<u8>]) -> anyhow::Result<Vec<u8>> {
    let infos: Vec<(u32, u32, u8)> = images
        .iter()
        .map(|b| jpeg_info(b).expect("sudah divalidasi sebelum build_pdf"))
        .collect();

    let mut b = PdfBuilder::new();
    // 1 = catalog, 2 = pages.
    b.begin(1);
    b.raw("<< /Type /Catalog /Pages 2 0 R >>\n");
    b.end();

    let kids: Vec<String> = (0..images.len())
        .map(|i| format!("{} 0 R", 3 + i * 3))
        .collect();
    b.begin(2);
    b.raw(&format!(
        "<< /Type /Pages /Count {} /Kids [{}] >>\n",
        images.len(),
        kids.join(" ")
    ));
    b.end();

    for (i, bytes) in images.iter().enumerate() {
        let (w, h, comps) = infos[i];
        let page_obj = 3 + i * 3;
        let img_obj = page_obj + 1;
        let content_obj = page_obj + 2;

        b.begin(page_obj);
        b.raw(&format!(
            "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 {w} {h}] \
             /Resources << /XObject << /Im0 {img_obj} 0 R >> >> \
             /Contents {content_obj} 0 R >>\n"
        ));
        b.end();

        b.begin(img_obj);
        b.raw(&format!(
            "<< /Type /XObject /Subtype /Image /Width {w} /Height {h} \
             /ColorSpace /{} /BitsPerComponent 8 /Filter /DCTDecode /Length {} >>\nstream\n",
            colorspace(comps),
            bytes.len()
        ));
        b.buf.extend_from_slice(bytes);
        b.buf.extend_from_slice(b"\nendstream\n");
        b.end();

        // cm = skala gambar pas ke MediaBox 1:1.
        let content = format!("q {w} 0 0 {h} 0 0 cm /Im0 Do Q\n");
        b.begin(content_obj);
        b.raw(&format!("<< /Length {} >>\nstream\n", content.len()));
        b.buf.extend_from_slice(content.as_bytes());
        b.buf.extend_from_slice(b"endstream\n");
        b.end();
    }

    b.finish(1)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// JPEG 1x1 sintetis (SOF0, 3 komponen) dengan panjang segmen yang benar.
    fn tiny_jpeg() -> Vec<u8> {
        let mut b = Vec::new();
        b.extend_from_slice(&[0xFF, 0xD8]); // SOI
        b.extend_from_slice(&[0xFF, 0xE0, 0x00, 0x10]); // APP0, len 16
        b.extend_from_slice(b"JFIF      "); // 14B payload
        b.extend_from_slice(&[0xFF, 0xDB, 0x00, 0x04, 0x00, 0x10]); // DQT, len 4
        b.extend_from_slice(&[0xFF, 0xC0, 0x00, 0x11, 0x08]); // SOF0, len 17, presisi 8
        b.extend_from_slice(&[0x00, 0x01, 0x00, 0x01]); // height 1, width 1
        b.push(0x03); // 3 komponen
        b.extend_from_slice(&[0x01, 0x22, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01]); // 9B
        b.extend_from_slice(&[0xFF, 0xC4, 0x00, 0x14]); // DHT, len 20
        b.extend_from_slice(&[0x00; 18]);
        b.extend_from_slice(&[0xFF, 0xDA, 0x00, 0x08, 0x01, 0x01, 0x00, 0x00, 0x3F, 0x00]); // SOS
        b.extend_from_slice(&[0xFF, 0xD9]); // EOI
        b
    }

    #[test]
    fn sniff_rejects_html_and_accepts_images() {
        assert_eq!(sniff_format(&tiny_jpeg()), Some(ImageFormat::Jpeg));
        assert_eq!(sniff_format(b"\x89PNG\r\n\x1a\n...."), Some(ImageFormat::Png));
        assert_eq!(sniff_format(b"GIF89a...."), Some(ImageFormat::Gif));
        assert_eq!(sniff_format(b"RIFF____WEBPVP8 "), Some(ImageFormat::Webp));
        assert_eq!(sniff_format(b"<!DOCTYPE html><html>"), None);
        assert_eq!(sniff_format(b"{\"error\":\"not found\"}"), None);
        assert_eq!(sniff_format(b""), None);
        assert!(reject_reason(b"<html><body>403</body></html>").contains("HTML"));
        assert!(reject_reason(b"{\"retcode\":404}").contains("JSON"));
    }

    #[test]
    fn jpeg_header_dimensions_parsed() {
        let (w, h, c) = jpeg_info(&tiny_jpeg()).expect("SOF0 terbaca");
        assert_eq!((w, h, c), (1, 1, 3));
        assert_eq!(colorspace(c), "DeviceRGB");
        assert!(jpeg_info(b"\xFF\xD8\xFF").is_none(), "JPEG tanpa SOF");
    }

    #[test]
    fn passthrough_pdf_writes_valid_structure() {
        let dir = std::env::temp_dir().join(format!("komik-pdf-ut-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let out = dir.join("ch1.pdf");
        let pages = vec![
            Page { url: "https://a/1.jpg".into(), bytes: tiny_jpeg() },
            Page { url: "https://a/2.jpg".into(), bytes: tiny_jpeg() },
        ];
        let report = write_pdf(&pages, &out).unwrap();
        assert_eq!(report.pages, 2);
        assert_eq!(report.passthrough, 2, "semua JPEG -> lossless");
        assert_eq!(report.reencoded, 0);

        let pdf = fs::read(&out).unwrap();
        let text = String::from_utf8_lossy(&pdf);
        assert!(text.starts_with("%PDF-1.5"));
        assert!(text.contains("/Type /Catalog"));
        assert!(text.contains("/Type /Pages"));
        assert!(text.contains("/Count 2"));
        assert!(text.contains("/Filter /DCTDecode"));
        assert!(text.contains("/MediaBox [0 0 1 1]"));
        assert!(text.trim_end().ends_with("%%EOF"));
        // byte JPEG asli harus utuh (lossless passthrough).
        assert!(pdf.windows(tiny_jpeg().len()).any(|w| w == tiny_jpeg().as_slice()));

        // startxref harus menunjuk ke "xref".
        let marker = text.rfind("startxref").unwrap();
        let offset: usize = text[marker + "startxref".len()..]
            .trim_start()
            .lines()
            .next()
            .unwrap()
            .trim()
            .parse()
            .unwrap();
        assert_eq!(&pdf[offset..offset + 4], b"xref");

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn html_body_is_refused() {
        let dir = std::env::temp_dir().join(format!("komik-pdf-ut2-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let out = dir.join("x.pdf");
        let pages = vec![Page {
            url: "https://a/1.jpg".into(),
            bytes: b"<!DOCTYPE html><html><title>403</title></html>".to_vec(),
        }];
        let err = write_pdf(&pages, &out).unwrap_err().to_string();
        assert!(err.contains("ditolak"), "err: {err}");
        assert!(!out.exists(), "PDF tidak boleh tertulis sebagian");
        let _ = fs::remove_dir_all(&dir);
    }
}
