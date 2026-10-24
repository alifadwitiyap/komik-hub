"""E2E tombol "Ekspor PDF" di toolbar reader (unified flow).

Seed: akun throwaway (PDF export butuh header X-Komik-User), lalu buka chapter
komiku:1284/77, klik tombol "Ekspor PDF", pastikan request /unified/download-pdf
terkirim dan toast sukses muncul.
"""
import json
import os
import random
import string
import time
import urllib.request
from playwright.sync_api import sync_playwright

BASE = "http://127.0.0.1:8788"
CHAPTER_URL = "/baca/komiku:1284/77"
USER = "e2epdf" + "".join(random.choice(string.ascii_lowercase + string.digits)
                          for _ in range(6))

passed, failed = [], []


def check(name, cond, extra=""):
    (passed if cond else failed).append(name)
    print(f"  {'PASS' if cond else 'FAIL'}  {name}" + (f"  [{extra}]" if extra else ""))


req = urllib.request.Request(
    BASE + "/api/user/claim",
    data=json.dumps({"username": USER}).encode(),
    headers={"Content-Type": "application/json"},
    method="POST")
with urllib.request.urlopen(req, timeout=30) as resp:
    resp.read()
print(f"akun    : {USER}\n")

with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    ctx = browser.new_context(viewport={"width": 1280, "height": 900}, locale="id-ID")
    ctx.add_init_script(f"localStorage.setItem('komik-akun-v1', {json.dumps(USER)});")
    page = ctx.new_page()
    errors = []
    page.on("pageerror", lambda e: errors.append(str(e)))
    pdf_reqs = []
    page.on("request", lambda r: pdf_reqs.append(r.url) if "download-pdf" in r.url else None)

    page.goto(BASE + CHAPTER_URL, wait_until="networkidle")
    page.wait_for_timeout(4000)

    btn = page.locator('button[aria-label="Ekspor PDF"]')
    check("toolbar: tombol 'Ekspor PDF' ada (unified)", btn.count() > 0)

    if btn.count() > 0:
        btn.first.click()
        ok = False
        for _ in range(20):
            t = page.locator("text=/PDF siap|Gagal membuat PDF/")
            if t.count() > 0:
                ok = "PDF siap" in t.first.inner_text()
                check("PDF: toast sukses 'PDF siap'", ok, t.first.inner_text())
                break
            page.wait_for_timeout(2000)
        else:
            check("PDF: toast sukses 'PDF siap'", False, "timeout 40s")
        check("PDF: request /unified/download-pdf terkirim",
              any("download-pdf" in u for u in pdf_reqs), str(pdf_reqs))

    check("console: tanpa pageerror", not errors, "; ".join(errors)[:120])
    browser.close()

# cleanup
try:
    os.remove(os.path.join(
        os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
        "..", "komiku-server", "data", "users", USER + ".json"))
except Exception:
    pass

print(f"\n{len(passed)}/{len(passed) + len(failed)} passed")
raise SystemExit(1 if failed else 0)
