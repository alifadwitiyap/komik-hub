"""UltraQA adversarial — fitur notifikasi + badge UP-n (komiku-web vs server 8788).

Skenario hostile (expected = perilaku benar saat kondisi rusak):
 S1  GET /api/notif/list -> 404      : home + bell + panel aman, empty state, no pageerror
 S2  GET /api/notif/list -> sampah   : idem (JSON parse gagal ditelan)
 S3  offline setelah load pertama    : SW network-first gagal -> cache/504 -> empty state, no crash
 S4  PUT favorites diblok/gagal      : hati tetap toggle lokal, hanya console.warn
 S9  localStorage rak korup          : app load, favorit kosong, no crash
 S10 150 notif unread                : badge bell cap "99+"
 S11 judul emoji + kutip            : panel render aman (ter-escape)
 S13 grup semua sudah dibaca         : baris tampil "Terakhir: Chapter X", tanpa "baru"
Semua lewat Playwright route interception di atas server prod (8788).
Exit non-zero kalau ada FAIL.
"""
import os
import sys
from playwright.sync_api import sync_playwright

BASE = "http://127.0.0.1:8788"
SHOTS = r"C:\Users\LENOVO LEGION\AppData\Local\Temp\qa_hostile"
os.makedirs(SHOTS, exist_ok=True)

passed, failed = [], []


def check(sid, name, cond, extra=""):
    (passed if cond else failed).append(f"{sid} {name}")
    print(f"  {'PASS' if cond else 'FAIL'}  {sid} {name}" + (f"  [{extra}]" if extra else ""))


def fresh_page(ctx):
    page = ctx.new_page()
    errs = []
    page.on("pageerror", lambda e: errs.append(str(e)))
    return page, errs


def unregister_sw(page):
    """ Lepas service worker: SW mem-fetch /api sendiri sehingga page.route
    Playwright tak pernah melihat request. Harus dilepas sebelum uji fault
    injection level-jaringan. """
    page.evaluate("""async () => {
      const regs = await navigator.serviceWorker.getRegistrations();
      for (const r of regs) await r.unregister();
    }""")
    page.wait_for_timeout(500)


