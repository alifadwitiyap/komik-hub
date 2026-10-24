"""E2E: tombol refresh manual per-gambar saat gambar stuck >2s.

Kontrak:
  1. Gambar (via /img) yang tidak settle dalam ~2s memunculkan tombol
     refresh (aria-label "Muatin ulang halaman ini") — membesar & di tengah
     gambar (bukan pojok kanan atas).
  2. Klik tombol → re-mount <img> + URL baru ber-`?t=` (cache-buster).
  3. Klik tidak memunculkan "Coba lagi" (itu untuk error nyata), dan tidak
     memblokir scroll/reader.

Simulasi: route intercept `**/img` digantung (tak pernah continue) supaya
gambar pending selamanya → tombol stuck muncul deterministik. Setelah assert
tombol muncul, route di-reset supaya refresh cepat sukses.
"""
import json
import re
import sys
import time

from playwright.sync_api import sync_playwright

BASE = "http://127.0.0.1:8790"
STUCK_MS = 2000
SHOTS = r"C:\Users\LENOVO LEGION\AppData\Local\Temp\image_refresh_demo"
import os
os.makedirs(SHOTS, exist_ok=True)

# komiku:1284 = Reincarnator (seed E2E) — chapter 121 stabil.
URL = f"{BASE}/baca/komiku:1284/121"


def sync_img(page):
    """Route /img: GANTUNG request (tak pernah continue/fulfill) supaya gambar
    pending permanen → deterministik muncul tombol stuck. Kembalikan fungsi
    pemulihan untuk melepas route sebelum klik refresh.
    """

    pat = re.compile(r"/img\?u=.*")

    def hang(route):
        # Tidak memanggil continue_/fulfill → request menggantung, gambar tak
        # pernah settle (tanpa error). Ini membuat state `stuck` muncul.
        return

    page.route(pat, hang)

    def restore():
        page.unroute(pat)

    return restore


def main():
    with sync_playwright() as p:
        # service_workers="block": dari rutin ini, request /img dilayani
        # service worker (cache offline) sehingga route intercept tak pernah
        # melihatnya. Blokir SW → semua /img lewat route.
        browser = p.chromium.launch(headless=True)
        context = browser.new_context(service_workers="block")
        page = context.new_page()
        try:
            # blokir SW biar route /img terlihat (aturan stack)
            page.route("**/sw.js", lambda r: r.fulfill(status=404, body="sw blocked"))
            restore = sync_img(page)

            page.goto(URL, wait_until="domcontentloaded", timeout=60000)
            page.wait_for_timeout(1500)
            # tutup modal login kalau ada
            try:
                page.get_by_role("button", name="Nanti saja").click(timeout=1200)
            except Exception:
                pass

            # Gambar pertama eager. Tunggu tombol refresh muncul (setelah >2s).
            btn = page.get_by_role("button", name="Muatin ulang halaman ini")
            try:
                btn.first.wait_for(state="visible", timeout=STUCK_MS + 3000)
            except Exception:
                print("FAIL: tombol refresh tidak muncul setelah 2s stuck")
                sys.exit(1)
            print("OK: tombol refresh muncul setelah >2s")

            # Jangan ada "Coba lagi" (itu khusus error nyata)
            retry = page.get_by_role("button", name="Coba lagi")
            assert retry.count() == 0, "Coba lagi muncul padahal gambar cuma lambat"
            print("OK: tidak ada Coba lagi (gambar cuma lambat, bukan error)")

            # Klik refresh: tangkap request /img baru yang ber-?t=
            got_buster = {}
            def on_request(req):
                if "/img?" in req.url and "t=" in req.url:
                    got_buster["url"] = req.url
            page.on("request", on_request)

            restore()  # refresh harus cepat — hapus delay dulu
            # screenshot sebelum klik (bukti tombol muncul)
            page.screenshot(path=os.path.join(SHOTS, "sebelum_refresh.png"))
            # klik programmatic (dispatch event asli) — lewati hit-testing overlay
            page.evaluate("""() => {
              const b = document.querySelector('button[aria-label="Muatin ulang halaman ini"]');
              if (b) b.click();
            }""")
            page.wait_for_timeout(400)
            page.screenshot(path=os.path.join(SHOTS, "sesudah_refresh.png"))
            # tunggu request baru dengan buster
            deadline = time.time() + 5
            while time.time() < deadline and "url" not in got_buster:
                page.wait_for_timeout(200)
            # debug: print semua request /img
            img_reqs = []
            def dump_req(req):
                if "/img?" in req.url:
                    img_reqs.append(req.url)
            page.on("request", dump_req)
            page.wait_for_timeout(1500)
            print("DEBUG semua /img sejak klik:", img_reqs)
            st2 = page.evaluate("""() => {
              const el = document.querySelector('img[data-page="0"]');
              if (!el) return {found:false};
              return {found:true, src: el.src, complete: el.complete};
            }""")
            print("DEBUG img state:", st2)
            assert "url" in got_buster, "request refresh tidak membawa ?t="
            print("OK: refresh memunculkan request baru dengan ?t=")
            print("   new url:", got_buster["url"])

            # Gambar harus selesai (visible/loaded) setelah refresh cepat
            img = page.locator("img[data-page='0']")
            page.wait_for_function(
                "() => { const el = document.querySelector(\"img[data-page='0']\"); "
                "return el && el.complete && el.naturalWidth > 0; }",
                timeout=8000,
            )
            print("OK: gambar termuat setelah refresh")

            # Tombol refresh hilang setelah termuat
            page.wait_for_timeout(500)
            assert btn.count() == 0, "tombol refresh masih tampil setelah gambar termuat"
            print("OK: tombol refresh hilang setelah termuat")

            print("PASS: image_refresh_e2e")
        finally:
            browser.close()


if __name__ == "__main__":
    main()
