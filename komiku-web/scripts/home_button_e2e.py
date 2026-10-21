"""E2E tombol "Beranda" (ikon rumah) di toolbar reader.

Konteks: fitur ini pernah dibuat di sesi 20 Okt 00:23 tapi PERNAH HILANG
dari working tree (belum pernah di-commit). Test ini mengunci perilakunya
supaya tidak hilang diam-diam lagi.

Yang dibuktikan:
  1. Toolbar reader punya tombol aria-label="Beranda".
  2. Tombol itu persis di sebelah kanan tombol "Kembali".
  3. Klik → navigasi ke beranda ("/").
  4. Mode maraton juga punya tombolnya.
  5. Halaman beranda benar-benar me-render (bukan 404/blank).
"""
import os
import sys
import time

from playwright.sync_api import sync_playwright

BASE = "http://127.0.0.1:8788"
SHOTS = r"C:\Users\LENOVO LEGION\AppData\Local\Temp\home_button_e2e"
os.makedirs(SHOTS, exist_ok=True)

MID = "/baca/komiku:1284/121"
MARATON = "/maraton/komiku:1284/121"

passed, failed = [], []


def check(name, cond, extra=""):
    (passed if cond else failed).append(name)
    print(f"  {'PASS' if cond else 'FAIL'}  {name}" + (f"  [{extra}]" if extra else ""))


def wait_ready(page, sel="img[data-page]"):
    deadline = time.time() + 45
    while time.time() < deadline:
        ok = page.evaluate(
            "() => !!document.querySelector('[data-reader-chrome=toolbar]')"
            f" && document.querySelectorAll('{sel}').length > 0"
        )
        if ok:
            return True
        page.wait_for_timeout(300)
    return False


with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    ctx = browser.new_context(viewport={"width": 390, "height": 844}, locale="id-ID")
    ctx.route("**/sw.js", lambda r: r.fulfill(status=404, body="sw blocked by e2e"))
    page = ctx.new_page()
    errors = []
    page.on("pageerror", lambda e: errors.append(str(e)))

    # ---------- 1. reader biasa ----------
    page.goto(BASE + MID, wait_until="domcontentloaded")
    check("reader: termuat + gambar ter-render", wait_ready(page))

    back = page.locator('[data-reader-chrome=toolbar] button[aria-label="Kembali"]')
    home = page.locator('[data-reader-chrome=toolbar] button[aria-label="Beranda"]')
    check("reader: tombol 'Kembali' ada", back.count() == 1, f"{back.count()}")
    check("reader: tombol 'Beranda' ADA", home.count() == 1, f"{home.count()}")

    if home.count() == 1 and back.count() == 1:
        hb = home.first.bounding_box() or {}
        bb = back.first.bounding_box() or {}
        check(
            "reader: 'Beranda' di sebelah kanan 'Kembali'",
            hb.get("x", 0) > bb.get("x", 0) and abs(hb.get("y", 0) - bb.get("y", 0)) < 4,
            f"kembali.x={bb.get('x'):.0f} beranda.x={hb.get('x'):.0f}",
        )
        page.screenshot(path=SHOTS + "/1-reader-toolbar.png")

        # ---------- 2. klik → beranda ----------
        home.first.click()
        deadline = time.time() + 20
        ok = False
        while time.time() < deadline:
            if page.url.rstrip("/").endswith("127.0.0.1:8788"):
                ok = True
                break
            page.wait_for_timeout(250)
        check("reader: klik 'Beranda' → navigasi ke beranda", ok, page.url)

        # beranda me-render? (bukan blank/404)
        deadline = time.time() + 30
        rendered = False
        while time.time() < deadline:
            n = page.evaluate(
                "() => document.querySelectorAll('a[href^=\"/manga/\"], a[href^=\"/baca/\"]').length"
            )
            if n > 0:
                rendered = True
                break
            page.wait_for_timeout(300)
        n_links = page.evaluate(
            "() => document.querySelectorAll('a[href^=\"/manga/\"], a[href^=\"/baca/\"]').length"
        )
        check("reader: beranda me-render (kartu komik ada)", rendered, f"{n_links} link")
        check("reader: judul dokumen = Komik Hub", "Komik Hub" in page.title(), page.title())
        page.screenshot(path=SHOTS + "/2-beranda.png")

    # ---------- 3. mode maraton ----------
    page.goto(BASE + MARATON, wait_until="domcontentloaded")
    check("maraton: termuat", wait_ready(page, "img[data-b]"))
    m_home = page.locator('[data-reader-chrome=toolbar] button[aria-label="Beranda"]')
    check("maraton: tombol 'Beranda' ada", m_home.count() == 1, f"{m_home.count()}")
    if m_home.count() == 1:
        m_home.first.click()
        deadline = time.time() + 20
        ok = False
        while time.time() < deadline:
            if page.url.rstrip("/").endswith("127.0.0.1:8788"):
                ok = True
                break
            page.wait_for_timeout(250)
        check("maraton: klik 'Beranda' → beranda", ok, page.url)

    check("console: tanpa pageerror", not errors, "; ".join(errors[:3]))
    ctx.close()
    browser.close()

print(f"\n{len(passed)}/{len(passed) + len(failed)} passed")
print("SHOTS:", SHOTS)
sys.exit(1 if failed else 0)
