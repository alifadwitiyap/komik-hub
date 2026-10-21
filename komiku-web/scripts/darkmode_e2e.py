"""E2E mode gelap: tombol bulan/matahari di menu atas.

Kontrak (keputusan grilling):
  1. Tombol di TopBar (data-theme-toggle) — bulan saat terang, matahari saat gelap.
  2. Klik -> class `dark` di <html>, token ink-* terpetakan ulang, seluruh
     surface app ikut gelap (bukan cuma tombol).
  3. Pilihan disimpan di localStorage `komik-theme` dan dipakai lagi setelah
     reload (tanpa kedip: class dipasang sebelum render).
  4. Setelah user memilih, perubahan prefers-color-scheme TIDAK diikuti.
  5. Transisi 200ms (class transition pada ikon).
"""
import os
import sys
import time

from playwright.sync_api import sync_playwright

BASE = "http://127.0.0.1:8788"
SHOTS = r"C:\Users\LENOVO LEGION\AppData\Local\Temp\darkmode_e2e"
os.makedirs(SHOTS, exist_ok=True)

TOGGLE = "[data-theme-toggle]"
passed, failed = [], []


def check(name, cond, extra=""):
    (passed if cond else failed).append(name)
    print(f"  {'PASS' if cond else 'FAIL'}  {name}" + (f"  [{extra}]" if extra else ""))


def is_dark(page) -> bool:
    return page.evaluate("() => document.documentElement.classList.contains('dark')")


def bg(page, sel: str) -> str:
    """warna latar efektif sebuah elemen."""
    return page.evaluate(
        f"() => getComputedStyle(document.querySelector('{sel}') || document.body)"
        f".backgroundColor"
    )


def visible_icon(page) -> str:
    """ikon mana yang kelihatan (opacity > 0.5) di dalam tombol."""
    return page.evaluate(
        f"""() => {{
        const wrap = document.querySelector('{TOGGLE}');
        if (!wrap) return 'no-toggle';
        const svgs = [...wrap.querySelectorAll('svg')];
        const on = svgs.filter(s => Number(getComputedStyle(s).opacity) > 0.5);
        // svg pertama = bulan, kedua = matahari (urutan tetap dari ThemeToggle)
        if (on.length !== 1) return 'ambiguous:' + on.length;
        return svgs.indexOf(on[0]) === 0 ? 'moon' : 'sun';
      }}"""
    )


