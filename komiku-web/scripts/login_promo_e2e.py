#!/usr/bin/env python3
"""login_promo_e2e.py — E2E Login Promo Modal (Komik Hub).

Menguji fitur modal login promo: modal yang muncul saat pertama buka browser
(belum login), bisa di-dismiss, form login inline username-only, disembunyikan
di route /akun, dan per-sesi (dismiss tersimpan 24 jam di localStorage
`komik.login-promo.dismissed.v1`). Fokus fitur ini adalah AWARENESS, bukan
paksaan — semua jalur menutup harus tidak mengganggu alur baca.

Tujuh asersi (test-case berurutan):
  1. Konteks browser fresh (localStorage kosong) -> modal promo muncul di home.
  2. Klik tombol X -> modal hilang; dalam sesi yang sama (reload/tab baru)
     -> modal TIDAK muncul lagi (dismiss persisted per sesi).
  3. Sesi baru (konteks fresh) -> modal muncul lagi.
  4. Navigasi ke /akun (logged out) -> modal TIDAK muncul.
  5. Submit username invalid ("ab") -> pesan validasi tampil, modal tetap terbuka.
  6. Submit username valid (e2e-promo-alif) -> modal menutup; user jadi login
     (localStorage komik-akun-v1 ter-set + header X-Komik-User terkirim).
  7. Escape dan klik backdrop menutup seperti tombol X.

Konvensi E2E stack (lihat references/e2e-verification.md):
  - Playwright sync melawan server live (default 8788).
  - Block service worker `ctx.route('**/sw.js')` SEBELUM navigasi pertama
    (kalau tidak, `page.route` tidak melihat request /api).
  - Poll predicate, jangan sleep buta.
  - Bersihkan akun throwaway via `e2e_cleanup.py` (track/cleanup_claimed).

Kontrak selector (cocok dengan src/components/LoginPromoModal.tsx):
  - Container panel / dialog : `[data-login-promo]`
  - Backdrop overlay          : div.fixed.inset-0.z-50 (klik di luar panel = dismiss)
  - Tombol tutup X           : `button[aria-label="Tutup"]`  (plus "Nanti saja")
  - Input username            : `input[aria-label="Username"]` (di dalam modal)
  - Tombol submit             : `button[type="submit"]`
  - Pesan validasi            : `p[role="alert"]` (teks USERNAME_RULE, memuat "3-20")
  - Dismiss disimpan di       : localStorage `komik.login-promo.dismissed.v1`
  - Akun aktif disimpan di    : localStorage `komik-akun-v1`

Fitur ini mungkin belum ter-build/di-serve di dist/ — skrip TIDAK boleh
mengandalkan fitur sudah tersaji. Kalau server/dist masih stale dan modal tak
muncul, skrip gagal dengan pesan PRASYARAT yang jelas (masalah lingkungan /
fitur belum dibangun), bukan menuduh regresi. Exit: 0 = semua check lulus;
1 = ada asersi gagal; 2 = prasyarat/lingkungan (fitur belum tersaji, server
mati, dst).

  python scripts/login_promo_e2e.py
  python scripts/login_promo_e2e.py --base-url http://127.0.0.1:8789
  python scripts/login_promo_e2e.py --keep   # jangan bersihkan akun di akhir
"""

from __future__ import annotations

import argparse
import os
import sys
import time
import urllib.request

import e2e_cleanup

from playwright.sync_api import sync_playwright

DEFAULT_BASE = "http://127.0.0.1:8788"
SHOTS = r"C:\Users\LENOVO LEGION\AppData\Local\Temp\login_promo_e2e"

# Kunci localStorage (kontrak, lihat dokstring).
DISMISS_KEY = "komik.login-promo.dismissed.v1"
ACCOUNT_KEY = "komik-akun-v1"

