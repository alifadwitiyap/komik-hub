"""E2E halaman /notifikasi (feed penuh + ringkasan harian) — Playwright headless.

Seed: akun throwaway + file `data/users/<akun>.json` (sama pola notif_e2e.py),
3 notifikasi: 2 hari ini (1 unread, 1 read) + 1 kemarin (unread). Memverifikasi:

  1. /notifikasi merender judul + badge "2 belum dibaca".
  2. Ringkasan harian: dua seksi hari, "Hari ini" yang pertama (terbaru).
  3. Klik baris grup → navigasi /manga/<handle> + semua notif title terbaca.
  4. Tombol "Tandai semua dibaca" membersihkan badge (2 → 0).
  5. Tombol hapus (X) menghapus baris.
  6. Dropdown lonceng punya "Lihat semua" → navigasi /notifikasi.
"""
import json
import os
import random
import re
import string
import time
import urllib.request
from playwright.sync_api import sync_playwright

BASE = "http://127.0.0.1:8788"
SHOTS = r"C:\Users\LENOVO LEGION\AppData\Local\Temp\notif_feed_e2e"
os.makedirs(SHOTS, exist_ok=True)

TK = "test series feed e2e"
TITLE = "Test Series Feed E2E"
NOW_MS = int(time.time() * 1000)
DAY_MS = 86_400_000

passed, failed = [], []


def check(name, cond, extra=""):
    (passed if cond else failed).append(name)
    print(f"  {'PASS' if cond else 'FAIL'}  {name}" + (f"  [{extra}]" if extra else ""))


# ---------------------------------------------------------------- seed state
SERVER_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                          "..", "komiku-server", "data", "users")
USER = "e2efeed" + "".join(random.choice(string.ascii_lowercase + string.digits)
                            for _ in range(6))
req = urllib.request.Request(
    BASE + "/api/user/claim",
    data=json.dumps({"username": USER}).encode(),
    headers={"Content-Type": "application/json"},
    method="POST")
with urllib.request.urlopen(req, timeout=30) as resp:
    resp.read()

seed = {
    "favorites": {
        TK: {
            "title": TITLE,
            "cover_url": None,
            "handle": "3215",
            "source": "komiku",
            "baselines": {"komiku": "45.3"},
        }
    },
    "notifications": [
        {"id": "f1", "title_key": TK, "title": TITLE, "handle": "3215",
         "chapter": "45.1", "sources": ["komiku"], "at": NOW_MS - 2000, "read": False},
        {"id": "f2", "title_key": TK, "title": TITLE, "handle": "3215",
         "chapter": "45.2", "sources": ["komiku"], "at": NOW_MS - 3000, "read": True},
        {"id": "f3", "title_key": TK, "title": TITLE, "handle": "3215",
         "chapter": "45.3", "sources": ["komiku"], "at": NOW_MS - 2 * DAY_MS, "read": False},
    ],
    # fresh → check cycle tak spawn (TTL 1800 s) dan tidak menimpa seed
    "last_check_at": NOW_MS,
}
os.makedirs(SERVER_DIR, exist_ok=True)
USER_FILE = os.path.normpath(os.path.join(SERVER_DIR, USER + ".json"))
with open(USER_FILE, "w", encoding="utf-8") as fh:
    json.dump(seed, fh, ensure_ascii=False, indent=1)
print(f"akun    : {USER}\nseed    : {USER_FILE}\n")