with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)

    def dismiss_promo(ctx):
        # LoginPromoModal menutupi tombol tema di kunjungan pertama; tandai
        # sudah-dismiss (localStorage diisi timestamp) supaya overlay tidak
        # mencegat klik tema. Sesuai kontrak LoginPromoModal.
        ctx.add_init_script(
            "try{localStorage.setItem('komik.login-promo.dismissed.v1', String(Date.now()))}catch(e){}"
        )

    # ---------- 1. Default terang + tombol tampil ----------
    ctx = browser.new_context(viewport={"width": 1280, "height": 900}, locale="id-ID")
    ctx.route("**/sw.js", lambda r: r.fulfill(status=404, body="blocked"))
    dismiss_promo(ctx)
    page = ctx.new_page()
    errors = []
    page.on("pageerror", lambda e: errors.append(str(e)))

    page.goto(BASE + "/cari", wait_until="domcontentloaded")
    page.wait_for_timeout(2500)

    check("tombol tema ada di menu atas", page.locator(TOGGLE).count() == 1)
    check("default: TERANG (tidak ada class dark)", not is_dark(page))
    check("default: ikon bulan tampil", visible_icon(page) == "moon", visible_icon(page))
    check("default: label tombol 'Mode gelap'",
          (page.locator(TOGGLE).first.get_attribute("aria-label") or "") == "Mode gelap")

    light_bg = bg(page, "body")
    light_bar = bg(page, "header")
    print(f"   (bg terang: body={light_bg} header={light_bar})")

    light_text = page.evaluate(
        "() => getComputedStyle(document.querySelector('[data-search-count]')"
        " || document.body).color"
    )

    # ---------- 2. Klik -> gelap ----------
    page.locator(TOGGLE).first.click()
    page.wait_for_timeout(400)
    check("klik: class dark muncul", is_dark(page))
    check("klik: ikon jadi matahari", visible_icon(page) == "sun", visible_icon(page))
    check("klik: label tombol jadi 'Mode terang'",
          (page.locator(TOGGLE).first.get_attribute("aria-label") or "") == "Mode terang")

    dark_bg = bg(page, "body")
    dark_bar = bg(page, "header")
    check("klik: latar body berubah jadi gelap", dark_bg != light_bg, f"{light_bg} -> {dark_bg}")
    check("klik: app bar ikut gelap", dark_bar != light_bar, f"{light_bar} -> {dark_bar}")
    # teks ikut berubah (bukan cuma latar): bandingkan sebelum/sesudah
    text_dark = page.evaluate(
        "() => getComputedStyle(document.querySelector('[data-search-count]')"
        " || document.body).color"
    )
    check("klik: teks hasil ikut menyesuaikan (gelap -> terang)",
          text_dark != light_text, f"{light_text} -> {text_dark}")

    stored = page.evaluate("() => localStorage.getItem('komik-theme')")
    check("klik: pilihan disimpan di localStorage", stored == "dark", str(stored))
    page.screenshot(path=SHOTS + "/1-dark.png")

    # ---------- 3. Klik lagi -> terang ----------
    page.locator(TOGGLE).first.click()
    page.wait_for_timeout(400)
    check("klik lagi: class dark hilang", not is_dark(page))
    check("klik lagi: ikon bulan kembali", visible_icon(page) == "moon", visible_icon(page))
    check("klik lagi: latar balik terang", bg(page, "body") == light_bg)
    check("klik lagi: localStorage 'light'",
          page.evaluate("() => localStorage.getItem('komik-theme')") == "light")

    # ---------- 4. Bertahan setelah reload ----------
    page.locator(TOGGLE).first.click()   # nyalakan gelap
    page.wait_for_timeout(300)
    page.reload(wait_until="domcontentloaded")
    # class harus sudah ada SEBELUM React render (bootstrap di main.tsx)
    check("reload: tetap gelap (tanpa kedip)", is_dark(page))
    page.wait_for_timeout(1500)
    check("reload: masih gelap setelah render", is_dark(page))
    check("reload: ikon matahari", visible_icon(page) == "sun", visible_icon(page))
    check("reload: localStorage tetap 'dark'",
          page.evaluate("() => localStorage.getItem('komik-theme')") == "dark")
    page.screenshot(path=SHOTS + "/2-dark-after-reload.png")

    # ---------- 5. Tema OS tidak diikuti setelah pilihan ----------
    page.evaluate("() => localStorage.setItem('komik-theme', 'dark')")
    page.emulate_media(color_scheme="light")
    page.reload(wait_until="domcontentloaded")
    page.wait_for_timeout(1200)
    check("OS terang tapi pilihan user gelap -> tetap gelap", is_dark(page))

    ctx.close()

    # ---------- 6. OS gelap jadi nilai awal (belum pernah memilih) ----------
    ctx2 = browser.new_context(viewport={"width": 1280, "height": 900}, locale="id-ID")
    ctx2.route("**/sw.js", lambda r: r.fulfill(status=404, body="blocked"))
    dismiss_promo(ctx2)
    page2 = ctx2.new_page()
    page2.emulate_media(color_scheme="dark")
    page2.goto(BASE + "/cari", wait_until="domcontentloaded")
    page2.wait_for_timeout(1500)
    check("OS gelap jadi nilai awal (belum pernah memilih) -> ikut gelap", is_dark(page2))
    check("OS gelap: ikon matahari", visible_icon(page2) == "sun", visible_icon(page2))
    page2.screenshot(path=SHOTS + "/3-os-dark-first-visit.png")
    ctx2.close()

    check("console: tanpa pageerror", not errors, "; ".join(errors[:3]))
    browser.close()

print(f"\n{len(passed)}/{len(passed) + len(failed)} passed")
print("SHOTS:", SHOTS)
sys.exit(1 if failed else 0)
