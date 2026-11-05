"""Probe Playwright: `liteInflight` tidak boleh memblokir retry series permanen.

Bug: `backgroundSeriesLite` tidak punya timeout. Kalau `/unified/series/{handle}`
menggantung (koneksi putus / upstream lambat), `fetch` tidak pernah settle →
`.finally()` tidak pernah jalan → entri `liteInflight[handle]` tertinggal
selamanya. Setiap `loadChapter` berikutnya untuk handle yang SAMA mendapat
promise mati itu (`if (running) return running`) dan TIDAK PERNAH mengirim
request baru — judul/sampul series tak pernah terisi sampai reload halaman.

Probe memakai SATU konteks JS (navigasi SPA lewat tombol "Berikutnya", bukan
`page.goto` — reload mereset modul `readerSource` dan menyembunyikan bug):

  A. REQUEST 1 sengaja digantung lebih lama dari timeout 8 s.
  B. Tunggu melewati timeout.
  C. Navigasi SPA ke chapter berikutnya (handle SAMA) → harus ada REQUEST 2.

FAIL = hanya 1 request series (entri inflight nyangkut permanen).
PASS = request kedua terkirim setelah timeout.

CATATAN PENTING (jebakan yang sudah terbukti di stack ini): request API
dilayani SERVICE WORKER, dan request yang keluar dari SW TIDAK terlihat oleh
`page.route` — tanpa memblokir SW, probe melaporkan "tidak ada request" bahkan
pada navigasi yang SUKSES (false-FAIL). Karena itu `sw.js` diblokir di konteks
ini. Verifikasi bahwa chapter 2 benar-benar termuat tetap dilakukan.

Exit 2 = prasyarat lingkungan (chapter tidak termuat / server mati), bukan bug.
"""

import sys
import time

from playwright.sync_api import sync_playwright

BASE = "http://127.0.0.1:8788"
HANDLE = "shinigami:48270276-bd79-4a46-b15e-fdd2cf5655b1"
CH1 = "1196"
CH2 = "1197"

# Timeout baru di backgroundSeriesLite = 8000 ms. Beri kelonggaran supaya
# probe tidak balapan dengan timer.
WAIT_AFTER_TIMEOUT_MS = 11000

passed, failed = [], []


def check(name, cond, extra=""):
    (passed if cond else failed).append(name)
    print(f"  {'PASS' if cond else 'FAIL'}  {name}" + (f"  [{extra}]" if extra else ""))


def series_hits(hits, handle):
    """Request /api/unified/series yang menunjuk handle ini (bukan prefetch lain)."""
    enc = handle.replace(":", "%3A")
    out = []
    for h in hits:
        u = h["url"]
        if "/api/unified/series/" not in u:
            continue
        if enc in u or handle in u:
            out.append(h)
    return out


def main():
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        ctx = browser.new_context(viewport={"width": 1280, "height": 900}, locale="id-ID")
        # WAJIB: request lewat SW tak terlihat page.route (lihat docstring).
        ctx.route("**/sw.js", lambda r: r.fulfill(status=204, body=""))
        page = ctx.new_page()
        errors = []
        page.on("pageerror", lambda e: errors.append(str(e)))

        hits = []
        state = {"hang": True}

        def on_route(route):
            url = route.request.url
            if "/api/unified/series/" in url:
                hits.append({"url": url, "t": time.time()})
                if state["hang"]:
                    # Gantung request PERTAMA: jangan fulfill, jangan abort.
                    # Ini mensimulasikan upstream yang tidak pernah menjawab.
                    state["hang"] = False
                    return  # route tidak di-resolve → request menggantung
            route.continue_()

        page.route("**/api/unified/series/**", on_route)

        # --- prasyarat: chapter pertama termuat ---
        page.goto(f"{BASE}/baca/{HANDLE}/{CH1}", wait_until="domcontentloaded")
        try:
            page.wait_for_selector("img[data-page]", timeout=30000)
        except Exception:
            print("GAGAL PRASYARAT: chapter tidak termuat (server/upstream) "
                  "— masalah lingkungan, bukan fitur")
            browser.close()
            return 2

        first = series_hits(hits, HANDLE)
        check("request series #1 terkirim saat chapter 1 dibuka", len(first) >= 1,
              f"n={len(first)}")

        # --- tunggu melewati timeout 8 s ---
        page.wait_for_timeout(WAIT_AFTER_TIMEOUT_MS)

        # --- navigasi SPA ke chapter berikutnya (handle SAMA, tanpa reload) ---
        nxt = page.locator('a[aria-label^="Baca Chapter Berikutnya"]')
        if nxt.count() == 0:
            print("GAGAL PRASYARAT: tombol 'Berikutnya' tidak ada "
                  "— masalah lingkungan, bukan fitur")
            browser.close()
            return 2
        nxt.first.click()

        # tunggu chapter 2 benar-benar termuat (bukan sekadar sleep)
        try:
            page.wait_for_function(
                "() => document.body.innerText.includes('Chapter 1197')",
                timeout=20000,
            )
        except Exception:
            pass
        page.wait_for_timeout(1500)

        # pastikan benar-benar SPA (modul tidak di-reload) dan chapter 2 termuat
        url_now = page.url
        check("navigasi SPA ke chapter 2 tanpa reload",
              f"/{CH2}" in url_now, url_now.split(BASE)[-1])
        body = " ".join(page.evaluate("document.body.innerText").split())
        check("chapter 2 benar-benar termuat", "Chapter 1197" in body, body[:90])

        total = series_hits(hits, HANDLE)
        check("request series #2 terkirim setelah timeout (retry tidak terblokir)",
              len(total) >= 2,
              f"n={len(total)}; " + " | ".join(h["url"].split("/api")[-1] for h in total))

        # --- diagnosa tambahan: apakah request kedua benar-benar dilayani ---
        if len(total) >= 2:
            check("request #2 adalah request BARU (bukan promise lama dipakai ulang)",
                  total[1]["t"] - total[0]["t"] >= 7.0,
                  f"gap={total[1]['t'] - total[0]['t']:.1f}s")

        check("console: tanpa pageerror", not errors, "; ".join(errors)[:160])

        browser.close()

    print(f"\n{len(passed)}/{len(passed) + len(failed)} passed")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
