"""E2E mark "sudah dibaca" di mode MARATON (chain chapter).

Maraton berbeda dari reader biasa: chapter berikutnya di-load otomatis saat
progress chapter sebelumnya >= 80%. Yang harus ter-mark HANYA chapter yang
SEDANG dibaca (blok baca aktif) — chapter yang cuma di-preload belum tentu
dibaca user, jadi jangan abu.

Syarat: chapter awal harus punya `next` (chapter terbaru tidak punya, jadi
rantainya tak akan pernah berantai).

  python scripts/readmark_marathon_e2e.py
"""
from __future__ import annotations

import argparse
import json
import os
import random
import string
import sys
import time
import urllib.request

from playwright.sync_api import sync_playwright

DEFAULT_BASE = "http://127.0.0.1:8788"
HANDLE = "komiku:1284"
SHOTS = r"C:\Users\LENOVO LEGION\AppData\Local\Temp\readmark_e2e"

passed: list[str] = []
failed: list[str] = []


def check(name: str, cond: bool, extra: str = "") -> bool:
    (passed if cond else failed).append(name)
    print(f"  {'PASS' if cond else 'FAIL'}  {name}" + (f"  [{extra}]" if extra else ""))
    return bool(cond)


def api(base: str, path: str, user: str | None = None, body=None):
    data = json.dumps(body).encode() if body is not None else None
    headers = {"Accept": "application/json"}
    if data:
        headers["Content-Type"] = "application/json"
    if user:
        headers["X-Komik-User"] = user
    req = urllib.request.Request(
        base + path, data=data, headers=headers, method="POST" if body is not None else "GET"
    )
    with urllib.request.urlopen(req, timeout=30) as resp:
        return json.loads(resp.read() or b"{}")



def wait_reader_loaded(page, chapter: str | None = None, timeout_s: float = 45.0) -> bool:
    """Tunggu reader menampilkan chapter + minimal 1 gambar (poll, bukan sleep).

    `chapter` = nomor chapter yang diharapkan; None = cukup header "Chapter"
    dan ada gambar.
    """
    deadline = time.time() + timeout_s
    while time.time() < deadline:
        try:
            ok = page.evaluate(
                """(n) => {
                    const head = document.querySelector('header')?.innerText || '';
                    const imgs = Array.from(document.querySelectorAll('img'))
                        .filter(i => i.naturalWidth > 0).length;
                    const hasChapter = n ? head.includes('Chapter ' + n)
                                         : head.includes('Chapter');
                    return hasChapter && imgs > 0;
                }""",
                chapter,
            )
        except Exception:
            ok = False
        if ok:
            return True
        page.wait_for_timeout(500)
    return False


def rand_user(tag: str) -> str:
    alphabet = string.ascii_lowercase + string.digits
    return "e2erm" + tag + "".join(random.choice(alphabet) for _ in range(6))


def main() -> int:
    ap = argparse.ArgumentParser(prog="readmark_marathon_e2e.py")
    ap.add_argument("--base-url", default=DEFAULT_BASE)
    args = ap.parse_args()
    base = args.base_url
    os.makedirs(SHOTS, exist_ok=True)

    series = api(base, f"/api/unified/series/{HANDLE}")
    chapters = series.get("chapters") or []
    if len(chapters) < 3:
        print("FATAL: series seed tidak punya cukup chapter", flush=True)
        return 2
    # Chapter AWAL harus punya `next` — cari dari API, jangan hardcode
    # (chapter terbaru `next`-nya null, rantainya tak akan pernah terjadi).
    start = None
    # cukup 3 kandidat: chapter paling baru biasanya punya `next` ke arah
    # episode SEBELUM-nya? tidak — next = nomor lebih besar. Cari di 3 teratas.
    for c in chapters[:3]:
        ch = api(base, f"/api/unified/chapter/{HANDLE}/{c['number']}")
        if ch.get("next"):
            start = (c["number"], ch["next"]["number"])
            break
    if not start:
        print("FATAL: tak ada chapter dengan `next` (rantai tak akan pernah terjadi)", flush=True)
        return 2
    first, second = start

    user = rand_user("m")
    api(base, "/api/user/claim", body={"username": user})
    print(f"akun    : {user}\nmaraton : chapter {first} -> {second}\n")

    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        ctx = browser.new_context(viewport={"width": 1280, "height": 900}, locale="id-ID")
        page = ctx.new_page()
        errors: list[str] = []
        page.on("pageerror", lambda e: errors.append(str(e)))

        page.goto(base + "/", wait_until="networkidle")
        page.evaluate("(u) => localStorage.setItem('komik-akun-v1', u)", user)
        page.reload(wait_until="networkidle")

        page.goto(f"{base}/maraton/{HANDLE}/{first}", wait_until="networkidle")
        page.wait_for_timeout(6000)

        # PREKONDISI: chapter harus termuat — kalau tidak, mark tak pernah
        # dibuat dan check di bawah gagal karena alasan yang salah.
        reader_ok = wait_reader_loaded(page, first)
        if not reader_ok:
            check("PRASYARAT: chapter termuat di reader", False,
                  "reader tak menampilkan chapter (server/upstream, bukan fitur)")
            browser.close()
            print("\nGAGAL PRASYARAT: chapter tak termuat. Masalah lingkungan, bukan fitur.")
            return 2
        check("PRASYARAT: chapter termuat di reader", True)

        marks = api(base, "/api/read", user=user).get("marks", {})
        ch_read = {c for s in marks.values() for c in s}
        check("maraton: chapter yang sedang dibaca ter-mark", first in ch_read, f"marks={sorted(ch_read)}")
        check("maraton: chapter berikutnya BELUM ter-mark (belum dibaca)", second not in ch_read,
              f"marks={sorted(ch_read)}")

        # Gulir ke bawah → chaining chapter berikutnya + blok baca aktif maju.
        for _ in range(16):
            page.evaluate("() => window.scrollTo(0, document.documentElement.scrollHeight)")
            page.wait_for_timeout(1500)
        page.wait_for_timeout(3000)
        marks2 = api(base, "/api/read", user=user).get("marks", {})
        ch2 = {c for s in marks2.values() for c in s}
        check("maraton: chapter lanjutan ter-mark setelah digulir", second in ch2, f"marks={sorted(ch2)}")
        page.screenshot(path=SHOTS + "/4-maraton.png")

        check("tidak ada error JS", not errors, "; ".join(errors[:2]))
        browser.close()

    print()
    print(f"lulus: {len(passed)}  gagal: {len(failed)}")
    if failed:
        for f in failed:
            print("  FAIL:", f)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
