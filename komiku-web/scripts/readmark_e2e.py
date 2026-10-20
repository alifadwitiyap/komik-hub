"""E2E mark "sudah dibaca" per akun (Komik Hub).

Bukti features (browser sungguhan, server live di 8788):

  1. Chapter yang dibuka user → judulnya jadi ABU di daftar chapter.
  2. Chapter yang BELUM dibuka tetap terang.
  3. Isolasi antar akun: chapter yang dibuka akun A TIDAK abu buat akun B.
  4. Mark bertahan setelah reload (state server per-akun).

Data uji = konten LIVE. Nomor chapter diambil dari API (bukan di-hardcode)
supaya assertion tidak rapuh saat sumber terbit chapter baru.

  python scripts/readmark_e2e.py
  python scripts/readmark_e2e.py --base-url http://127.0.0.1:8789
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

import e2e_cleanup

from playwright.sync_api import sync_playwright

DEFAULT_BASE = "http://127.0.0.1:8788"
HANDLE = "komiku:1284"  # Reincarnator — series live yang chapter-nya punya number
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
    req = urllib.request.Request(base + path, data=data, headers=headers, method="POST" if body is not None else "GET")
    with urllib.request.urlopen(req, timeout=30) as resp:
        return json.loads(resp.read() or b"{}")



def wait_reader_loaded(page, chapter: str, timeout_s: float = 45.0) -> bool:
    """Tunggu reader benar-benar menampilkan chapter + minimal 1 gambar.

    Chapter live dari sumber bisa gagal dimuat sesaat (upstream lambat /
    server restart). Poll, jangan langsung FAIL.
    """
    deadline = time.time() + timeout_s
    while time.time() < deadline:
        try:
            ok = page.evaluate(
                """(n) => {
                    const head = document.querySelector('header')?.innerText || '';
                    const imgs = Array.from(document.querySelectorAll('img'))
                        .filter(i => i.naturalWidth > 0).length;
                    return head.includes('Chapter ' + n) && imgs > 0;
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
    return e2e_cleanup.track(
        "e2erm" + tag + "".join(random.choice(alphabet) for _ in range(6))
    )


def set_account(page, username: str, base: str) -> None:
    """Set akun aktif di localStorage lalu reload (header X-Komik-User ikut).

    localStorage hanya bisa diakses setelah document punya origin yang sama —
    jadi harus navigate dulu ke base URL sebelum evaluate.
    """
    if not page.url.startswith(base):
        page.goto(base + "/", wait_until="networkidle")
    page.evaluate("(u) => localStorage.setItem('komik-akun-v1', u)", username)
    page.reload(wait_until="networkidle")


def row_for(page, number: str):
    """Baris chapter dengan nomor tertentu (selector by aria-label)."""
    return page.locator(f'a[aria-label^="Chapter {number}"]')


def title_class(page, number: str) -> str:
    """Class JUDUL chapter (elemen span di dalam link — warna abu ada di sana)."""
    span = row_for(page, number).first.locator("span").first
    return span.get_attribute("class") or ""


def main() -> int:
    ap = argparse.ArgumentParser(prog="readmark_e2e.py")
    ap.add_argument("--base-url", default=DEFAULT_BASE)
    args = ap.parse_args()
    base = args.base_url
    os.makedirs(SHOTS, exist_ok=True)

    # Nomor chapter dari API — bukan hardcode.
    series = api(base, f"/api/unified/series/{HANDLE}")
    chapters = series.get("chapters") or []
    if len(chapters) < 2:
        print("FATAL: series seed tidak punya cukup chapter", flush=True)
        return 2
    ch_read = chapters[0]["number"]     # akan dibuka → harus jadi abu
    ch_unread = chapters[1]["number"]   # tidak dibuka → harus tetap terang
    print(f"series   : {HANDLE}")
    print(f"dibaca   : {ch_read} | belum: {ch_unread}")

    user_a = rand_user("a")
    user_b = rand_user("b")
    api(base, "/api/user/claim", body={"username": user_a})
    api(base, "/api/user/claim", body={"username": user_b})
    print(f"akun A   : {user_a}")
    print(f"akun B   : {user_b}\n")

    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        ctx = browser.new_context(viewport={"width": 1280, "height": 900}, locale="id-ID")
        page = ctx.new_page()
        errors: list[str] = []
        page.on("pageerror", lambda e: errors.append(str(e)))

        # --- 1. akun A: buka satu chapter ------------------------------------
        print("== akun A: buka chapter ==")
        set_account(page, user_a, base)
        page.goto(f"{base}/manga/{HANDLE}", wait_until="networkidle")
        page.wait_for_timeout(2500)
        row = row_for(page, ch_read)
        check("series A: baris chapter ada", row.count() > 0, f"count={row.count()}")
        cls_before = title_class(page, ch_read)
        check("A: chapter BELUM dibuka masih terang (ink-100)",
              "text-ink-100" in cls_before, cls_before[-90:])
        lbl_before = row.first.get_attribute("aria-label") or ""
        check("A: aria-label awal = belum dibaca", "belum dibaca" in lbl_before, lbl_before)

        row.first.click()
        page.wait_for_url("**/baca/**", timeout=20000)
        page.wait_for_timeout(3500)

        # PREKONDISI: chapter harus benar-benar termuat di reader. Kalau tidak
        # (server restart, upstream lambat, gambar gagal) mark tak pernah
        # dibuat dan SEMUA check mark di bawah gagal karena alasan yang salah.
        # Bedakan "lingkungan rusak" dari "fitur rusak".
        reader_ok = wait_reader_loaded(page, ch_read)
        if not reader_ok:
            check("PRASYARAT: chapter termuat di reader (chapter %s)" % ch_read, False,
                  "reader tak menampilkan chapter — cek server 8788 / upstream (lingkungan, bukan fitur)")
            page.screenshot(path=SHOTS + "/0-reader-gagal-load.png")
            browser.close()
            print(f"\nGAGAL PRASYARAT: chapter {ch_read} tak termuat di reader. "
                  f"INI masalah lingkungan (server/upstream), bukan fitur read-mark.")
            return 2
        check("PRASYARAT: chapter termuat di reader", True)

        # --- 2. kembali ke series → harus abu --------------------------------
        print("== akun A: kembali ke series ==")
        page.goto(f"{base}/manga/{HANDLE}", wait_until="networkidle")
        page.wait_for_timeout(2500)
        row = row_for(page, ch_read)
        cls_after = title_class(page, ch_read)
        check("A: chapter yang dibuka jadi ABU (ink-500)",
              "text-ink-500" in cls_after, cls_after[-90:])
        lbl_after = row.first.get_attribute("aria-label") or ""
        check("A: aria-label = sudah dibaca", "sudah dibaca" in lbl_after, lbl_after)
        page.screenshot(path=SHOTS + "/1-akunA-abu.png")

        row2 = row_for(page, ch_unread)
        cls2 = title_class(page, ch_unread)
        check("A: chapter yang BELUM dibuka tetap terang (ink-100)",
              "text-ink-100" in cls2, cls2[-90:])

        body = page.inner_text("body")
        check("A: ringkasan 'sudah dibaca' muncul", "sudah dibaca" in body, body[:0])

        # --- 3. isolasi: akun B tak boleh lihat mark A -----------------------
        print("== akun B: isolasi ==")
        set_account(page, user_b, base)
        page.wait_for_timeout(2500)
        row = row_for(page, ch_read)
        cls_b = title_class(page, ch_read)
        check("B: chapter yang dibuka A tetap TERANG (ink-100)",
              "text-ink-100" in cls_b, cls_b[-90:])
        lbl_b = row.first.get_attribute("aria-label") or ""
        check("B: aria-label = belum dibaca", "belum dibaca" in lbl_b, lbl_b)
        page.screenshot(path=SHOTS + "/2-akunB-terang.png")

        # --- 4. mark bertahan setelah reload ---------------------------------
        print("== persistensi ==")
        set_account(page, user_a, base)
        page.wait_for_timeout(2500)
        row = row_for(page, ch_read)
        cls_r = title_class(page, ch_read)
        check("A: mark bertahan setelah reload (ink-500)", "text-ink-500" in cls_r, cls_r[-90:])

        # --- 4b. reload CEPAT (sebelum debounce push jalan) -------------------
        # Mark harus tetap sampai ke server walau tab ditutup <1,2 detik
        # setelah chapter dibuka (pending di-persist ke localStorage).
        print("== push+tab+ditutup+cepat ==")
        fast_ch = chapters[2]["number"]
        page.goto(f"{base}/manga/{HANDLE}", wait_until="networkidle")
        page.wait_for_timeout(2000)
        row_for(page, fast_ch).first.click()
        page.wait_for_url("**/baca/**", timeout=20000)
        # Tunggu sampai mark TERCATAT di localStorage (bukan sampai fetch
        # selesai) — baru tutup tab sebelum debounce 1,2 detik jalan.
        marked = False
        for _ in range(60):
            marked = bool(
                page.evaluate(
                    """(ch) => Object.keys(localStorage)
                        .filter(k => k.startsWith('komik.readmarks.v1'))
                        .some(k => Object.keys(JSON.parse(localStorage.getItem(k) || '{}'))
                                  .some(mk => mk.endsWith(':' + ch)))""",
                    fast_ch,
                )
            )
            if marked:
                break
            page.wait_for_timeout(100)
        check("mark chapter baru tercatat di cache lokal", marked, f"chapter {fast_ch}")
        page.goto(f"{base}/manga/{HANDLE}", wait_until="networkidle")
        page.wait_for_timeout(3500)  # boot: pending dimuat ulang + dipush
        marks_a = api(base, "/api/read", user=user_a).get("marks", {})
        fast_seen = any(fast_ch in s for s in marks_a.values())
        check("mark chapter yang dibuka lalu tab ditutup CEPAT tetap sampai ke server",
              fast_seen, f"chapter {fast_ch} di {list(marks_a.values())}")

        # --- 4c. sheet "Pilih Chapter" di reader juga abu -------------------
        print("== sheet pilih chapter ==")
        page.goto(f"{base}/manga/{HANDLE}", wait_until="networkidle")
        page.wait_for_timeout(2000)
        row_for(page, ch_read).first.click()
        page.wait_for_url("**/baca/**", timeout=20000)
        page.wait_for_timeout(3000)
        picker_btn = page.locator('button[aria-label*="chapter" i], button[aria-label*="Chapter" i]')
        if picker_btn.count() > 0:
            picker_btn.first.click()
            page.wait_for_timeout(2500)
            sheet = page.locator("[data-chapter-picker]")
            check("sheet: panel pilih chapter terbuka", sheet.count() > 0)
            if sheet.count() > 0:
                # Chapter YANG SEDANG dibaca = "Dip baca" (tanpa label), jadi
                # cek chapter LAIN yang sudah pernah dibuka (fast_ch).
                item = sheet.locator(f'a[aria-label^="Chapter {fast_ch}"]')
                check("sheet: chapter yang pernah dibaca punya label 'sudah dibaca'",
                      item.count() > 0 and "sudah dibaca" in (item.first.get_attribute("aria-label") or ""),
                      (item.first.get_attribute("aria-label") or "tidak ada") if item.count() else "tidak ada item")
                page.screenshot(path=SHOTS + "/3-sheet-abu.png")
        else:
            check("sheet: tombol pilih chapter ada", False, "tombol tak ditemukan")

        check("tidak ada error JS", not errors, "; ".join(errors[:2]))
        browser.close()

    # --- 5. state server: mark milik akun A saja ---------------------------
    print("== state server ==")
    a_marks = api(base, "/api/read", user=user_a).get("marks", {})
    b_marks = api(base, "/api/read", user=user_b).get("marks", {})
    a_ch = {c for s in a_marks.values() for c in s}
    b_ch = {c for s in b_marks.values() for c in s}
    check("server: akun A punya mark", len(a_ch) >= 1, str(a_ch))
    check("server: akun B tidak punya mark A", not (a_ch & b_ch), f"A={a_ch} B={b_ch}")

    # Bersihkan state akun throwaway (file users/progress/read). Tanpa ini
    # tiap run meninggalkan file di data/ server — 121 file terkumpul dari
    # belasan run read-mark.
    removed = e2e_cleanup.cleanup_claimed()
    if removed:
        print(f"cleanup: {len(removed)} file state akun tes dihapus")

    print()
    print(f"lulus: {len(passed)}  gagal: {len(failed)}")
    if failed:
        for f in failed:
            print("  FAIL:", f)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
