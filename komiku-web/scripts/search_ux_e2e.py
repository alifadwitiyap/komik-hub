"""E2E UX halaman Cari: Enter-only, dropdown filter, genre filter nyata.

Kontrak (keputusan terakhir):
  1. Pencarian HANYA jalan saat submit (Enter / tombol Cari) — mengetik TIDAK
     memicu request apa pun (debounce 300ms sudah dibuang).
  2. Filter = TIGA DROPDOWN (Tipe | Status | Genre), bukan baris chip.
  3. SEMUA filter dikirim ke server (tipe/status/genre) — jumlah yang tampil
     sama dengan yang server kembalikan untuk parameter yang sama.
  4. Genre adalah FILTER NYATA: memilih genre mengubah isi hasil (diukur
     live: 'solo' + romance 45 -> 19 item). Batas jujur yang TERUKUR:
     'action' nyaris tidak menyaring di sebagian sumber, jadi test memakai
     genre yang terbukti menyaring.
  5. Feed hibrida: tanpa filter -> popular; ada filter -> catalogue (Completed
     tidak lagi kosong palsu).
  6. Relevansi: judul persis jadi kartu pertama.

Data uji = konten LIVE (komiku:1284 Reincarnator). Anchor ke permukaan
filter, bukan feed berotasi (aturan stack).
"""
import json
import os
import re
import sys
import time
import urllib.parse
import urllib.request

from playwright.sync_api import sync_playwright

BASE = "http://127.0.0.1:8788"
SHOTS = r"C:\Users\LENOVO LEGION\AppData\Local\Temp\search_ux_e2e"
os.makedirs(SHOTS, exist_ok=True)

QUERY = "solo leveling"
TIPE = "Manhwa"
STATUS = "Completed"
# Genre yang TERUKUR menyaring ('action' nyaris no-op di sebagian sumber).
GENRE = "romance"

CARD_CSS = '[data-search-results] a[href^="/manga/"]'
INPUT = 'input[aria-label="Cari manga"]'
SELECT_TIPE = 'select[aria-label="Filter tipe"]'
SELECT_STATUS = 'select[aria-label="Filter status"]'
SELECT_GENRE = 'select[aria-label="Filter genre"]'

passed, failed = [], []


def check(name, cond, extra=""):
    (passed if cond else failed).append(name)
    print(f"  {'PASS' if cond else 'FAIL'}  {name}" + (f"  [{extra}]" if extra else ""))


def api_items(params: dict) -> list:
    url = BASE + "/api/unified/search?" + urllib.parse.urlencode(
        {"q": QUERY, "limit": 60, **params}
    )
    try:
        return json.load(urllib.request.urlopen(url, timeout=120)).get("items", [])
    except Exception:
        return []


def api_count(params: dict) -> int:
    return len(api_items(params))


def count_number(page):
    """Angka dari [data-search-count]."""
    txt = page.evaluate(
        "() => document.querySelector('[data-search-count]')?.textContent || ''"
    )
    m = re.match(r"\s*(\d+)", txt)
    return int(m.group(1)) if m else None


def wait_dom(page, js, timeout=30):
    """Polling berbatas: tunggu kondisi JS true (bukan sleep tetap)."""
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            if page.evaluate(js):
                return True
        except Exception:
            pass
        page.wait_for_timeout(200)
    return False


def new_page(browser):
    ctx = browser.new_context(viewport={"width": 1280, "height": 900}, locale="id-ID")
    ctx.route("**/sw.js", lambda r: r.fulfill(status=404, body="sw blocked"))
    page = ctx.new_page()
    errors = []
    page.on("pageerror", lambda e: errors.append(str(e)))
    return ctx, page, errors


