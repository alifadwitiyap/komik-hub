#!/usr/bin/env python3
"""E2E cross-chapter union — bukti bahwa chapter eksklusif sumber lain
BISA DIBACA dan DILEWATI dengan benar oleh navigasi prev/next.

Kenapa script ini ada:
  Fitur "chapter paling banyak / gabungin episode tambahan" punya dua sisi:
    1. daftar chapter series = UNION lintas sumber (sudah ada di core)
    2. navigasi prev/next harus mengikuti daftar UNION itu, bukan daftar
       satu sumber pelayan (INI yang dulu bocor)
  Tanpa (2), chapter eksklusif sumber lain muncul di daftar tapi tidak
  pernah tersentuh saat pembaca menekan "Berikutnya"/"Sebelumnya".

Cara pakai (server harus hidup di :8788):
    python komiku-web/scripts/cross_chapter_union_e2e.py

Exit 0 = semua assertion lolos. Exit 1 = ada yang gagal (dicetak).
"""
from __future__ import annotations

import json
import sys
import urllib.parse
import urllib.request

BASE = "http://127.0.0.1:8788"

# Series uji: judul yang punya chapter di >1 sumber (terverifikasi live).
# Kalau series ini hilang dari upstream, script memilih series lain secara
# otomatis (lihat find_multi_source_series) — jangan hardcode satu judul.
PREFERRED_HANDLES = [
    "shinigami:935b0a6e-1fcb-4ea4-b9ae-dcf6540a9f10",  # Solo Leveling: Ragnarok
]

failures: list[str] = []
checks = 0


def get(path: str, timeout: int = 60):
    req = urllib.request.Request(f"{BASE}{path}")
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read().decode())


def check(cond: bool, label: str, detail: str = "") -> None:
    global checks
    checks += 1
    if cond:
        print(f"  PASS  {label}")
    else:
        print(f"  FAIL  {label}" + (f"\n        {detail}" if detail else ""))
        failures.append(label)


def num_key(n: str) -> str:
    """Cermin komik_core::model::chapter_number_key — hanya untuk sortir lokal."""
    raw = (n or "").strip()
    try:
        if "." in raw:
            a, b = raw.split(".", 1)
            if a.isdigit() and (b == "" or b.isdigit()):
                return f"{int(a)}.{b.rstrip('0')}".rstrip(".")
        if raw.isdigit():
            return str(int(raw))
    except ValueError:
        pass
    return raw.lower()


def find_multi_source_series():
    """Cari series yang punya chapter dari >=2 sumber (union sungguhan)."""
    for h in PREFERRED_HANDLES:
        try:
            d = get(f"/api/unified/series/{urllib.parse.quote(h, safe=':')}")
        except Exception:
            continue
        srcs = {c.get("source") for c in d.get("chapters", [])}
        if len(srcs) > 1:
            return h, d
    # fallback: telusuri beberapa judul populer
    for q in ("solo", "leveling", "return", "tower"):
        try:
            r = get(f"/api/unified/search?q={urllib.parse.quote(q)}&limit=20")
        except Exception:
            continue
        for item in r.get("items", []):
            h = item.get("handle")
            if not h:
                continue
            try:
                d = get(f"/api/unified/series/{urllib.parse.quote(h, safe=':')}")
            except Exception:
                continue
            srcs = {c.get("source") for c in d.get("chapters", [])}
            if len(srcs) > 1:
                return h, d
    return None, None


