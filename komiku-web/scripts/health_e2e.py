"""E2E pill source-health ("N/4 sumber sehat") — Playwright headless vs prod server 8788.

Kontrak yang diuji (D:/project/komiku-web/.omh/plans/source-health-badge.md):
  GET /api/unified/health -> {"total":4,"healthy":N,"checked_at_ms":<unix ms>,
    "sources":[{"source","label","ok","latency_ms","error"}]}
Pill = tombol di TopBar (kanan-atas) bertulis "N/4", aria-label meringkas
kesehatan, dan tooltip pada hover/fokus yang menyebut SETIAP sumber — sumber
mati disebut dengan nama + pesan galat.

CATATAN MEKANISME FAULT INJECTION (bukan mock server):
  Probe upstream dilakukan SERVER-SIDE (komiku-server → reqwest adapter,
  `u_health` di src/unified.rs → `probe_sources` di komik/core). Terverifikasi
  pada build ini: browser TIDAK pernah meminta host upstream langsung — semua
  request (termasuk gambar) lewat 127.0.0.1:8788. Karena itu mem-blok host
  upstream dari browser (page.route) TIDAK membuat probe server gagal; injeksi
  dilakukan pada batas yang benar-benar dipakai pill, yaitu balasan
  `GET /api/unified/health`, lewat ctx.route.fulfill() dengan payload kontrak
  (shinigami mati). Blokir host upstream tetap dipasang sebagai jaring bila
  suatu saat app meminta upstream langsung.

PITFALL yang dihindari:
  1. Service worker fetch /api SENDIRI (stale-while-revalidate) → hasil cache
     menyembunyikan keadaan server. `**/sw.js` diblok lewat ctx.route SEBELUM
     navigasi pertama; juga service_workers="block" agar tak ada SW terdaftar.
  2. Anchor hanya pada pill/API — JANGAN pada feed home yang berotasi.
  3. aria-label dinamis (hitungan di dalam label) dibaca lewat atribut, bukan
     selector exact-match.
  4. Efek async server/browser ditunggu dengan loop polling berbanyak batas,
     bukan sleep tetap.
"""
import json
import os
import re
import sys
import time

from playwright.sync_api import sync_playwright

BASE = "http://127.0.0.1:8788"
HEALTH_URL = BASE + "/api/unified/health"
SHOTS = r"C:\Users\LENOVO LEGION\AppData\Local\Temp\health_e2e"
os.makedirs(SHOTS, exist_ok=True)

# Host upstream per sumber (komiku / mangaku / shinigami / kiryuu). Dipakai
# sebagai blokir defensif; lihat catatan mekanisme di docstring.
UPSTREAM_HOSTS = [
    "**/index.komikid.org/**",
    "**/content.komikid.org/**",
    "**/mangaku.lol/**",
    "**/api.shngm.io/**",
    "**/v7.kiryuu.to/**",
]

# Payload injeksi = bentuk persis GET /api/unified/health dengan shinigami mati.
FIXTURE = {
    "total": 4,
    "healthy": 3,
    "checked_at_ms": 1760000000000,
    "sources": [
        {"source": "komiku", "label": "Komiku", "ok": True, "latency_ms": 812, "error": None},
        {"source": "mangaku", "label": "Mangaku", "ok": True, "latency_ms": 640, "error": None},
        {"source": "shinigami", "label": "Shinigami", "ok": False, "latency_ms": 8021,
         "error": "timeout 5s"},
        {"source": "kiryuu", "label": "Kiryuu", "ok": True, "latency_ms": 980, "error": None},
    ],
}

COUNT_RE = re.compile(r"^\d+\/\d+$")
SLASH4_RE = re.compile(r"^\d+\/4$")

passed, failed = [], []


def check(name, cond, extra=""):
    (passed if cond else failed).append(name)
    print(f"  {'PASS' if cond else 'FAIL'}  {name}" + (f"  [{extra}]" if extra else ""))


def new_ctx(browser, fulfill_health=None):
    """Context baru: SW mati + host upstream diblok sebelum navigasi pertama."""
    ctx = browser.new_context(
        viewport={"width": 1280, "height": 900},
        locale="id-ID",
        service_workers="block",
    )
    # PITFALL 1: SW fetch /api sendiri — blok SEBELUM navigasi pertama.
    ctx.route("**/sw.js", lambda r: r.fulfill(status=404, body="sw blocked by e2e"))
    for host in UPSTREAM_HOSTS:
        ctx.route(host, lambda r: r.abort())
    if fulfill_health is not None:
        ctx.route(
            "**/api/unified/health",
            lambda r: r.fulfill(
                status=200, content_type="application/json",
                body=json.dumps(fulfill_health),
            ),
        )
    return ctx