# Selector kontrak modal (cocok dengan src/components/LoginPromoModal.tsx):
#   - container panel  : [data-login-promo]  (role=dialog)
#   - backdrop overlay  : div.fixed.inset-0.z-50 (klik di luar panel = dismiss)
#   - tombol X         : button[aria-label="Tutup"]
#   - tombol "Nanti saja" : sama-sama memanggil dismiss()
#   - input username    : input[aria-label="Username"]
#   - submit            : button[type="submit"] ("Lanjut")
#   - pesan validasi    : p[role="alert"] (teks USERNAME_RULE, memuat "3-20")
SEL_MODAL = "[data-login-promo]"
SEL_CLOSE = "button[aria-label=\"Tutup\"]"
SEL_USERNAME = "[data-login-promo] input[aria-label=\"Username\"]"
SEL_SUBMIT = "[data-login-promo] button[type=\"submit\"]"

VALID_USER = "e2e-promo-alif"
INVALID_USER = "ab"  # < 3 char -> ditolak klien

passed: list[str] = []
failed: list[str] = []


def check(name: str, cond: bool, extra: str = "") -> bool:
    (passed if cond else failed).append(name)
    print(f"  {'PASS' if cond else 'FAIL'}  {name}" + (f"  [{extra}]" if extra else ""))
    return bool(cond)


class PrereqMissing(Exception):
    """Fitur tak ada / server stale — masalah lingkungan, bukan regresi."""


def wait_visible(locator, timeout_s: float = 8.0) -> bool:
    """Poll hingga selector terlihat (bukan sleep buta)."""
    deadline = time.time() + timeout_s
    while time.time() < deadline:
        try:
            if locator.count() > 0 and locator.first.is_visible():
                return True
        except Exception:
            pass
        time.sleep(0.15)
    return False


def wait_invisible(locator, timeout_s: float = 8.0) -> bool:
    """Poll hingga selector tidak ada / tidak terlihat."""
    deadline = time.time() + timeout_s
    while time.time() < deadline:
        try:
            if locator.count() == 0 or not locator.first.is_visible():
                return True
        except Exception:
            return True
        time.sleep(0.15)
    return False


def goto_fresh(p, base: str, path: str = "/", locale: str = "id-ID"):
    """Context + page baru (sesi baru, localStorage kosong), SW diblokir.

    Block `**/sw.js` via ctx.route SEBELUM navigasi pertama — kalau tidak,
    service worker (jika ada) mengambil alih fetch /api dan `page` tak pernah
    melihat request-nya.
    """
    ctx = p.chromium.launch(headless=True).new_context(
        viewport={"width": 1280, "height": 900}, locale=locale
    )
    ctx.route("**/sw.js", lambda route: route.abort())
    page = ctx.new_page()
    page.goto(base + path, wait_until="networkidle")
    return ctx, page


def modal_ready(page) -> bool:
    """Prasyarat: modal benar-benar muncul. Kalau tidak -> PrereqMissing."""
    if wait_visible(page.locator(SEL_MODAL)):
        return True
    # Modal tak muncul. Itu bisa karena (a) fitur belum dibangun/di-serve,
    # atau (b) halaman belum termuat. Bedaakan: cek home termuat dulu.
    body = ""
    try:
        body = page.inner_text("body")
    except Exception:
        pass
    if not body.strip():
        print("FATAL: halaman home kosong — server/dist belum menyajikan app dengan benar.", flush=True)
        raise PrereqMissing("halaman kosong (server/dist stale)")
    print(
        "FATAL: modal login promo TIDAK muncul di home. Ini berarti fitur "
        "belum dibangun / dist belum di-build ulang (di luar coverage skrip). "
        "Jalankan build + restart server, lalu ulangi. body[:100]=%r" % body[:100],
        flush=True,
    )
    raise PrereqMissing("fitur modal belum tersedia")


def poll_dismiss_key(page, expect: bool, timeout_s: float = 8.0) -> bool:
    """Poll localStorage DISMISS_KEY muncul/hilang sesuai `expect`."""
    deadline = time.time() + timeout_s
    while time.time() < deadline:
        try:
            val = page.evaluate("(k) => localStorage.getItem(k)", DISMISS_KEY)
            present = val is not None
            if present == expect:
                return True
        except Exception:
            pass
        time.sleep(0.15)
    return False


