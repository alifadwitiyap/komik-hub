"""E2E reader UX: chrome auto-hide saat scroll + tombol mundur chapter.

Kontrak (hasil grilling Q1-Q7):
  1. Scroll TURUN  → toolbar (`[data-reader-chrome=toolbar]`) dan footer
     (`[data-reader-chrome=footer]`) tersembunyi (translate keluar layar).
  2. Scroll NAIK   → keduanya tampil kembali.
  3. Tap tengah    → toggle manual (override), tidak dihapus.
  4. Footer punya DUA tombol navigasi berdampingan:
     "Sebelumnya" (link ke chapter prev) + "Berikutnya" (link ke chapter next).
  5. Chapter pertama (prev null) → hanya tombol Berikutnya, lebar penuh.
     Chapter terbaru (next null) → "Chapter terbaru" + tombol Sebelumnya.
  6. Maraton: chrome ikut aturan yang sama; tombol Sebelumnya = chapter head,
     Berikutnya = chapter tail.
  7. Chrome TAMPIL saat chapter baru dibuka (tidak warisi keadaan tersembunyi).

Data uji = konten LIVE (komiku:1284 Reincarnator, chapter 121 punya prev+next).
Anchor ke permukaan navigasi, bukan feed berotasi (aturan stack).
"""
import json
import os
import re
import sys
import time
import urllib.error
import urllib.request

from playwright.sync_api import sync_playwright
# --- MODAL AUTO-CLOSE (login promo overlay) -----------------------------
def close_login_modal(page):
    try:
        page.get_by_role("button", name="Nanti saja").click(timeout=1500)
    except Exception:
        pass  # Modal absent



BASE = "http://127.0.0.1:8788"
SHOTS = r"C:\Users\LENOVO LEGION\AppData\Local\Temp\reader_ux_e2e"
os.makedirs(SHOTS, exist_ok=True)

# Chapter bertitik DULU menyebabkan 404 dari SPA fallback server (segmen
# mengandung '.' dianggap aset). Ini menguji perbaikan itu.
DOTTED = "/baca/komiku:1284/00.1"

# Reincarnator (komiku:1284): ch 121 punya prev (120) dan next (122) —
# terverifikasi live via /api/unified/chapter/komiku:1284/121.
MID = "/baca/komiku:1284/121"
# chapter BENAR-BENAR pertama — diambil dari API, bukan nomor hardcode:
# sumber menerbitkan chapter baru (dan beberapa chapter cuma ada di
# sumber lain lewat fallback lintas-sumber), jadi nomor "terendah" BERUBAH
# seiring waktu. `00.1` dulu yang pertama; sekarang ada chapter `0`.
FIRST = None  # diisi oleh first_chapter_url()


def first_chapter_url() -> str:
    """Chapter pertama series — dibaca dari API, bukan di-hardcode."""
    global FIRST
    if FIRST:
        return FIRST
    d = json.load(urllib.request.urlopen(BASE + "/api/unified/series/komiku:1284", timeout=60))
    chs = d.get("chapters") or []
    if not chs:
        raise RuntimeError("series seed tanpa chapter — ubah series seed E2E")

    def num(c):
        try:
            return float(str(c.get("number")))
        except (TypeError, ValueError):
            return float("inf")

    lowest = min(chs, key=num)
    FIRST = f"/baca/komiku:1284/{lowest.get('number')}"
    return FIRST
LATEST = None  # diisi dari API: chapter terbaru bisa berubah (sumber terbit baru)


def latest_chapter_url() -> str:
    """Chapter terbaru series seed — DICARI dari API, bukan di-hardcode.

    Sumber menerbitkan chapter baru kapan saja: nomor yang di-hardcode jadi
    bukan-terbaru, tombolnya rapi, dan assertion "Chapter terbaru" gagal palsu.
    """
    global LATEST
    if LATEST:
        return LATEST
    d = json.load(urllib.request.urlopen(BASE + "/api/unified/series/komiku:1284", timeout=60))
    chs = d.get("chapters") or []
    if not chs:
        raise RuntimeError("series seed tanpa chapter — ubah series seed E2E")
    num = str(chs[0].get("number"))
    LATEST = f"/baca/komiku:1284/{num}"
    return LATEST
MARATON = "/maraton/komiku:1284/121"

passed, failed = [], []


def check(name, cond, extra=""):
    (passed if cond else failed).append(name)
    print(f"  {'PASS' if cond else 'FAIL'}  {name}" + (f"  [{extra}]" if extra else ""))


def chrome_state(page):
    """(toolbarVisible, footerVisible) menurut geometri viewport asli."""
    return page.evaluate(
        """() => {
        const vh = window.innerHeight;
        const t = document.querySelector('[data-reader-chrome=toolbar]');
        const f = document.querySelector('[data-reader-chrome=footer]');
        const onScreen = (el) => {
          if (!el) return null;
          const r = el.getBoundingClientRect();
          return r.bottom > 1 && r.top < vh - 1;
        };
        return { toolbar: onScreen(t), footer: onScreen(f) };
      }"""
    )