def find_badge(page):
    """Locator tombol pill; robust terhadap sedikit perubahan DOM lane UI."""
    for sel in (
        "header [data-source-health] button",
        'header button[aria-label*="sumber sehat" i]',
        "header button:has(span.tabular-nums)",
    ):
        loc = page.locator(sel)
        if loc.count() > 0:
            return loc.first
    return None


def find_tooltip(page):
    for sel in ("header [data-source-health] [role=tooltip]", "header [role=tooltip]"):
        loc = page.locator(sel)
        if loc.count() > 0:
            return loc.first
    return None


def count_text(badge):
    """Teks angka pill ("3/4"). Ambil span nomor bila ada, else teks tombol."""
    span = badge.locator("span.tabular-nums")
    if span.count() > 0:
        return (span.first.inner_text() or "").strip()
    txt = (badge.inner_text() or "").strip()
    m = re.search(r"\d+\/4", txt) or re.search(r"\d+\/\d+", txt)
    return m.group(0) if m else txt


def wait_count(badge, timeout_ms=15000):
    """Polling berbatas: teks pill bisa '—' sebentar saat probe pertama."""
    deadline = time.time() + timeout_ms / 1000
    last = ""
    while time.time() < deadline:
        try:
            last = count_text(badge)
        except Exception:
            last = ""
        if last:
            return last
        page_wait(badge, 250)
    return last


def page_wait(loc, ms):
    loc.page.wait_for_timeout(ms)


def tooltip_text(page, timeout_ms=3000):
    """Teks tooltip (yang terlihat) setelah hover/fokus; None kalau tak muncul."""
    deadline = time.time() + timeout_ms / 1000
    last = None
    while time.time() < deadline:
        try:
            tt = find_tooltip(page)
            if tt is not None and tt.count() > 0 and tt.is_visible():
                last = (tt.inner_text() or "").strip()
        except Exception:
            pass
        if last:
            return last
        page_wait(page.locator("body"), 100)
    return last


