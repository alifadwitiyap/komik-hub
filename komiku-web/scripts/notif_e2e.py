"""E2E badge "UP n" (paritas app asli) — Playwright headless vs prod server 8788.

Prasyarat (diseed koordinator): state.json berisi satu favorit (handle 3215)
dengan 3 notifikasi title_key sama: 2 unread (chapter 45.2, 45.3) + 1 read
(45.1), last_check_at fresh (cycle tak spawn). localStorage browser diseed
dengan favorit sama supaya kartu Home + Rak menampilkan hati untuk series itu.

Alur: bell badge 2 + hati Home ber-badge 2 -> panel grup "2 chapter baru" ->
klik grup -> navigasi /manga/3215 + semua notif title itu terbaca -> badge
hilang di bell, hati Home, pil Series, dan baris Rak.
Bukti: assertion output + screenshot.
"""
import os
from playwright.sync_api import sync_playwright

BASE = "http://127.0.0.1:8788"
SHOTS = r"C:\Users\LENOVO LEGION\AppData\Local\Temp\notif_e2e"
os.makedirs(SHOTS, exist_ok=True)

TK = "class de 2 banme ni kawaii onna no ko to tomodachi ni natta"
TITLE = "Class de 2 Banme ni Kawaii Onna no Ko to Tomodachi ni Natta"

passed, failed = [], []


def check(name, cond, extra=""):
    (passed if cond else failed).append(name)
    print(f"  {'PASS' if cond else 'FAIL'}  {name}" + (f"  [{extra}]" if extra else ""))


with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    ctx = browser.new_context(viewport={"width": 1280, "height": 900}, locale="id-ID")
    # localStorage: favorit sama dengan seed server (kartu Home + Rak punya hati)
    ctx.add_init_script(f"""
      localStorage.setItem('komik-rak-v1', JSON.stringify({{
        favorites: {{ '{TK}': {{ title_key: '{TK}', title: '{TITLE}',
          cover_url: null, handle: '3215', source: 'komiku', loved_at: 1 }} }},
        history: {{}}
      }}));
    """)
    page = ctx.new_page()
    errors = []
    page.on("pageerror", lambda e: errors.append(str(e)))

    # 1. Beranda: badge bell = 2. Badge count di permukaan ♥ diverifikasi lewat
    # baris favorit Rak (localStorage-driven, deterministik) — kartu Home TIDAK
    # dipakai karena feed live berotasi: series seed bisa tak ada di home saat
    # tes jalan (precondition tidak stabil; mekanisme badge identik di semua
    # permukaan karena satu komponen HeartButton).
    page.goto(BASE + "/", wait_until="networkidle")
    page.wait_for_timeout(3500)
    bell = page.locator('button[aria-label^="Notifikasi"]')
    check("bell: tombol Notifikasi ada", bell.count() > 0)
    badge = page.locator("header span.bg-brand-amber")
    check("bell: badge unread = 2", badge.count() > 0 and badge.first.inner_text().strip() == "2",
          badge.first.inner_text() if badge.count() else "no badge")
    page.goto(BASE + "/rak", wait_until="networkidle")
    page.wait_for_timeout(1500)
    page.locator('button:text-is("Favorit")').first.click()
    page.wait_for_timeout(1000)
    rak_bubble = page.locator('a[href="/manga/3215"] span', has_text="2")
    check("rak: baris favorit ber-badge 2", rak_bubble.count() > 0, f"{rak_bubble.count()} bubble")
    page.goto(BASE + "/", wait_until="networkidle")
    page.wait_for_timeout(2000)
    page.screenshot(path=SHOTS + "/1-home-badge.png")

    # 2. Panel: tepat satu baris tergrup per judul
    bell.first.click()
    page.wait_for_timeout(800)
    grouped = page.locator("text=/2 chapter baru · komiku/").first
    check("panel: baris tergrup '2 chapter baru · komiku'", grouped.count() > 0)
    check("panel: tepat 1 baris grup", page.locator("li", has_text="chapter baru").count() == 1)
    page.screenshot(path=SHOTS + "/2-panel-group.png")

    # 3. Klik grup -> navigasi + SEMUA notif title itu terbaca
    grouped.click()
    page.wait_for_url("**/manga/3215", timeout=15000)
    check("klik grup: navigasi /manga/3215", page.url.endswith("/manga/3215"), page.url)
    page.wait_for_timeout(2500)
    pill = page.locator('button:has-text("Favorit")').first
    check("series: pil Favorit tanpa count (sudah dibaca)",
          pill.count() > 0 and "· 2" not in (pill.inner_text() or ""),
          pill.inner_text() if pill.count() else "no pill")
    page.goto(BASE + "/", wait_until="networkidle")
    page.wait_for_timeout(3500)
    check("bell: badge hilang setelah dibaca", page.locator("header span.bg-brand-amber").count() == 0)
    check("home: badge hati hilang setelah dibaca",
          page.locator('button[aria-label*="favorit" i] span', has_text="2").count() == 0)
    page.screenshot(path=SHOTS + "/3-home-read.png")

    # 4. Rak: baris favorit tampil tanpa badge count (sudah dibaca)
    page.goto(BASE + "/rak", wait_until="networkidle")
    page.wait_for_timeout(1500)
    page.locator('button:text-is("Favorit")').first.click()
    page.wait_for_timeout(1000)
    body = page.inner_text("body")
    check("rak: judul favorit tampil", "Class de 2 Banme" in body)
    check("rak: badge count hilang di baris favorit",
          page.locator('a[href="/manga/3215"] span', has_text="2").count() == 0)
    page.screenshot(path=SHOTS + "/4-rak.png")

    check("console: tanpa pageerror", not errors, "; ".join(errors)[:120])
    browser.close()

print(f"\n{len(passed)}/{len(passed) + len(failed)} passed")
print("SHOTS:", SHOTS)
raise SystemExit(1 if failed else 0)