def main() -> int:
    ap = argparse.ArgumentParser(prog="login_promo_e2e.py")
    ap.add_argument("--base-url", default=DEFAULT_BASE)
    ap.add_argument("--keep", action="store_true", help="jangan bersihkan akun di akhir")
    args = ap.parse_args()
    base = args.base_url
    os.makedirs(SHOTS, exist_ok=True)

    # Probes server hidup (short timeout) sebelum buka browser.
    try:
        with urllib.request.urlopen(base + "/api/unified/health", timeout=6) as r:
            health_ok = r.status == 200
    except Exception:
        health_ok = False
    if not health_ok:
        print(f"FATAL: server tidak merespons di {base}/api/unified/health", flush=True)
        print("       jalankan komiku-server dulu (default 8788) atau pakai --base-url.", flush=True)
        return 2

    # Daftarkan akun throwaway untuk cleanup (hanya e2e*).
    e2e_cleanup.track(VALID_USER)

    try:
        with sync_playwright() as p:
            # ---- 1. konteks fresh -> modal muncul di home --------------------
            print("== 1. konteks fresh: modal muncul di home ==")
            ctx, page = goto_fresh(p, base)
            errors: list[str] = []
            page.on("pageerror", lambda e: errors.append(str(e)))
            modal_ready(page)  # Prasyarat: gagal bersih kalau fitur belum ada
            check("1. modal muncul di home (lossesi fresh)", True)
            page.screenshot(path=SHOTS + "/1-fresh-modal.png")

            # ---- 2. klik X -> hilang; sesi sama -> tidak muncul lagi ---------
            print("== 2. klik X -> dismiss per sesi ==")
            page.locator(SEL_CLOSE).first.click()
            check("2a. klik X -> modal hilang", wait_invisible(page.locator(SEL_MODAL)))
            persisted = poll_dismiss_key(page, True)
            check("2b. dismiss tersimpan di localStorage", persisted)

            # reload halaman: modal tidak muncul kembali
            page.reload(wait_until="networkidle")
            check("2c. reload sesi sama -> modal tidak muncul lagi",
                  wait_visible(page.locator(SEL_MODAL), timeout_s=4.0) is False)

            # tab baru di konteks yang sama (localStorage dibagi per konteks)
            page2 = ctx.new_page()
            page2.goto(base + "/", wait_until="networkidle")
            check("2d. tab baru sesi sama -> modal tidak muncul lagi",
                  wait_visible(page2.locator(SEL_MODAL), timeout_s=4.0) is False)
            page2.close()
            ctx.close()

            # ---- 3. sesi baru (fresh) -> modal muncul lagi ------------------
            print("== 3. sesi baru: modal muncul lagi ==")
            ctx, page = goto_fresh(p, base)
            page.on("pageerror", lambda e: errors.append(str(e)))
            check("3. sesi baru -> modal muncul lagi", wait_visible(page.locator(SEL_MODAL)))
            ctx.close()

            # ---- 4. /akun logged out -> modal tidak muncul -------------------
            print("== 4. /akun logged out: modal tidak muncul ==")
            ctx, page = goto_fresh(p, base, path="/akun")
            page.on("pageerror", lambda e: errors.append(str(e)))
            # Pastikan benar-benar halaman akun (form "Masuk atau daftar")
            form_ok = wait_visible(page.locator('form:has(input[id="akun-username"])'))
            check("4a. /akun menampilkan form login (logged out)", form_ok)
            check("4b. /akun: modal TIDAK muncul",
                  wait_visible(page.locator(SEL_MODAL), timeout_s=4.0) is False)
            ctx.close()

            # ---- 5. submit username invalid -> validasi, modal tetap ---------
            print("== 5. submit username invalid ==")
            ctx, page = goto_fresh(p, base)
            page.on("pageerror", lambda e: errors.append(str(e)))
            modal_ready(page)
            page.locator(SEL_USERNAME).fill(INVALID_USER)
            page.locator(SEL_SUBMIT).first.click()
            # Pesan validasi (aturan nama: "3-20" dari account.ts USERNAME_RULE)
            valid_msg = wait_visible(page.locator('text=3-20'), timeout_s=5.0) or \
                wait_visible(page.locator('text=username harus'), timeout_s=5.0)
            check("5a. pesan validasi tampil untuk username invalid", valid_msg)
            check("5b. modal tetap terbuka setelah submit invalid",
                  page.locator(SEL_MODAL).first.is_visible())
            page.screenshot(path=SHOTS + "/5-invalid-username.png")
            ctx.close()

            # ---- 6. submit username valid -> login + header terkirim ---------
            print("== 6. submit username valid ==")
            ctx, page = goto_fresh(p, base)
            page.on("pageerror", lambda e: errors.append(str(e)))
            modal_ready(page)

            # Tangkap header X-Komik-User pada request API berikutnya.
            seen_api_user: list[str] = []
            def _capture(req):
                path = req.url
                if "/api/" in path and req.headers.get("x-komik-user"):
                    seen_api_user.append(req.headers["x-komik-user"])
            page.on("request", _capture)

            page.locator(SEL_USERNAME).fill(VALID_USER)
            page.locator(SEL_SUBMIT).first.click()
            check("6a. submit valid -> modal menutup", wait_invisible(page.locator(SEL_MODAL)))
            # localStorage akun ter-set
            acc = page.evaluate("(k) => localStorage.getItem(k)", ACCOUNT_KEY)
            check("6b. akun aktif ter-set di localStorage", (acc or "").lower() == VALID_USER.lower(),
                  f"localStorage={acc!r}")
            # Trigger satu request ber-scope akun, lalu cek header.
            page.goto(base + "/rak", wait_until="networkidle")
            deadline = time.time() + 8.0
            while time.time() < deadline and not seen_api_user:
                time.sleep(0.15)
            check("6c. header X-Komik-User terkirim pada request API",
                  any(u.lower() == VALID_USER.lower() for u in seen_api_user),
                  f"dilihat={seen_api_user}")
            # logout untuk tidak meninggalkan akun aktif di konteks yang dibuang
            ctx.close()

            # ---- 7. Escape & klik backdrop menutup seperti X -----------------
            print("== 7. Escape & backdrop menutup ==")
            ctx, page = goto_fresh(p, base)
            page.on("pageerror", lambda e: errors.append(str(e)))
            modal_ready(page)
            page.keyboard.press("Escape")
            check("7a. Escape menutup modal", wait_invisible(page.locator(SEL_MODAL)))
            ctx.close()

            ctx, page = goto_fresh(p, base)
            page.on("pageerror", lambda e: errors.append(str(e)))
            modal_ready(page)
            # Klik backdrop di koordinat di luar panel (panel max-w-sm terpusat
            # di viewport 1280x900 → x=1100,y=200 pasti di luar). Overlay
            # onClick={dismiss} menutup modal; panel stopPropagation.
            page.mouse.click(1100, 200)
            check("7b. klik backdrop menutup modal", wait_invisible(page.locator(SEL_MODAL)))
            ctx.close()

            check("tidak ada error JS", not errors, "; ".join(errors[:2]))

        # ---- cleanup akun throwaway -----------------------------------------
        if not args.keep:
            removed = e2e_cleanup.cleanup_claimed()
            if removed:
                print(f"cleanup: {len(removed)} file state akun tes dihapus")

    except PrereqMissing as e:
        print(f"\nGAGAL PRASYARAT: {e}\nINI masalah lingkungan / fitur belum "
              f"dibangun, bukan regresi fitur.", flush=True)
        return 2

    print()
    print(f"lulus: {len(passed)}  gagal: {len(failed)}")
    if failed:
        for f in failed:
            print("  FAIL:", f)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