with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)

    # ---------- 1. Kontrak API (build ini: endpoint belum ada) ----------
    ctx = new_ctx(browser)
    page = ctx.new_page()
    errors = []
    page.on("pageerror", lambda e: errors.append(str(e)))

    page.goto(BASE + "/", wait_until="networkidle")
    page.wait_for_timeout(2500)

    health = page.evaluate(
        "async () => { try { const r = await fetch('/api/unified/health');"
        " const t = await r.text();"
        " return {status: r.status, ct: r.headers.get('content-type') || '', body: t}; }"
        " catch (e) { return {status: 0, ct: '', body: String(e)}; } }"
    )
    ct = health.get("ct", "")
    body = health.get("body", "")
    check("api: GET /api/unified/health balas 200", health.get("status") == 200,
          f"HTTP {health.get('status')}")
    check("api: content-type JSON (bukan fallback HTML SPA)", "json" in ct.lower(),
          ct or "-")

    payload = None
    try:
        payload = json.loads(body)
    except Exception:
        check("api: body JSON parseable", False, body[:120])
    if payload is not None:
        check("api: body JSON parseable", True)
        check("api: total = 4", payload.get("total") == 4, str(payload.get("total")))
        healthy = payload.get("healthy")
        check("api: healthy numerik dan 0..4",
              isinstance(healthy, int) and 0 <= healthy <= 4, str(healthy))
        rows = payload.get("sources")
        check("api: sources[] = 4 baris", isinstance(rows, list) and len(rows) == 4,
              f"{len(rows) if isinstance(rows, list) else '-'} baris")
        keys_ok = isinstance(rows, list) and all(
            {"source", "ok"} <= set(r) for r in rows
        )
        check("api: tiap baris punya source + ok", keys_ok)
        sources_seen = [r.get("source") for r in rows] if isinstance(rows, list) else []
        check("api: 4 sumber dikenal (komiku/mangaku/shinigami/kiryuu)",
              set(sources_seen) >= {"komiku", "mangaku", "shinigami", "kiryuu"},
              ",".join(str(s) for s in sources_seen))
        check("api: healthy == jumlah baris ok",
              isinstance(rows, list) and healthy == sum(1 for r in rows if r.get("ok")),
              f"healthy={healthy}")
        check("api: checked_at_ms epoch millis",
              isinstance(payload.get("checked_at_ms"), (int, float))
              and payload["checked_at_ms"] > 1_600_000_000_000,
              str(payload.get("checked_at_ms")))

    # ---------- 2. Pill di app bar ----------
    badge = find_badge(page)
    check("badge: pill source-health ada di header app bar", badge is not None)

    if badge is not None:
        sw_regs = page.evaluate(
            "async () => (await navigator.serviceWorker.getRegistrations()).length"
        )
        check("setup: sw.js diblokir → tak ada service worker terdaftar", sw_regs == 0,
              f"{sw_regs} registrations")

        box = badge.bounding_box() or {}
        check("badge: posisi kanan-atas (TopBar)", box.get("x", 0) > 640,
              f"x={box.get('x'):.0f},y={box.get('y'):.0f}")
        aria = badge.get_attribute("aria-label") or ""
        check("badge: aria-label meringkas kesehatan", "sehat" in aria.lower()
              and re.search(r"\d+\/4", aria), aria[:100])
        # PITFALL 3: label dinamis — bandingkan nilai yang dibaca, jangan exact selector.

        txt = wait_count(badge)
        check("badge: teks N/4", bool(SLASH4_RE.match(txt)), txt or "(kosong)")
        # Bandingkan dengan API LIVE (bukan asumsi 4/4: kalau ada sumber yang
        # memang sedang mati, badge harus menampilkan angka itu, bukan 4/4).
        live_healthy = payload.get("healthy") if payload else None
        check("badge: angka pill == healthy API live",
              isinstance(live_healthy, int) and txt == f"{live_healthy}/4",
              f"pill={txt} api_healthy={live_healthy}")

        tip_closed = tooltip_text(page, timeout_ms=600)
        check("badge: tooltip TIDAK terlihat tanpa hover", not tip_closed,
              (tip_closed or "(terlihat — BUG: tooltip bocor)")[:80])

        badge.hover()
        page.wait_for_timeout(300)
        tip = tooltip_text(page)
        check("badge: tooltip terbuka saat hover", bool(tip), (tip or "")[:100])
        if tip:
            for src in FIXTURE["sources"]:
                check(f"tooltip: menyebut {src['label']}",
                      src["label"].lower() in tip.lower())
            # Sumber mati dicek dari payload LIVE (bukan fixture: live bisa
            # 4/4 sehat, dan saat itu memang TAK ADA sumber mati untuk disebut).
            live_rows = (payload.get("sources") if payload else None) or []
            live_dead = [r for r in live_rows if not r.get("ok")]
            if live_dead:
                for r in live_dead:
                    label = (r.get("label") or r.get("source") or "").lower()
                    check(f"tooltip: sumber mati {label} + pesan galat",
                          bool(label) and label in tip.lower()
                          and bool(r.get("error")) and r["error"] in tip)
            else:
                check("tooltip: live 4/4 → tidak ada sumber mati untuk disebut",
                      "mati" not in tip.lower(), (tip or "")[:80])
        page.screenshot(path=SHOTS + "/1-badge-live.png")

    # ---------- 3. Tooltip lewat fokus keyboard ----------
    if badge is not None:
        badge.evaluate("el => el.blur()")
        page.wait_for_timeout(150)
        badge.focus()
        tip_focus = tooltip_text(page)
        check("badge: tooltip terbuka saat fokus keyboard", bool(tip_focus),
              (tip_focus or "")[:100])
        page.screenshot(path=SHOTS + "/2-tooltip-focus.png")

    ctx.close()

    # ---------- 4. Fault injection: shinigami mati ----------
    ctx2 = new_ctx(browser, fulfill_health=FIXTURE)
    page2 = ctx2.new_page()
    page2.goto(BASE + "/", wait_until="networkidle")
    page2.wait_for_timeout(2500)
    badge2 = find_badge(page2)
    check("inject: pill tetap tampil dengan 1 sumber mati", badge2 is not None)
    if badge2 is not None:
        txt2 = wait_count(badge2)
        check("inject: badge membaca 3/4 saat shinigami mati", txt2 == "3/4",
              txt2 or "(kosong)")
        aria2 = badge2.get_attribute("aria-label") or ""
        check("inject: aria-label menyebut Shinigami", "shinigami" in aria2.lower(),
              aria2[:120])
        badge2.hover()
        page2.wait_for_timeout(300)
        tip2 = tooltip_text(page2)
        check("inject: tooltip menyebut Shinigami", bool(tip2)
              and "shinigami" in tip2.lower(), (tip2 or "")[:140])
        check("inject: tooltip memuat pesan galat shinigami", bool(tip2)
              and "timeout" in tip2.lower(), (tip2 or "")[:140])
        page2.screenshot(path=SHOTS + "/3-injected-shinigami-dead.png")
    ctx2.close()

    check("console: tanpa pageerror", not errors, "; ".join(errors[:2]))
    browser.close()

print(f"\n{len(passed)}/{len(passed) + len(failed)} passed")
print("SHOTS:", SHOTS)
sys.exit(1 if failed else 0)
