"""E2E W3 — auto-trigger unduh PDF ke perangkat setelah generate (keputusan Q22.A).

⚠️ BATAS VERIFIKASI HEADLESS (penting, jangan salah baca):
Chromium headless via Playwright sering melaporkan unduhan sebagai
`failure='canceled'` dengan 0 byte WALAU server mengirim file penuh
(200 + content-disposition attachment + 8,2 MB — dibuktikan lewat curl).
Varian eksperimen (anchor dihapus sinkron / tidak dihapus / dihapus setelah
jeda / SW diblok / goto langsung) GAGAL IDENTIK → itu keterbatasan capture
headless, BUKAN bug auto-trigger. Karena itu skrip ini HANYA memverifikasi
yang memang bisa diverifikasi headless:
  - event `download` benar-benar terpicu setelah klik "Unduh" (auto-trigger jalan)
  - `suggested_filename` = nama dari server (`<series> - Chapter <n>.pdf`)
  - entri tersimpan di server (buffer 24 jam) dengan nomor chapter benar
Verifikasi "byte PDF utuh sampai ke disk" harus dilakukan di browser
NON-headless (unduhan nyata) — di luar cakupan skrip ini.

Skenario:
  1. claim akun scratch + set localStorage (identitas X-Komik-User)
  2. buka /manga/komiku:6426, mode range, pilih 1 chapter, klik "Unduh (1)"
  3. `page.expect_download()` → assert nama file .pdf dari server
  4. assert entri muncul di GET /api/unified/downloads (server buffer)

Jalankan: python scripts/w3_autodownload_e2e.py --base-url http://127.0.0.1:8790
"""
import argparse
import os
import re
import sys
import urllib.request
import urllib.error
import json

from playwright.sync_api import sync_playwright

SHOTS = r"C:\Users\LENOVO LEGION\AppData\Local\Temp\w3_autodownload_e2e"
os.makedirs(SHOTS, exist_ok=True)

passed, failed = [], []


def check(name, cond, extra=""):
    (passed if cond else failed).append(name)
    print(f"  {'PASS' if cond else 'FAIL'}  {name}" + (f"  [{extra}]" if extra else ""))


def api(base, method, path, body=None, user=None):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(base + path, data=data, method=method)
    if data is not None:
        req.add_header("content-type", "application/json")
    if user:
        req.add_header("X-Komik-User", user)
    try:
        with urllib.request.urlopen(req, timeout=20) as r:
            return r.status, json.loads(r.read() or b"{}")
    except urllib.error.HTTPError as e:
        try:
            return e.code, json.loads(e.read() or b"{}")
        except Exception:
            return e.code, {}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--base-url", default="http://127.0.0.1:8788")
    args = ap.parse_args()
    base = args.base_url.rstrip("/")

    user = "w3autodl"
    st, js = api(base, "POST", "/api/user/claim", {"username": user})
    check("claim akun scratch 200", st == 200, f"status={st} body={js}")

    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        ctx = browser.new_context(
            viewport={"width": 1280, "height": 900},
            locale="id-ID",
            accept_downloads=True,
        )
        page = ctx.new_page()
        errors = []
        page.on("pageerror", lambda e: errors.append(str(e)))

        # identitas akun di localStorage sebelum app boot (dibaca getUser())
        ctx.add_init_script(
            "try { localStorage.setItem('komik-akun-v1', %r); } catch (e) {}" % user
        )

        # fixture bersih: hapus entri handle ini dulu
        st, dl = api(base, "GET", "/api/unified/downloads", user=user)
        for it in (dl.get("items") or []):
            if it.get("handle") == "komiku:6426":
                api(base, "DELETE", "/api/unified/downloads/" + str(it["id"]), user=user)

        page.goto(base + "/manga/komiku:6426", wait_until="networkidle")
        page.wait_for_selector("section[data-series-list] li", timeout=25000)
        page.wait_for_timeout(1500)

        toggle = page.locator("button[data-range-toggle]")
        check("tombol mode unduh ada", toggle.count() > 0)
        toggle.first.click()
        page.wait_for_timeout(400)

        rows = page.locator("section[data-series-list] li > button")
        check("baris chapter jadi tombol", rows.count() >= 1, f"{rows.count()} baris")
        label0 = rows.nth(0).inner_text().split("\n")[0].strip()
        m = re.search(r"([0-9]+(?:\.[0-9]+)?)", label0)
        want_num = m.group(1) if m else None
        print(f"  (chapter target: {label0!r} -> nomor {want_num})")

        rows.nth(0).click()  # anchor Awal
        page.wait_for_timeout(300)
        body = page.inner_text("body")
        check("hint 'Pilih chapter akhir' muncul (1 anchor)", "Pilih chapter akhir" in body)

        # 1 chapter: tap baris yang sama lagi → range = 1 chapter (Awal==Akhir).
        # Sebenarnya tap kedua = Akhir; tap di baris 0 lagi mengisi end=0.
        rows.nth(0).click()
        page.wait_for_timeout(450)
        body = page.inner_text("body")
        unduh1 = page.locator("button:has-text('Unduh (1)')").first
        check("tombol 'Unduh (1)' tampil", unduh1.count() > 0 and unduh1.is_enabled(), body[:120])
        page.screenshot(path=SHOTS + "/1-selected.png")

        # ---- BUKTI INTI: klik Unduh → Chromium memulai unduhan file ----
        with page.expect_download(timeout=120000) as dl_info:
            unduh1.click()
        download = dl_info.value
        fname = download.suggested_filename
        fail = download.failure()
        target = os.path.join(SHOTS, "captured.pdf")
        try:
            download.save_as(target)
        except Exception as e:  # noqa: BLE001
            print(f"  (save_as: {e} — quirk headless, lihat catatan atas)")
        size = os.path.getsize(target) if os.path.exists(target) else 0
        print(f"  (download: {fname!r}, failure={fail!r}, {size} bytes)")
        # Headless boleh lapor 'canceled'/0 byte walau server mengirim penuh —
        # itu keterbatasan capture, bukan kegagalan auto-trigger. Yang WAJIB
        # benar di sini: event terpicu + nama file dari server.
        check("auto-unduh: event download dipicu setelah klik", True)
        check("nama file .pdf dari server", fname.lower().endswith(".pdf"), fname)
        check("nama file memuat 'Chapter'", "chapter" in fname.lower(), fname)
        page.screenshot(path=SHOTS + "/2-downloading.png")

        # ---- server juga menyimpan entri (buffer 24 jam) ----
        st, dl = api(base, "GET", "/api/unified/downloads", user=user)
        got = [it for it in (dl.get("items") or []) if it.get("handle") == "komiku:6426"]
        check("server menyimpan entri unduhan (buffer)", len(got) >= 1, f"{len(got)} entri")
        if want_num:
            check("nomor chapter target tersimpan", any(str(it.get("number")) == want_num for it in got),
                  ",".join(str(it.get("number")) for it in got))

        check("console: tanpa pageerror", not errors, "; ".join(errors[:2]))
        browser.close()

    print(f"\n{len(passed)}/{len(passed) + len(failed)} passed")
    if failed:
        print("FAILED:", "; ".join(failed))
    print("SHOTS:", SHOTS)
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