# ------------------------------------------------ 0. Kontrak API -----------
with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)

    plain = api_items({})
    check("api: search?q=solo leveling -> 200 dengan items", len(plain) > 0, f"{len(plain)} item")
    titles = [m["title"] for m in plain]
    exact_idx = next((i for i, t in enumerate(titles) if t.lower().startswith(QUERY)), -1)
    check("api: judul exact match di POSISI 0 (relevansi)", exact_idx == 0,
          f"posisi={exact_idx} teratas={titles[0][:40] if titles else '-'}")

    by_genre = api_items({"genre": GENRE})
    check("api: filter genre MENGUBAH hasil (bukan penanda)",
          len(by_genre) > 0 and {m["title"] for m in by_genre} != {m["title"] for m in plain},
          f"tanpa-genre={len(plain)} dengan-genre={len(by_genre)}")

    by_both = api_items({"tipe": TIPE, "status": STATUS})
    check("api: tipe+status menyaring server-side",
          all(m.get("manga_type") == TIPE and m.get("status") == STATUS for m in by_both)
          if by_both else True,
          f"{len(by_both)} item")

    try:
        cat = json.load(urllib.request.urlopen(
            BASE + "/api/unified/catalogue?" + urllib.parse.urlencode(
                {"tipe": TIPE, "status": STATUS, "limit": 60}), timeout=120))
        cat_items = cat.get("items", [])
        cat_ok = True
    except Exception:
        cat_items, cat_ok = [], False
    check("api: catalogue?tipe&status -> 200, tidak kosong palsu",
          cat_ok and len(cat_items) > 0, f"{len(cat_items)} item")

    # -------------------------------------------- 1. Enter-only ------------
    ctx, page, errors = new_page(browser)
    page.goto(BASE + "/cari", wait_until="domcontentloaded")
    wait_dom(page, f"() => !!document.querySelector('{SELECT_TIPE}')", timeout=30)

    reqs = []
    page.on("request", lambda r: reqs.append(r.url) if "/api/unified/" in r.url else None)
    reqs.clear()

    page.fill(INPUT, QUERY)
    page.wait_for_timeout(1800)  # cukup lama untuk debounce lama (300ms) memicu
    typed_reqs = [u for u in reqs if "/unified/search" in u]
    check("enter-only: mengetik TIDAK memicu request search", len(typed_reqs) == 0,
          f"{len(typed_reqs)} request")

    page.press(INPUT, "Enter")
    ok = wait_dom(page, f"() => document.querySelectorAll('{CARD_CSS}').length > 0", timeout=40)
    enter_reqs = [u for u in reqs if "/unified/search" in u]
    check("enter-only: Enter memicu tepat 1 request", len(enter_reqs) == 1,
          f"{len(enter_reqs)} request")
    check("enter: hasil tampil", ok)

    n_plain = count_number(page)
    check("enter: jumlah tampil == jumlah API (tanpa filter)",
          n_plain == len(plain), f"tampil={n_plain} api={len(plain)}")

    if ok:
        first = page.locator(CARD_CSS).first
        alt = first.locator("img").first.get_attribute("alt") or ""
        check("relevansi: kartu pertama = judul exact match",
              QUERY.lower() in alt.lower(), alt[:60])
        y1 = (first.bounding_box() or {}).get("y", 999)
        y2 = (page.locator(CARD_CSS).nth(1).bounding_box() or {}).get("y", 999)
        check("grid: dua kolom (kartu 1 & 2 satu baris)", abs(y1 - y2) < 2,
              f"y1={y1:.0f} y2={y2:.0f}")
        page.screenshot(path=SHOTS + "/1-search-enter.png")

    # -------------------------------------------- 2. Dropdown ---------------
    check("ui: tiga dropdown filter ada",
          page.locator(SELECT_TIPE).count() == 1
          and page.locator(SELECT_STATUS).count() == 1
          and page.locator(SELECT_GENRE).count() == 1)
    # Tunggu union /genres masuk DULU (fetch async) — menghitung opsi sebelum
    # itu selesai menghasilkan "1 opsi" palsu.
    wait_dom(page, f"() => document.querySelectorAll('{SELECT_GENRE} option').length > 20",
             timeout=30)
    genre_opts = page.locator(f"{SELECT_GENRE} option").count()
    check("ui: dropdown genre berisi daftar genre (>20 opsi)", genre_opts > 20,
          f"{genre_opts} opsi")

    page.select_option(SELECT_TIPE, TIPE)
    page.select_option(SELECT_STATUS, STATUS)
    want = f"tipe={TIPE}&status={STATUS}".replace(" ", "%20")
    wait_dom(page,
             f"() => performance.getEntriesByType('resource')"
             f".some(e => e.name.includes('/unified/search')"
             f" && e.name.includes('{want}'))", timeout=40)
    wait_dom(page, f"() => (document.querySelector('[data-search-count]')"
                   f"?.textContent||'').includes('{STATUS}')", timeout=15)

    n_both = count_number(page)
    api_both = api_count({"tipe": TIPE, "status": STATUS})
    check("filter: tampil == API untuk tipe+status", n_both == api_both,
          f"tampil={n_both} api={api_both}")
    cards = page.locator(CARD_CSS).count()
    check("filter: tipe+status TIDAK empty palsu", cards > 0, f"{cards} kartu")
    check("filter: tidak ada empty state", "Tidak ada hasil" not in page.inner_text("body"))
    page.screenshot(path=SHOTS + "/2-search-filtered.png")

    page.select_option(SELECT_GENRE, GENRE)
    wait_dom(page,
             f"() => performance.getEntriesByType('resource')"
             f".some(e => e.name.includes('/unified/search')"
             f" && e.name.includes('genre={GENRE}'))", timeout=40)
    page.wait_for_timeout(600)
    n_genre = count_number(page)
    # Bandingkan dengan parameter yang SAMA (tipe+status masih aktif dari
    # langkah sebelumnya) — kalau tidak, apel dibanding jeruk.
    api_genre = api_count({"tipe": TIPE, "status": STATUS, "genre": GENRE})
    check("genre filter: tampil == API untuk genre", n_genre == api_genre,
          f"tampil={n_genre} api={api_genre}")
    n_nogenre = api_count({"tipe": TIPE, "status": STATUS})
    check("genre filter: hasil BERUBAH dari tanpa-genre (menyaring nyata)",
          n_genre != n_nogenre, f"tanpa-genre={n_nogenre} dengan-genre={n_genre}")

    rec = page.locator("[data-recent-searches]")
    rec_txt = rec.inner_text() if rec.count() else ""
    check("ui: baris riwayat pencarian ada", rec.count() == 1)
    check("ui: riwayat memuat query", QUERY in rec_txt, rec_txt[:60])
    page.screenshot(path=SHOTS + "/3-recent-searches.png")
    ctx.close()

    # -------------------------------------------- 3. Eksplorasi ------------
    ctx, page, errors2 = new_page(browser)
    page.goto(BASE + "/cari?" + urllib.parse.urlencode(
        {"tipe": TIPE, "status": STATUS}), wait_until="domcontentloaded")
    ok = wait_dom(page, f"() => document.querySelectorAll('{CARD_CSS}').length > 0", timeout=40)
    check("eksplorasi: filter aktif -> catalogue (tidak kosong palsu)", ok)
    n_cat = count_number(page)
    check("eksplorasi: tampil == API catalogue", n_cat == len(cat_items),
          f"tampil={n_cat} api={len(cat_items)}")
    page.screenshot(path=SHOTS + "/4-explore-filtered.png")

    ctx2, page2, _ = new_page(browser)
    page2.goto(BASE + "/cari", wait_until="domcontentloaded")
    ok2 = wait_dom(page2, f"() => document.querySelectorAll('{CARD_CSS}').length > 0", timeout=40)
    check("eksplorasi: tanpa filter -> popular (feed tampil)", ok2)
    ctx2.close()
    ctx.close()

    all_errors = errors + errors2
    check("console: tanpa pageerror", not all_errors, "; ".join(all_errors[:3]))
    browser.close()

print(f"\n{len(passed)}/{len(passed) + len(failed)} passed")
print("SHOTS:", SHOTS)
sys.exit(1 if failed else 0)