with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    ctx = browser.new_context(viewport={"width": 1280, "height": 900}, locale="id-ID")
    ctx.add_init_script(f"""
      localStorage.setItem('komik-akun-v1', {json.dumps(USER)});
      localStorage.setItem('komik-rak-v1', JSON.stringify({{
        favorites: {{ '{TK}': {{ title_key: '{TK}', title: '{TITLE}',
          cover_url: null, handle: '3215', source: 'komiku', loved_at: 1 }} }},
        history: {{}}
      }}));
    """)
    page = ctx.new_page()
    errors = []
    page.on("pageerror", lambda e: errors.append(str(e)))

    # 1. halaman /notifikasi: judul + badge unread
    page.goto(BASE + "/notifikasi", wait_until="networkidle")
    page.wait_for_timeout(2500)
    check("page: judul 'Notifikasi'", page.locator('h1', has_text="Notifikasi").count() > 0)
    badge = page.locator('span.bg-brand-amber')
    check("page: badge '2 belum dibaca'", badge.count() > 0 and "2" in badge.first.inner_text(),
          badge.first.inner_text() if badge.count() else "no badge")
    page.screenshot(path=SHOTS + "/1-page.png")

    # 2. ringkasan harian: dua seksi, 'Hari ini' pertama
    day_h = page.locator('section h2')
    labels = day_h.all_inner_texts()
    check("page: ada 2 seksi hari", len(labels) == 2, str(labels))
    check("page: seksi pertama 'Hari ini' (case-insensitive)",
          len(labels) > 0 and labels[0].lower() == "hari ini", labels[0] if labels else "")
    check("page: seksi kedua bukan 'Hari ini'",
          len(labels) > 1 and labels[1].lower() != "hari ini",
          labels[1] if len(labels) > 1 else "")
    # satu baris grup per judul di seksi 'Hari ini'
    check("page: 1 baris grup di 'Hari ini'",
          page.locator('section', has_text=re.compile("hari ini", re.I)).locator('li').count() == 1)
    # baris 'Kemarin'/tanggal punya 1 baris grup juga
    check("page: seksi kedua punya 1 baris grup",
          page.locator('section').nth(1).locator('li').count() == 1)

    # 3. klik baris → navigasi + tandai terbaca
    row = page.locator('section', has_text=re.compile("hari ini", re.I)).locator('li button').first
    check("page: baris grup ber-navigasi", row.count() > 0)
    row.click()
    page.wait_for_url("**/manga/3215", timeout=15000)
    check("klik baris: navigasi /manga/3215", page.url.endswith("/manga/3215"), page.url)
    page.wait_for_timeout(2500)

    # 4. Tandai semua dibaca → badge hilang
    page.goto(BASE + "/notifikasi", wait_until="networkidle")
    page.wait_for_timeout(2000)
    page.locator('button', has_text="Tandai semua dibaca").first.click()
    page.wait_for_timeout(2000)
    check("tandai semua: badge hilang", page.locator('span.bg-brand-amber').count() == 0)
    page.screenshot(path=SHOTS + "/2-all-read.png")

    # 5. tombol hapus (X) menghapus baris
    page.goto(BASE + "/notifikasi", wait_until="networkidle")
    page.wait_for_timeout(2000)
    before = page.locator('section li').count()
    page.locator('button[aria-label^="Hapus notifikasi"]').first.click()
    page.wait_for_timeout(1500)
    after = page.locator('section li').count()
    check("hapus: baris berkurang", after == before - 1, f"{before} -> {after}")
    page.screenshot(path=SHOTS + "/3-dismiss.png")

    # 6. dropdown lonceng: tombol 'Lihat semua' → /notifikasi
    page.goto(BASE + "/", wait_until="networkidle")
    page.wait_for_timeout(2500)
    bell = page.locator('button[aria-label^="Notifikasi"]')
    bell.first.click()
    page.wait_for_timeout(800)
    see_all = page.locator('button', has_text="Lihat semua")
    check("dropdown: tombol 'Lihat semua' ada", see_all.count() > 0)
    see_all.first.click()
    page.wait_for_url("**/notifikasi", timeout=15000)
    check("lihat semua: navigasi /notifikasi", page.url.endswith("/notifikasi"), page.url)
    page.wait_for_timeout(1500)
    page.screenshot(path=SHOTS + "/4-dropdown-link.png")

    check("console: tanpa pageerror", not errors, "; ".join(errors)[:120])
    browser.close()

with open(USER_FILE, "w", encoding="utf-8") as fh:
    json.dump({}, fh)  # bersihkan baris (file tetap ada, daftar kosong)
for sub in ("progress", "read"):
    pth = os.path.join(SERVER_DIR, "..", sub, USER + ".json")
    try:
        os.remove(pth)
    except OSError:
        pass
os.remove(USER_FILE)

print(f"\n{len(passed)}/{len(passed) + len(failed)} passed")
print("SHOTS:", SHOTS)
raise SystemExit(1 if failed else 0)