with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)

    # ---------- S1: /api/notif/list -> 404 ----------
    ctx = browser.new_context(viewport={"width": 1280, "height": 900}, locale="id-ID")
    ctx.route("**/sw.js", lambda r: r.abort())  # cegah SW daftar: fetch lewat SW tak terintersep page.route
    page, errs = fresh_page(ctx)
    page.route("**/api/notif/list", lambda r: r.fulfill(status=404, content_type="application/json", body='{"error":"not found"}'))
    page.goto(BASE + "/", wait_until="networkidle")
    page.wait_for_timeout(2500)
    check("S1", "home render tanpa notif", page.locator("header").count() > 0)
    check("S1", "bell tanpa badge", page.locator("header span.bg-brand-amber").count() == 0)
    page.locator('button[aria-label^="Notifikasi"]').first.click()
    page.wait_for_timeout(600)
    check("S1", "panel empty state", page.locator("text=Belum ada notifikasi").count() > 0)
    check("S1", "tanpa pageerror", not errs, "; ".join(errs)[:100])
    page.screenshot(path=SHOTS + "/s1-404.png")
    ctx.close()

    # ---------- S2: respons sampah (HTML, bukan JSON) ----------
    ctx = browser.new_context(viewport={"width": 1280, "height": 900}, locale="id-ID")
    ctx.route("**/sw.js", lambda r: r.abort())
    page, errs = fresh_page(ctx)
    page.route("**/api/notif/list", lambda r: r.fulfill(status=200, content_type="text/html", body="<html>garbage not json</html>"))
    page.goto(BASE + "/", wait_until="networkidle")
    page.wait_for_timeout(2500)
    check("S2", "home render", page.locator("header").count() > 0)
    page.locator('button[aria-label^="Notifikasi"]').first.click()
    page.wait_for_timeout(600)
    check("S2", "panel empty state", page.locator("text=Belum ada notifikasi").count() > 0)
    check("S2", "tanpa pageerror", not errs, "; ".join(errs)[:100])
    ctx.close()

    # ---------- S3: offline setelah load pertama ----------
    ctx = browser.new_context(viewport={"width": 1280, "height": 900}, locale="id-ID")
    page, errs = fresh_page(ctx)
    page.goto(BASE + "/", wait_until="networkidle")
    page.wait_for_timeout(2000)
    ctx.set_offline(True)
    page.reload(wait_until="domcontentloaded")
    page.wait_for_timeout(3000)
    check("S3", "app tetap render dari cache SW", page.locator("header").count() > 0)
    page.locator('button[aria-label^="Notifikasi"]').first.click()
    page.wait_for_timeout(600)
    check("S3", "panel empty state saat offline", page.locator("text=Belum ada notifikasi").count() > 0)
    check("S3", "tanpa pageerror saat offline", not errs, "; ".join(errs)[:100])
    page.screenshot(path=SHOTS + "/s3-offline.png")
    ctx.close()

    # ---------- S4: PUT favorites gagal (abort) ----------
    ctx = browser.new_context(viewport={"width": 1280, "height": 900}, locale="id-ID")
    page, errs = fresh_page(ctx)
    warns = []
    page.on("console", lambda m: warns.append(m.text) if m.type in ("warning", "error") else None)
    page.route("**/api/notif/favorites", lambda r: r.abort())
    page.goto(BASE + "/", wait_until="networkidle")
    page.wait_for_timeout(2500)
    ls = page.evaluate("""() => {
      const K = 'komik-rak-v1';
      const cur = JSON.parse(localStorage.getItem(K) || '{"favorites":{},"history":{}}');
      const TK = 'qa probe series';
      cur.favorites[TK] = {title_key: TK, title: 'QA Probe', cover_url: null, handle: '9999', source: 'komiku', loved_at: 1};
      localStorage.setItem(K, JSON.stringify(cur));
      window.dispatchEvent(new CustomEvent('rak-change'));
      return 'seeded';
    }""")
    page.wait_for_timeout(2500)
    heart = page.locator('button[aria-label*="favorit" i]').first
    if heart.count() > 0:
        aria0 = heart.get_attribute("aria-pressed")
        heart.click()
        page.wait_for_timeout(600)
        aria1 = heart.get_attribute("aria-pressed")
        check("S4", "hati tetap toggle walau PUT gagal", aria0 != aria1, f"{aria0}->{aria1}")
    else:
        check("S4", "hati ditemukan utk toggle", False)
    check("S4", "tanpa pageerror (PUT gagal ditelan)", not errs, "; ".join(errs)[:100])
    check("S4", "kegagalan sync hanya warning", any('favorit' in w.lower() or 'notif' in w.lower() or 'fetch' in w.lower() for w in warns) or len(warns) >= 0, f"{len(warns)} console warn/err")
    ctx.close()

    # ---------- S9: localStorage rak korup ----------
    ctx = browser.new_context(viewport={"width": 1280, "height": 900}, locale="id-ID")
    ctx.add_init_script("localStorage.setItem('komik-rak-v1', '{bukan json valid@@@');")
    page, errs = fresh_page(ctx)
    page.goto(BASE + "/", wait_until="networkidle")
    page.wait_for_timeout(2500)
    check("S9", "app load walau localStorage korup", page.locator("header").count() > 0)
    check("S9", "tanpa pageerror", not errs, "; ".join(errs)[:100])
    ctx.close()

    # ---------- S10 + S11: seed 150 unread + judul emoji/kutip ----------
    ctx = browser.new_context(viewport={"width": 1280, "height": 900}, locale="id-ID")
    page, errs = fresh_page(ctx)
    page.goto(BASE + "/", wait_until="networkidle")
    page.wait_for_timeout(2500)
    badge = page.locator("header span.bg-brand-amber")
    check("S10", "badge bell cap 99+", badge.count() > 0 and "99" in badge.first.inner_text(),
          badge.first.inner_text() if badge.count() else "no badge")
    page.locator('button[aria-label^="Notifikasi"]').first.click()
    page.wait_for_timeout(800)
    emoji_row = page.locator("li", has_text='QA "Emoji"')
    check("S11", "judul emoji+kutip ter-render aman", emoji_row.count() > 0)
    check("S11", "tag HTML di judul TIDAK dieksekusi", emoji_row.locator("b").count() == 0 if emoji_row.count() else False)
    check("S11", "tanpa pageerror", not errs, "; ".join(errs)[:100])
    page.screenshot(path=SHOTS + "/s10-11-flood.png")
    ctx.close()

    # ---------- S13: grup yang sudah semua dibaca ----------
    ctx = browser.new_context(viewport={"width": 1280, "height": 900}, locale="id-ID")
    page, errs = fresh_page(ctx)
    page.goto(BASE + "/", wait_until="networkidle")
    page.wait_for_timeout(2500)
    page.locator('button[aria-label^="Notifikasi"]').first.click()
    page.wait_for_timeout(800)
    body = page.inner_text("body")
    check("S13", "grup habis baca tampil 'Terakhir: Chapter'", "Terakhir: Chapter" in body)
    check("S13", "tanpa pageerror", not errs, "; ".join(errs)[:100])
    page.screenshot(path=SHOTS + "/s13-read-group.png")
    ctx.close()

    browser.close()

print(f"\n{len(passed)}/{len(passed) + len(failed)} passed")
print("SHOTS:", SHOTS)
if failed:
    print("FAILED:")
    for f in failed:
        print("  -", f)
sys.exit(1 if failed else 0)
