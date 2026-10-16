"""E2E Rak Buku — Playwright (headless Chromium) terhadap prod server 8788.
Alur: cari -> series -> heart (favorit) -> /rak favorit -> reader (gambar) ->
sejarah -> unduh PDF (progress) -> tab unduhan -> settings modal.
Bukti: screenshot per langkah + assertion output."""
import sys
import time
from playwright.sync_api import sync_playwright

BASE = "http://127.0.0.1:8788"
SHOTS = r"C:\Users\LENOVO LEGION\AppData\Local\Temp\rak_e2e"
import os
os.makedirs(SHOTS, exist_ok=True)

passed, failed = [], []


def check(name, cond, extra=""):
    (passed if cond else failed).append(name)
    print(f"  {'PASS' if cond else 'FAIL'}  {name}" + (f"  [{extra}]" if extra else ""))


with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    ctx = browser.new_context(viewport={"width": 1280, "height": 900},
                              locale="id-ID")
    page = ctx.new_page()
    errors = []
    page.on("pageerror", lambda e: errors.append(str(e)))

    # 1. Cari
    page.goto(BASE + "/cari", wait_until="networkidle")
    page.fill('input[type="text"], input:not([type])', "solo leveling")
    page.keyboard.press("Enter")
    page.wait_for_timeout(6000)
    cards = page.locator('a[href^="/manga/"]')
    n = cards.count()
    check("cari: hasil muncul", n > 0, f"{n} kartu")
    # ♥ di kartu hasil cari (overlay cover): klik kartu pertama
    card_hearts = page.locator('a[href^="/manga/"] button[aria-label*="favorit" i]')
    check("cari: tombol ♥ ada di kartu", card_hearts.count() > 0, f"{card_hearts.count()} tombol")
    if card_hearts.count() > 0:
        card_hearts.first.click()
        page.wait_for_timeout(600)
        ls = page.evaluate("() => localStorage.getItem('komik-rak-v1')")
        check("cari: klik ♥ kartu -> masuk favorit", ls and '"favorites"' in ls and ls.count('"title_key"') >= 1, str(ls)[:80])
    page.screenshot(path=SHOTS + "/1-search.png", full_page=False)

    # 2. Buka series pertama -> heart
    cards.first.click()
    page.wait_for_url("**/manga/**", timeout=15000)
    page.wait_for_timeout(4000)
    # heart pill = aria-label*="favorit" (toggle "Unduh" range lane A juga
    # punya aria-pressed → jangan pakai bare button[aria-pressed], nanti
    # heart.first salah tangkap tombol Unduh).
    heart = page.locator('button[aria-label*="favorit" i], button[aria-label*="love" i]')
    check("series: tombol heart ada", heart.count() > 0, f"{heart.count()} kandidat")
    labeled = page.locator('button:has-text("Favorit"), button:has-text("Difavoritkan")')
    check("series: pil Favorit berlabel ada", labeled.count() > 0, f"{labeled.count} pil".replace("{labeled.count}", str(labeled.count())))
    # state awal: sudah di-love dari kartu hasil cari -> sinkron lintas-permukaan
    aria = heart.first.get_attribute("aria-pressed")
    check("series: heart menyala (sinkron dari kartu cari)", aria == "true", f"aria-pressed={aria}")
    if aria != "true":
        heart.first.click()
        page.wait_for_timeout(600)
    # pil berlabel harus konsisten "Difavoritkan"
    body = page.inner_text("body")
    check("series: pil menunjukkan Difavoritkan", "Difavoritkan" in body, "pill label")
    page.screenshot(path=SHOTS + "/2-series-heart.png")

    # 3. /rak -> tab Favorit
    page.goto(BASE + "/rak", wait_until="networkidle")
    page.wait_for_timeout(1500)
    fav_tab = page.locator('button:text-is("Favorit")')
    if fav_tab.count() == 0:
        # mungkin tab default sudah Favorit atau pakai teks lain
        body = page.inner_text("body")
        check("rak: halaman termuat", "Rak" in body or "Favorit" in body or "Sejarah" in body, body[:80])
    else:
        fav_tab.first.click()
        page.wait_for_timeout(1000)
    body = page.inner_text("body")
    fav_link = page.locator('a[href^="/manga/"]')
    check("rak favorit: kartu series muncul", fav_link.count() > 0, f"{fav_link.count()} kartu, body: {body[:100]}")
    page.screenshot(path=SHOTS + "/3-rak-favorit.png")

    # 4. Reader: buka chapter pertama dari series (kartu favorit)
    page.goto(BASE + "/rak", wait_until="networkidle")
    page.locator('button:text-is("Favorit")').first.click()
    page.wait_for_timeout(800)
    fav_link = page.locator('a[href^="/manga/"]').first
    fav_link.click()
    page.wait_for_url("**/manga/**", timeout=15000)
    page.wait_for_timeout(3000)
    chapter_link = page.locator('a[href*="/baca/"]').first
    check("series: tautan chapter ada", chapter_link.count() > 0)
    chapter_link.click()
    page.wait_for_url("**/baca/**", timeout=20000)
    page.wait_for_timeout(6000)
    imgs = page.locator("main img, .manga-img, img[src*='/img']")
    loaded = 0
    for i in range(min(imgs.count(), 20)):
        try:
            if imgs.nth(i).evaluate("el => el.complete && el.naturalWidth > 0"):
                loaded += 1
        except Exception:
            pass
    check("reader: gambar termuat", loaded >= 3, f"{loaded} gambar")
    page.screenshot(path=SHOTS + "/4-reader.png")

    # 5. Sejarah
    page.goto(BASE + "/rak", wait_until="networkidle")
    page.wait_for_timeout(1200)
    his_tab = page.locator('button:text-is("Sejarah")')
    if his_tab.count() > 0:
        his_tab.first.click()
        page.wait_for_timeout(1000)
    body = page.inner_text("body")
    check("rak sejarah: series yang dibaca muncul", "One Piece" in body or "Leveling" in body or "Apocalypse" in body, body[:120])
    page.screenshot(path=SHOTS + "/5-rak-sejarah.png")

    # 6. Unduhan: dari halaman series UNIFIED, mode range 2-tap (Awal/Akhir) -> Unduh
    page.goto(BASE + "/manga/komiku:6426", wait_until="networkidle")
    page.wait_for_selector('section[data-series-list] li', timeout=20000)
    page.wait_for_timeout(2500)
    toggle = page.locator('button[data-range-toggle]')
    check("series: tombol Unduh (toggle range) ada", toggle.count() > 0)
    if toggle.count() > 0:
        toggle.first.click()
        page.wait_for_timeout(400)
        prows = page.locator('section[data-series-list] li > button')
        check("series: baris jadi tombol saat mode pilih", prows.count() >= 3, f"{prows.count()} baris")
        if prows.count() >= 3:
            prows.nth(0).click()   # anchor Awal (baris 1)
            page.wait_for_timeout(250)
            prows.nth(2).click()   # anchor Akhir (baris 3) -> 3 chapter terpilih
            page.wait_for_timeout(400)
            body_sel = page.inner_text("body")
            check("unduh: info '3 dipilih' + 'Unduh (3)'",
                  "3 dipilih" in body_sel and "Unduh (3)" in body_sel, body_sel[:100])
            page.locator("button:has-text('Unduh (3)')").first.click()
            # tunggu progress selesai (generate PDF per chapter berat)
            # UI: baris "mengunduh…" saat proses, pesan "Unduhan selesai" saat kelar
            ok = False
            for _ in range(90):
                page.wait_for_timeout(1000)
                try:
                    body = page.inner_text("body")
                    if "Unduhan selesai" in body:
                        ok = True
                        break
                except Exception:
                    pass
            check("unduh: progress/selesai terlihat (Unduhan selesai)", ok)
    page.goto(BASE + "/rak", wait_until="networkidle")
    page.wait_for_timeout(1200)
    und_tab = page.locator('button:text-is("Unduhan")')
    if und_tab.count() > 0:
        und_tab.first.click()
        page.wait_for_timeout(1500)
    body = page.inner_text("body")
    check("rak unduhan: entri PDF muncul dgn ukuran", ("One Piece" in body) and ("MB" in body or "KB" in body), body[:150])
    page.screenshot(path=SHOTS + "/6-rak-unduhan.png")

    # 7. Settings modal
    gear = page.locator('button[aria-label="Pengaturan unduhan"]')
    if gear.count() > 0:
        gear.first.click()
        page.wait_for_timeout(800)
    body = page.inner_text("body")
    check("rak settings: modal limit terbuka", "GB" in body or "Limit" in body or "limit" in body, body[:120])
    page.screenshot(path=SHOTS + "/7-settings.png")

    check("console: tanpa pageerror", len(errors) == 0, "; ".join(errors[:2]))
    browser.close()

print(f"\n{len(passed)}/{len(passed)+len(failed)} passed")
print("SHOTS:", SHOTS)
sys.exit(1 if failed else 0)
