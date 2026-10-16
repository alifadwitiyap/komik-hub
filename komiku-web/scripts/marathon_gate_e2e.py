"""E2E gerbang chaining marathon: komik belum ke-load semua -> chapter
berikutnya TIDAK dinyalakan.

Tanpa mock server: request gambar upstream DIPERLAMBAT lewat ctx.route, lalu
halaman dilompatkan ke dasar chapter.

Invariant yang diuji (bukan hitungan blok, tapi urutan sebab-akibat):
  untuk SETIAP blok KECUALI yang terakhir, semua gambarnya harus sudah
  selesai. Blok terakhir boleh masih memuat — itulah gunanya gerbang.
  Pelanggaran = ada blok non-terakhir yang belum penuh.

  A. selama gambar chapter terakhir belum selesai, invariant tidak dilanggar.
  B. setelah semuanya selesai, blok berikutnya masuk rantai.
"""
import json
import os
import sys
import time

from playwright.sync_api import sync_playwright

BASE = "http://127.0.0.1:8788"
SHOTS = r"C:\Users\LENOVO LEGION\AppData\Local\Temp\marathon_gate_e2e"
os.makedirs(SHOTS, exist_ok=True)

MID = "/maraton/komiku:1284/121"   # ch 121 punya prev(120) + next(122)
IMG_DELAY_MS = 800                 # perlambat tiap gambar

passed, failed = [], []


def check(name, cond, extra=""):
    (passed if cond else failed).append(name)
    print(f"  {'PASS' if cond else 'FAIL'}  {name}" + (f"  [{extra}]" if extra else ""))


STATE_JS = """() => {
  const imgs = [...document.querySelectorAll('img[data-b]')];
  const idx = [...new Set(imgs.map(i => Number(i.dataset.b)))].sort((a, b) => a - b);
  const blocks = idx.map(b => {
    const list = imgs.filter(i => Number(i.dataset.b) === b);
    const done = list.filter(i => i.complete && i.naturalWidth > 0).length;
    return { b: b, total: list.length, done: done };
  });
  return JSON.stringify({ blocks: blocks });
}"""


def state(page):
    return json.loads(page.evaluate(STATE_JS))


def violations(st) -> list:
    """blok non-terakhir yang belum penuh = pelanggaran invariant."""
    blocks = st.get("blocks", [])
    if len(blocks) < 2:
        return []
    return [b for b in blocks[:-1] if b["done"] < b["total"]]


with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    ctx = browser.new_context(viewport={"width": 1280, "height": 900}, locale="id-ID")
    ctx.route("**/sw.js", lambda r: r.fulfill(status=404, body="sw blocked"))

    def slow_img(route):
        time.sleep(IMG_DELAY_MS / 1000)
        route.continue_()

    # perlambat GAMBAR saja — JSON chapter tetap cepat, supaya yang diuji
    # benar-benar "gambar belum selesai", bukan "data belum datang".
    ctx.route("**/img?**", slow_img)
    ctx.route("**/img", slow_img)

    page = ctx.new_page()
    errors = []
    page.on("pageerror", lambda e: errors.append(str(e)))

    page.goto(BASE + MID, wait_until="domcontentloaded")
    deadline = time.time() + 45
    st = state(page)
    while time.time() < deadline and not st["blocks"]:
        st = state(page)
        page.wait_for_timeout(300)

    check("setup: chapter pertama ter-render", bool(st["blocks"]),
          f"{st['blocks'][0]['total']} gambar" if st["blocks"] else "-")

    # lompat LANGSUNG ke dasar (gambar banyak yang masih berjalan)
    page.evaluate("() => window.scrollTo(0, document.body.scrollHeight)")

    # ---- A: selama masih ada gambar berjalan, invariant tak boleh dilanggar
    first_violation = None
    samples = 0
    deadline = time.time() + 35
    while time.time() < deadline:
        st = state(page)
        samples += 1
        v = violations(st)
        if v:
            first_violation = v
            break
        page.wait_for_timeout(250)

    check("A: tak ada chapter yang masuk sebelum chapter sebelumnya penuh",
          first_violation is None,
          f"pelanggaran {first_violation}" if first_violation
          else f"{samples} sample, invariant utuh")
    page.screenshot(path=SHOTS + "/1-gate-menahan.png")

    # ---- B: setelah semua gambar beres, chaining harus lanjut -------------
    deadline = time.time() + 150
    st = state(page)
    while time.time() < deadline and len(st["blocks"]) < 2:
        st = state(page)
        page.wait_for_timeout(400)

    check("B: setelah chapter selesai dimuat -> chapter berikutnya masuk rantai",
          len(st["blocks"]) >= 2, str([b["b"] for b in st["blocks"]]))
    check("B: invariant masih utuh setelah chaining", not violations(state(page)))
    page.screenshot(path=SHOTS + "/2-chain-lanjut.png")

    # ---- B2: chaining lanjut sekali lagi ----------------------------------
    # Perlu scroll lanjut: setelah blok berikutnya masuk, pembaca masih berada
    # di blok sebelumnya, jadi pemicu baru menyala setelah dia menggulir lagi
    # (perilaku yang benar — bukan preload buta).
    deadline = time.time() + 150
    st = state(page)
    while time.time() < deadline and len(st["blocks"]) < 3:
        page.evaluate("() => window.scrollBy(0, 4000)")
        page.wait_for_timeout(300)
        st = state(page)

    check("B2: chaining lanjut lagi saat pembaca menggulir (blok 3 masuk)",
          len(st["blocks"]) >= 3, str([b["b"] for b in st["blocks"]]))
    check("B2: invariant tetap utuh setelah tiga blok", not violations(state(page)))

    check("console: tanpa pageerror", not errors, "; ".join(errors[:3]))
    ctx.close()
    browser.close()

print(f"\n{len(passed)}/{len(passed) + len(failed)} passed")
print("SHOTS:", SHOTS)
sys.exit(1 if failed else 0)
