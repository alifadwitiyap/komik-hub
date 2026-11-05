# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Pemilik tunggal: tresna, membaca dan memantau update komik lintas sumber dalam satu feed. Tidak ada audiens publik terkonfirmasi.

## Product Purpose

Mengumpulkan komik dari empat sumber (komiku, mangaku, shinigami, kiryuu) ke satu antarmuka web, sehingga pembaca tidak perlu membuka banyak tab atau mengecek tiap sumber secara terpisah. Sukses = satu sumber kebenaran yang ringkas untuk update terbaru dan akses baca langsung.

## Positioning

Union lintas-sumber dengan dedup: satu kartu per seri (bukan duplikat lintas sumber), ceiling chapter tertinggi lintas sumber, dan identitas seri yang disatukan lintas sumber. Ini yang tidak bisa ditiru oleh sumber individual.

## Operating Context

- Browser web (SPA React + Vite). API di-proxy ke server Rust lokal (komiku-server, port 8788).
- Aggregator Rust menarik dari 4 sumber dengan circuit breaker per-sumber; satu upstream down tidak menjatuhkan app.
- Feed "Update terbaru" menampilkan satu kartu per seri, pemenang = entry dengan last_chapter numerik tertinggi dalam grup; pada tie, divalidasi dengan daftar chapter nyata, fallback ke prioritas sumber.
- Reader mendukung maraton, offline, dan notifikasi update terpusat.

## Capabilities and Constraints

- Dikonfirmasi: dedup feed, ceiling chapter, identitas seri lintas sumber, reader maraton, offline, notifikasi update.
- UI sepenuhnya dalam Bahasa Indonesia.
- Sumber upstream ada di belakang Cloudflare; 522/000 = origin down, bukan bug kode.

## Brand Commitments

Tidak ada komitmen merek/voice yang mengikat; fokus fungsi dan netral.

## Evidence on Hand

- Setupbase aktif di `komiku-web/` (frontend) dan `komiku-server/` (Rust API).
- Integrated pipeline lintas-sumber di `komik/core/` (aggregator + 4 adapter).
- Skill dev internal `komik-hub-development` mendokumentasikan model dedup, penanganan upstream, dan pitfall.

## Product Principles

- Satu kebenaran: dedup dan ceiling chapter menjamin satu kartu per seri.
- Ketahanan: circuit breaker per-sumber — satu upstream gagal tidak menjatuhkan app.
- Jujur soal sumber: kesalahan upstream dilaporkan apa adanya, tidak disamarkan sebagai bug lokal.
- Fokus fungsi: netral, tanpa usaha visual berlebihan.

## Accessibility & Inclusion

Belum ada kebutuhan spesifik produk yang ditetapkan.