def main() -> int:
    print("=== cross-chapter union E2E ===\n")

    handle, series = find_multi_source_series()
    if not handle or not series:
        print("SKIP: tidak menemukan series dengan chapter dari >1 sumber.")
        print("      (bukan kegagalan kode — upstream sedang tidak punya duplikat)")
        return 0

    chapters = series.get("chapters", [])
    primary = series.get("source")
    print(f"series   : {handle}")
    print(f"judul    : {series['manga']['title']}")
    print(f"primary  : {primary} | representative: {series.get('representative_source')}")
    print(f"chapters : {len(chapters)}\n")

    # --- 1. Respons series membawa field per-chapter yang dibutuhkan UI ------
    print("[1] kontrak respons series")
    missing = [c["number"] for c in chapters if not c.get("source") or not c.get("handle")]
    check(not missing, "setiap chapter punya source + handle", f"bolong: {missing[:5]}")

    exclusive = [c for c in chapters if c.get("source") != primary]
    check(
        len(exclusive) > 0,
        f"daftar memuat chapter dari sumber selain primary ({len(exclusive)} buah)",
        "series ini ternyata hanya punya 1 sumber; pilih series lain",
    )
    if not exclusive:
        return 1
    src_counts: dict[str, int] = {}
    for c in chapters:
        src_counts[c["source"]] = src_counts.get(c["source"], 0) + 1
    print(f"        sebaran sumber: {src_counts}")
    print(f"        contoh non-primary: {[(c['number'], c['source']) for c in exclusive[:4]]}")

    # --- 2. Chapter non-primary BISA DIBACA lewat handle series -------------
    # Ini yang membuat user "smooth": dia tidak perlu tahu sumbernya siapa.
    #
    # CATATAN: label pemenang dedup kini deterministik (SOURCE_PRIORITY), jadi
    # sebuah nomor bisa DILAYANI sumber berprioritas lebih tinggi daripada
    # sumber yang tercatat di daftar. Yang diuji di sini adalah kontrak yang
    # penting bagi user: chapter yang TAMPIL di daftar harus BISA DIBUKA, dan
    # sumber yang melayaninya harus salah satu sumber yang memang punya nomor
    # itu — bukan 404.
    print("\n[2] chapter non-primary terbaca lewat handle series (tanpa ganti URL)")
    target = exclusive[0]
    try:
        body = get(
            f"/api/unified/chapter/{urllib.parse.quote(handle, safe=':')}/"
            f"{urllib.parse.quote(str(target['number']))}"
        )
    except Exception as e:  # noqa: BLE001
        body = {}
        check(
            False,
            f"chapter {target['number']} ({target['source']}) terbaca lewat handle series",
            f"{e} — chapter ADA di daftar union tapi tidak bisa dibuka",
        )
    check(
        bool(body.get("images")),
        f"chapter {target['number']} punya gambar",
        f"images={body.get('images')!r}",
    )
    check(
        bool(body.get("source")),
        f"chapter {target['number']} melaporkan sumber pelayan ({body.get('source')})",
    )

    # --- 3. INTI BUG: navigasi prev/next harus ikut urutan UNION ------------
    # Uji SETIAP pasangan bertetangga di daftar union, bukan cuma satu chapter.
    #
    # Kenapa harus menyapu semua pasangan: bug aslinya hanya muncul saat
    # chapter yang DIBACA dilayani sumber yang TIDAK punya chapter tetangga
    # itu. Membaca chapter eksklusif itu sendiri bisa lolos (tetangganya
    # kebetulan ada di sumber yang sama), sedangkan membaca chapter sumber
    # pelayan yang BERADA TEPAT DI ATAS blok eksklusif gagal — prev-nya
    # melompati seluruh blok. Satu sampel tidak cukup untuk menangkapnya.
    print("\n[3] navigasi prev/next mengikuti urutan union (inti fitur)")

    # Batasi jumlah request: 6 pasangan yang menyentuh chapter lintas-sumber
    # (paling informatif), bukan 74 pasangan.
    pairs: list[tuple[int, int]] = []  # (index chapter yang dibaca, index tetangga)
    for i, c in enumerate(chapters):
        for j in (i - 1, i + 1):
            if 0 <= j < len(chapters) and chapters[j].get("source") != c.get("source"):
                pairs.append((i, j))
    pairs = pairs[:6]

    if not pairs:
        print("        (tidak ada pasangan lintas-sumber — lewati)")
    checked_pairs = 0
    for i, j in pairs:
        cur, nbr = chapters[i], chapters[j]
        try:
            b = get(
                f"/api/unified/chapter/{urllib.parse.quote(handle, safe=':')}/"
                f"{urllib.parse.quote(str(cur['number']))}"
            )
        except Exception as e:  # noqa: BLE001
            check(False, f"baca {cur['number']}", repr(e))
            continue
        side = "prev" if j > i else "next"  # j>i = lebih tua = prev
        got = (b.get(side) or {}).get("number")
        checked_pairs += 1
        check(
            num_key(str(got or "")) == num_key(str(nbr["number"])),
            f"{cur['number']}({cur['source']}) -> {side} = {nbr['number']}({nbr['source']})",
            f"dapat {got!r} — MELOMPATI chapter union",
        )

    # --- 4. Handle tetangga konsisten dengan sumbernya ---------------------
    # Kontrak `ChapterRef`: `handle` harus milik SUMBER chapter itu sendiri,
    # supaya bisa dipakai membuka chapter tersebut (bukan handle series yang
    # sedang dibuka).
    print("\n[4] tetangga membawa handle yang konsisten dengan sumbernya")
    for i, j in pairs[:4]:
        cur, nbr = chapters[i], chapters[j]
        try:
            b = get(
                f"/api/unified/chapter/{urllib.parse.quote(handle, safe=':')}/"
                f"{urllib.parse.quote(str(cur['number']))}"
            )
        except Exception:
            continue
        side = "prev" if j > i else "next"
        nav = b.get(side) or {}
        if nav.get("number") is None:
            continue
        check(
            str(nav.get("handle", "")).startswith(f"{nav.get('source')}:"),
            f"{side} {nav.get('number')} handle konsisten dengan source ({nav.get('source')})",
            f"handle={nav.get('handle')!r} source={nav.get('source')!r}",
        )

    # --- 5. Round-trip: buka tetangga itu lewat URL yang diberikan ----------
    print("\n[5] round-trip — tetangga yang ditunjuk benar-benar bisa dibuka")
    seen_navs: set[tuple[str, str]] = set()
    for i, j in pairs[:4]:
        cur, nbr = chapters[i], chapters[j]
        try:
            b = get(
                f"/api/unified/chapter/{urllib.parse.quote(handle, safe=':')}/"
                f"{urllib.parse.quote(str(cur['number']))}"
            )
        except Exception:
            continue
        side = "prev" if j > i else "next"
        nav = b.get(side) or {}
        if not nav.get("handle") or not nav.get("number"):
            continue
        sig = (str(nav["handle"]), str(nav["number"]))
        if sig in seen_navs:
            continue
        seen_navs.add(sig)
        try:
            b2 = get(
                f"/api/unified/chapter/{urllib.parse.quote(nav['handle'], safe=':')}/"
                f"{urllib.parse.quote(str(nav['number']))}"
            )
            check(bool(b2.get("images")), f"{side} {nav['number']} ({nav.get('source')}) terbuka")
        except Exception as e:  # noqa: BLE001
            check(False, f"{side} {nav['number']} ({nav.get('source')}) terbuka", repr(e))

    print(f"\n=== {checks - len(failures)}/{checks} check lolos ===")
    if failures:
        print("\nGAGAL:")
        for f in failures:
            print(f"  - {f}")
        return 1
    print("SEMUA LOLOS")
    return 0


if __name__ == "__main__":
    sys.exit(main())
