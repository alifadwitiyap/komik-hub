---
name: rick-morty-harness
description: Use when generating the static Rick and Morty watch page (rick-morty) — CLI flags, offline fallback, playback links, testing.
---

# Rick & Morty Harness

Statis watch page generator untuk Rick and Morty (TMDB id 60625), 9 season / 91 episode
(S1=11, S2–9=10). Menggunakan backend `cli_anything.flystream.utils.flystream_backend.FlyStreamBackend`
(REUSE, jangan copy source). Berjalan di `D:\project\filmhub\rick-morty`.

## Perintah

Script JALANKAN dari `D:\project\filmhub`:

```bash
# tulis HTML default (rick-morty/output.html) dari fallback offline
python rick-morty/render/generate.py

# tulis JSON show (rick-morty/data/show.json) — untuk konsumsi data
python rick-morty/render/generate.py --json --out rick-morty/data/show.json

# coba backend live (gatuh ke fallback bila gagal / offline)
python rick-morty/render/generate.py --live
```

> CATATAN: folder bernama `rick-morty` (hyphen) tidak bisa diet `python -m rick_morty...`
> — selalu jalankan file langsung, bukan via module.

## Program flow

- `data/fallback_data.json` — data statis offline (91 episode, 12 related, poster/backdrop w500/w1280).
- `data/provider.py` — `RickMortyProvider`: `_live_show()` coba `tv_details(60625)`, `except Exception: return None` →
  `get_show()` mengembalikan live (jika ada) atau fallback. `--json` menghasilkan JSON ini.
- `render/template.py` — `render_show(show)` → HTML (warna asli refrensi: bg #0c0f17, accent #f5b14c).
- `render/generate.py` — CLI: `--out` (default rick-morty/output.html), `--json` (mode JSON), `--live`.

## Playback — PENTING

JANGAN mengarang stream URL. Semua CTA tombol = link watch-page:
`https://flystream.net/tv/60625?season=N&episode=M&play=1` (target `_blank`).
Stream tidak diekspos (anti-bot Anubis). Jujur: halaman mengarahkan ke Flystream untuk memutar.

## Test

```bash
cd /d/project/filmhub && python rick-morty/tests/test_rick_morty.py
```

Smoke offline (tanpa network): shape & episode counts, episode keys, provider fallback (Bogus backend),
render HTML, generate CLI. Harapan: `5 passed, 0 failed`.

## Sumber

Data diekstrak dari `refrensi.html` (≡ `cli_anything/rick-and-morty.html`).
Tmdb_id 60625, 9 season, 91 episode, 12 related. Poster `w500`, backdrop `w1280`.