def wait_ready(page, marathon=False):
    """Tunggu chrome ada + gambar ter-render + halaman BENAR-BENAR bisa di-scroll.

    Pemeriksaan terakhir penting: kalau konten belum setinggi viewport,
    `mouse.wheel` tidak menghasilkan scroll event sama sekali dan semua
    assertion berbasis arah scroll jadi omong kosong (chrome tetap "tampil"
    karena tak pernah ada yang memicunya).
    """
    img_sel = "img[data-b]" if marathon else "img[data-page]"
    deadline = time.time() + 40
    while time.time() < deadline:
        ok = page.evaluate(
            f"() => !!document.querySelector('[data-reader-chrome=toolbar]')"
            f" && document.querySelectorAll('{img_sel}').length > 0"
            f" && document.body.scrollHeight > window.innerHeight + 200"
        )
        if ok:
            return True
        page.wait_for_timeout(250)
    return False


def scroll_by(page, dy, steps=4):
    """Scroll bertahap (event scroll asli per langkah, melewati threshold 40px)."""
    for _ in range(steps):
        page.mouse.wheel(0, dy)
        page.wait_for_timeout(120)
    page.wait_for_timeout(450)  # beri waktu transition 200ms + render


def open_page(browser, path, marathon=False):
    ctx = browser.new_context(viewport={"width": 1280, "height": 900}, locale="id-ID")
    ctx.route("**/sw.js", lambda r: r.fulfill(status=404, body="sw blocked by e2e"))
    page = ctx.new_page()
    errors = []
    page.on("pageerror", lambda e: errors.append(str(e)))
    page.goto(BASE + path, wait_until="domcontentloaded")
    # Close login promo if present; noop otherwise
    close_login_modal(page)
    ok = wait_ready(page, marathon=marathon)
    return ctx, page, errors, ok


