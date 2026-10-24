"""E2E "Unduh offline" chapter — Playwright headless vs prod server 8788.

Alur:
  1. Buka chapter (data live, komiku:1284 chapter 121 — punya prev+next).
  2. Verifikasi tombol "Simpan chapter untuk dibaca offline" ada di toolbar.
  3. Klik tombol -> tunggu toast "Chapter tersimpan offline".
  4. Matikan jaringan (context.set_offline) -> reload chapter yang sama.
  5. Assert halaman masih render (gambar termuat dengan naturalWidth>0) —
     bukti dibaca dari cache service worker, bukan jaringan.
  6. Nyalakan jaringan lagi.

Catatan SW: request /img dilayani service worker (cache-first), jadi tidak
di-intercept page.route — service worker boleh jalan normal.
"""
import json
import os
import sys
import time
import urllib.request
from playwright.sync_api import sync_playwright

BASE = "http://127.0.0.1:8788"
for i, a in enumerate(sys.argv[1:]):
    if a == "--base-url" and i + 1 < len(sys.argv[1:]):
        BASE = sys.argv[i + 2]

SHOTS = r"C:\Users\LENOVO LEGION\AppData\Local\Temp\offline_e2e"
os.makedirs(SHOTS, exist_ok=True)

passed, failed = [], []


def check(name, cond, extra=""):
    (passed if cond else failed).append(name)
    print(f"  {'PASS' if cond else 'FAIL'}  {name}" + (f"  [{extra}]" if extra else ""))


# --- cari chapter live (prev+next) dari api --------------------------------
with urllib.request.urlopen(BASE + "/api/unified/series/komiku:1284", timeout=60) as r:
    series = json.load(r)
chs = series.get("chapters") or []
if not chs:
    print("FATAL: series seed tanpa chapter")
    raise SystemExit(2)
# pilih chapter dengan prev AND next: dapatkan daftar nomor numerik
nums = [c.get("number") for c in chs if c.get("number") is not None]
mid = None
for c in chs:
    n = str(c.get("number") or "")
    if n and c.get("previous") and c.get("next"):
        mid = n
        break
if not mid:
    mid = str(nums[len(nums) // 2] if nums else chs[0]["number"])
CHAPTER_URL = f"/baca/komiku:1284/{mid}"
print(f"chapter  : {CHAPTER_URL}\n")

with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    ctx = browser.new_context(viewport={"width": 1280, "height": 900}, locale="id-ID")
    page = ctx.new_page()
    errors = []
    page.on("pageerror", lambda e: errors.append(str(e)))

    # 1 & 2. buka chapter, pastikan tombol unduh offline ada
    page.goto(BASE + CHAPTER_URL, wait_until="networkidle")
    page.wait_for_timeout(4000)  # settle reader (gambar pertama)
    dl_btn = page.locator('button[aria-label="Simpan untuk dibaca offline"]')
    check("toolbar: tombol 'Simpan chapter untuk dibaca offline' ada", dl_btn.count() > 0)

    # 3. klik unduh offline -> tunggu toast selesai
    if dl_btn.count() > 0:
        dl_btn.first.click()
        page.wait_for_timeout(500)
        # toast bisa berupa progress ("… 3/40") lalu "Chapter tersimpan offline"
        done = page.locator("text=Chapter tersimpan offline")
        try:
            done.wait_for(timeout=120000)
            offline_ok = True
        except Exception:
            offline_ok = False
        check("unduh offline: toast 'Chapter tersimpan offline' muncul", offline_ok)
        page.screenshot(path=SHOTS + "/1-downloaded.png")
    else:
        check("unduh offline: toast muncul", False, "tombol tidak ada")

    # 4. matikan jaringan, reload chapter yang sama
    page.wait_for_timeout(1500)
    ctx.set_offline(True)
    page.goto(BASE + CHAPTER_URL, wait_until="domcontentloaded", timeout=30000)
    # SW harus melayani shell + metadata + gambar dari cache; beri waktu settle
    page.wait_for_timeout(6000)

    # 5. assert gambar termuat (cache), bukan kosong/gagal — poll sampai render
    loaded = {"ok": 0, "total": 0}
    for _ in range(15):
        loaded = page.evaluate("""() => {
          const imgs = Array.from(document.querySelectorAll('img[data-page]'))
          let ok = 0
          let total = 0
          for (const im of imgs) {
            total++
            if (im.complete && im.naturalWidth > 0) ok++
          }
          return { ok, total }
        }""")
        if loaded["ok"] > 0:
            break
        page.wait_for_timeout(2000)
    check(
        "offline: ada halaman yang termuat (naturalWidth>0)",
        loaded["ok"] > 0,
        f"{loaded['ok']}/{loaded['total']} halaman",
    )
    page.screenshot(path=SHOTS + "/2-offline.png")

    # 6. nyalakan jaringan + cek tidak ada pageerror
    ctx.set_offline(False)
    check("console: tanpa pageerror", not errors, "; ".join(errors)[:160])

    browser.close()

print(f"\n{len(passed)}/{len(passed) + len(failed)} passed")
print("SHOTS:", SHOTS)
raise SystemExit(1 if failed else 0)