with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)

    # ================= 0. Deep-link chapter bertitik (regresi SPA fallback) ==
    import urllib.request

    for path in (DOTTED, "/baca/komiku:1284/1.5", "/maraton/komiku:1284/1.5"):
        try:
            code = urllib.request.urlopen(BASE + path, timeout=20).getcode()
        except urllib.error.HTTPError as e:
            code = e.code
        check(f"deep-link: {path} balas 200 (bukan 404 aset)", code == 200, f"HTTP {code}")

    # ================= 1. Reader biasa: auto-hide chrome =================
    ctx, page, errors, ready = open_page(browser, MID)
    check("setup: reader termuat + gambar ter-render", ready)

    if ready:
        st = chrome_state(page)
        check("awal: toolbar & footer TAMPIL", st["toolbar"] and st["footer"], str(st))

        scroll_by(page, 600)
        st = chrome_state(page)
        check("scroll TURUN: toolbar sembunyi", st["toolbar"] is False, str(st))
        check("scroll TURUN: footer sembunyi", st["footer"] is False, str(st))
        page.screenshot(path=SHOTS + "/1-scroll-down-hidden.png")

        scroll_by(page, -400)
        st = chrome_state(page)
        check("scroll NAIK: toolbar tampil lagi", st["toolbar"] is True, str(st))
        check("scroll NAIK: footer tampil lagi", st["footer"] is True, str(st))
        page.screenshot(path=SHOTS + "/2-scroll-up-shown.png")

        # tap tengah = toggle manual (override)
        page.mouse.click(640, 450)
        page.wait_for_timeout(350)
        st = chrome_state(page)
        check("tap tengah: sembunyikan (manual)", st["toolbar"] is False and st["footer"] is False, str(st))
        page.mouse.click(640, 450)
        page.wait_for_timeout(350)
        st = chrome_state(page)
        check("tap tengah lagi: tampilkan (manual)", st["toolbar"] is True and st["footer"] is True, str(st))

        # ================= 2. Tombol navigasi chapter =================
        prev_link = page.locator('[data-reader-chrome=footer] a[aria-label^="Chapter Sebelumnya"]')
        next_link = page.locator('[data-reader-chrome=footer] a[aria-label^="Baca Chapter Berikutnya"]')
        check("navigasi: tombol 'Sebelumnya' ada (ch 121 punya prev)", prev_link.count() == 1,
              f"{prev_link.count()} tombol")
        check("navigasi: tombol 'Berikutnya' ada", next_link.count() == 1, f"{next_link.count()} tombol")
        if prev_link.count() == 1:
            href = prev_link.first.get_attribute("href") or ""
            check("navigasi: 'Sebelumnya' menuju ch 120", href == "/baca/komiku:1284/120", href)
        if next_link.count() == 1:
            href = next_link.first.get_attribute("href") or ""
            check("navigasi: 'Berikutnya' menuju ch 122", href == "/baca/komiku:1284/122", href)

        # KEDUA tombol berdampingan (grid 2 kolom) — cek geometri: prev di kiri
        if prev_link.count() == 1 and next_link.count() == 1:
            pb = prev_link.first.bounding_box() or {}
            nb = next_link.first.bounding_box() or {}
            check("navigasi: tombol berdampingan (prev di kiri next)",
                  pb.get("x", 0) < nb.get("x", 0) and abs(pb.get("y", 0) - nb.get("y", 0)) < 4,
                  f"prev.x={pb.get('x'):.0f} next.x={nb.get('x'):.0f}")

        # Klik 'Sebelumnya' → navigasi ke chapter 120 (URL berubah).
        # Pastikan chrome TAMPIL dulu (tombol fixed; kalau sedang tersembunyi
        # bounding box-nya di luar viewport dan Playwright hanya retry).
        page.evaluate("() => window.scrollTo(0, 0)")
        page.wait_for_timeout(500)
        st = chrome_state(page)
        check("navigasi: chrome tampil sebelum klik Sebelumnya", st["footer"] is True, str(st))
        if prev_link.count() == 1:
            prev_link.first.click()
            deadline = time.time() + 20
            ok = False
            while time.time() < deadline:
                if "/baca/komiku:1284/120" in page.url:
                    ok = True
                    break
                page.wait_for_timeout(250)
            check("navigasi: klik 'Sebelumnya' → /baca/komiku:1284/120", ok, page.url)
            # tunggu chapter baru selesai render (chrome + gambar), bukan sleep
            check("chapter baru: termuat ulang", wait_ready(page), page.url)
            st = chrome_state(page)
            check("chapter baru: chrome TAMPIL (tidak warisi sembunyi)", st["toolbar"] is True, str(st))
    ctx.close()

    # ================= 3. Tepi: chapter pertama & terbaru =================
    ctx, page, errors2, ready = open_page(browser, first_chapter_url())
    check("tepi: chapter pertama termuat", ready)
    if ready:
        prev_link = page.locator('[data-reader-chrome=footer] a[aria-label^="Chapter Sebelumnya"]')
        next_link = page.locator('[data-reader-chrome=footer] a[aria-label^="Baca Chapter Berikutnya"]')
        check("tepi: ch pertama → TIDAK ada tombol Sebelumnya", prev_link.count() == 0,
              f"{prev_link.count()} tombol")
        check("tepi: ch pertama → tombol Berikutnya ada (lebar penuh)", next_link.count() == 1)
        if next_link.count() == 1:
            nb = next_link.first.bounding_box() or {}
            # lebar penuh ≈ lebar container (viewport 1280, max-w-3xl=768, minus mx-4)
            check("tepi: tombol tunggal melebar penuh", nb.get("width", 0) > 600,
                  f"width={nb.get('width', 0):.0f}")
        page.screenshot(path=SHOTS + "/3-first-chapter.png")
    ctx.close()

    ctx, page, errors3, ready = open_page(browser, latest_chapter_url())
    check("tepi: chapter terbaru termuat", ready)
    if ready:
        prev_link = page.locator('[data-reader-chrome=footer] a[aria-label^="Chapter Sebelumnya"]')
        check("tepi: ch terbaru → tombol Sebelumnya ada", prev_link.count() == 1)
        latest_note = page.locator('[data-reader-chrome=footer] p', has_text="Chapter terbaru")
        check("tepi: ch terbaru → teks 'Chapter terbaru' tetap ada", latest_note.count() == 1)
        page.screenshot(path=SHOTS + "/4-latest-chapter.png")
    ctx.close()

    # ================= 4. Maraton: aturan chrome sama =================
    ctx, page, errors4, ready = open_page(browser, MARATON, marathon=True)
    check("maraton: channel termuat", ready)
    if ready:
        st = chrome_state(page)
        check("maraton: awal chrome tampil", st["toolbar"] and st["footer"], str(st))
        scroll_by(page, 700)
        st = chrome_state(page)
        check("maraton: scroll turun → chrome sembunyi",
              st["toolbar"] is False and st["footer"] is False, str(st))
        scroll_by(page, -500)
        st = chrome_state(page)
        check("maraton: scroll naik → chrome tampil", st["toolbar"] is True, str(st))

        prev_link = page.locator('[data-reader-chrome=footer] a[aria-label^="Chapter Sebelumnya"]')
        check("maraton: tombol Sebelumnya ada (head ch 121 punya prev 120)",
              prev_link.count() == 1)
        if prev_link.count() == 1:
            href = prev_link.first.get_attribute("href") or ""
            check("maraton: Sebelumnya menuju /maraton/komiku:1284/120",
                  href == "/maraton/komiku:1284/120", href)
        page.screenshot(path=SHOTS + "/5-marathon.png")

    all_errors = errors + errors2 + errors3 + errors4
    check("console: tanpa pageerror di semua halaman", not all_errors,
          "; ".join(all_errors[:3]))
    ctx.close()
    browser.close()

print(f"\n{len(passed)}/{len(passed) + len(failed)} passed")
print("SHOTS:", SHOTS)
sys.exit(1 if failed else 0)
