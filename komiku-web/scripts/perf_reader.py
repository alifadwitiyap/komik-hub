#!/usr/bin/env python
"""Evaluator PERF sisi-BACA (yang dirasakan user), bukan cuma API.

Kenapa file ini ada: `komiku-server/scripts/perf-eval.sh` mengukur latensi
endpoint di localhost. Itu tidak mengukur apa pun yang user rasakan saat
membaca di koneksi jelek — yang menentukan di sana adalah BYTE gambar dan
kapan halaman pertama benar-benar terlihat.

Skrip ini menjalankan Chromium sungguhan, membatasi jaringan lewat CDP
(`Network.emulateNetworkConditions`), lalu mencatat:

  fcp_ms          first contentful paint — berapa lama LAYAR KOSONG
  title_ms        judul chapter tampil (toolbar reader ter-render)
  page1_ms        halaman 1 TERLIHAT (naturalWidth>0 DAN opacity 1)
  img_kb          byte gambar yang benar-benar lewat JARINGAN
  img_sw          jumlah gambar yang dilayani service worker (0 byte jaringan)
  total_kb        byte total (html + js + css + gambar) lewat jaringan
  cls             cumulative layout shift (isi "melompat" = user terganggu)
  repeat_ms       (--warm) kunjungan KEDUA: halaman 1 terlihat lagi
  next_ms         (--next) klik "berikutnya" -> halaman 1 chapter baru terlihat

PEMAKAIAN
  python scripts/perf_reader.py                       # cold slow3g, 1 run
  python scripts/perf_reader.py --profile fast3g --runs 3
  python scripts/perf_reader.py --warm                # + kunjungan kedua
  python scripts/perf_reader.py --next                # + perpindahan chapter
  python scripts/perf_reader.py --json out.json --no-budget

KONTRAK PASS/FAIL: anggaran di BUDGET (ms/byte). Skrip keluar 0 kalau semua
lolos, 1 kalau ada yang lewat. `--no-budget` cuma mencetak angka.

DUA MODE YANG HARUS DIBEDAKAN (jangan dicampur, angkanya beda jauh):
  cold (--sw block, default) = service worker DIMATIKAN + cache HTTP mati.
       Semua byte lewat jaringan; ini angka "pengunjung baru di koneksi jelek".
  warm (--warm)              = kunjungan kedua di konteks yang sama. Harus
       ~instan karena shell+gambar sudah tersimpan di perangkat.

Catatan lingkungan (jangan diubah tanpa mengukur): server harus SUDAH hidup di
port yang dituju, dan `dist/` harus hasil build terbaru (`npm run build`).
"""
from __future__ import annotations

import argparse
import json
import statistics
import sys
import time
from dataclasses import dataclass, field

from playwright.sync_api import sync_playwright

# --- profil jaringan -------------------------------------------------------
# downloadThroughput/uploadThroughput dalam BYTE per detik (bukan bit).
PROFILES = {
    # 400 kbps / 400 ms — "jelek tapi masih hidup" (3G buruk di daerah)
    "slow3g": {"latency": 400, "down": 400 * 1024 // 8, "up": 400 * 1024 // 8},
    # 1.6 Mbps / 150 ms — 3G wajar
    "fast3g": {"latency": 150, "down": 1600 * 1024 // 8, "up": 750 * 1024 // 8},
    # 4 Mbps / 60 ms — 4G lemah
    "4g": {"latency": 60, "down": 4000 * 1024 // 8, "up": 1000 * 1024 // 8},
    "none": None,
}

# --- anggaran (diisi dari baseline terukur; lihat docs/perf-reader-baseline.md)
# tolerance 20% sudah dibakar ke angka anggaran.
BUDGET = {
    "slow3g": {
        "fcp_ms": 2500,      # layar kosong: skeleton shell harus sudah tampil
        "page1_ms": 12000,   # baseline 9.6 s -> 20% headroom
        "img_kb": 420,       # baseline ~340 KB utk halaman pertama + sekitar
        "cls": 0.02,
    },
    "fast3g": {
        "fcp_ms": 1200,
        "page1_ms": 4200,
        "img_kb": 420,
        "cls": 0.02,
    },
}

VIEWPORT = {"width": 390, "height": 844}  # iPhone 14-ish, kasus terburuk nyata

# Predikat "halaman 1 sudah benar-benar terlihat"
PAGE1_JS = """() => {
    const el = document.querySelector('img[data-page="0"]');
    if (!el) return false;
    const op = parseFloat(getComputedStyle(el).opacity || '0');
    return el.naturalWidth > 0 && op > 0.99;
}"""


@dataclass
class Run:
    profile: str
    fcp_ms: float | None = None
    title_ms: float | None = None
    page1_ms: float | None = None
    img_bytes: int = 0
    total_bytes: int = 0
    img_requests: int = 0
    img_sw: int = 0
    cls: float = 0.0
    repeat_ms: float | None = None
    next_ms: float | None = None
    timeline: list[dict] = field(default_factory=list)
    errors: list[str] = field(default_factory=list)

    def as_dict(self) -> dict:
        return {
            "profile": self.profile,
            "fcp_ms": rnd(self.fcp_ms),
            "title_ms": rnd(self.title_ms),
            "page1_ms": rnd(self.page1_ms),
            "img_kb": round(self.img_bytes / 1024, 1),
            "img_sw": self.img_sw,
            "total_kb": round(self.total_bytes / 1024, 1),
            "img_requests": self.img_requests,
            "cls": round(self.cls, 4),
            "repeat_ms": rnd(self.repeat_ms),
            "next_ms": rnd(self.next_ms),
            "errors": self.errors,
        }


def rnd(v: float | None) -> float | None:
    return None if v is None else round(v, 1)


def wait_until(page, js: str, timeout_ms: int = 60000, interval: float = 0.05):
    """Poll predikat JS; True kalau terpenuhi sebelum timeout."""
    deadline = time.time() + timeout_ms / 1000
    while time.time() < deadline:
        try:
            if page.evaluate(js):
                return True
        except Exception:
            pass
        page.wait_for_timeout(int(interval * 1000))
    return False


def wait_until_arg(page, js: str, arg, timeout_ms: int = 60000, interval: float = 0.05):
    """Sama seperti `wait_until`, tapi predikat JS menerima satu argumen."""
    deadline = time.time() + timeout_ms / 1000
    while time.time() < deadline:
        try:
            if page.evaluate(js, arg):
                return True
        except Exception:
            pass
        page.wait_for_timeout(int(interval * 1000))
    return False


def run_once(pw, url: str, profile: str, do_next: bool, do_warm: bool, sw: str,
             verbose: bool = False) -> Run:
    r = Run(profile=profile)
    browser = pw.chromium.launch(args=["--disable-features=Translate,OptimizationHints"])
    ctx = browser.new_context(viewport=VIEWPORT, device_scale_factor=2, is_mobile=True,
                              has_touch=True, service_workers=sw)
    page = ctx.new_page()

    # --- meter byte lewat CDP (resource timing lintas-origin = 0 semua) ---
    cdp = ctx.new_cdp_session(page)
    cdp.send("Network.enable")
    reqs: dict[str, dict] = {}
    t_start = time.time()

    def on_req(p):
        reqs[p["requestId"]] = {"url": p["request"]["url"], "type": p.get("type", ""),
                                "t0": time.time() - t_start,
                                "priority": p.get("initialPriority", ""),
                                "from_sw": False}

    def on_resp(p):
        info = reqs.get(p["requestId"])
        if info is not None:
            info["from_sw"] = bool((p.get("response") or {}).get("fromServiceWorker"))

    def on_done(p):
        info = reqs.get(p["requestId"])
        if not info:
            return
        n = p.get("encodedDataLength") or 0
        r.total_bytes += n
        low = info["url"].lower().split("?")[0]
        is_img = info["type"] == "Image" or low.endswith(
            (".webp", ".jpg", ".jpeg", ".png", ".gif", ".avif"))
        if not is_img:
            return
        r.img_requests += 1
        if info.get("from_sw"):
            # dilayani service worker = 0 byte jaringan (memang tujuannya)
            r.img_sw += 1
        else:
            r.img_bytes += n
        if verbose:
            r.timeline.append({"url": info["url"].rsplit("/", 1)[-1][:70],
                               "start": round(info["t0"], 2),
                               "end": round(time.time() - t_start, 2),
                               "kb": round(n / 1024, 1),
                               "priority": info.get("priority", ""),
                               "sw": info.get("from_sw", False)})

    cdp.on("Network.requestWillBeSent", on_req)
    cdp.on("Network.responseReceived", on_resp)
    cdp.on("Network.loadingFinished", on_done)

    cfg = PROFILES[profile]
    if cfg:
        cdp.send("Network.emulateNetworkConditions", {
            "offline": False,
            "latency": cfg["latency"],
            "downloadThroughput": cfg["down"],
            "uploadThroughput": cfg["up"],
            "connectionType": "cellular3g",
        })
    # selalu cold untuk run utama: cache HTTP browser dimatikan
    cdp.send("Network.setCacheDisabled", {"cacheDisabled": True})

    # CLS + FCP diamati dari dalam halaman
    page.add_init_script("""
      window.__cls = 0; window.__lcp = 0;
      try {
        new PerformanceObserver((l) => {
          for (const e of l.getEntries()) if (!e.hadRecentInput) window.__cls += e.value;
        }).observe({type: 'layout-shift', buffered: true});
      } catch (e) {}
    """)

    t0 = time.time()
    page.goto(url, wait_until="domcontentloaded", timeout=90000)

    # judul chapter tampil
    if wait_until(page, """() => {
        const h = document.querySelector('header');
        return !!h && (h.innerText || '').trim().length > 3;
    }""", timeout_ms=45000):
        r.title_ms = (time.time() - t0) * 1000
    else:
        r.errors.append("judul tidak muncul")

    # halaman pertama TERLIHAT (bukan cuma <img> ada)
    if wait_until(page, PAGE1_JS, timeout_ms=90000):
        r.page1_ms = (time.time() - t0) * 1000
    else:
        r.errors.append("halaman 1 tidak pernah terlihat")

    try:
        r.cls = float(page.evaluate("() => window.__cls || 0"))
    except Exception:
        pass
    try:
        r.fcp_ms = page.evaluate(
            "() => (performance.getEntriesByName('first-contentful-paint')[0]||{}).startTime ?? null")
    except Exception:
        pass
    if verbose and r.timeline:
        print("  timeline gambar (mulai -> selesai, detik):")
        for t in sorted(r.timeline, key=lambda x: x["start"]):
            print(f"    {t['start']:7.2f} -> {t['end']:7.2f}  {t['kb']:7.1f} KB  "
                  f"prio={t['priority']:6s} sw={'Y' if t['sw'] else '-'} {t['url']}")

    # --- opsional: kunjungan KEDUA (SW sudah terisi) ----------------------
    if do_warm:
        page.goto("about:blank")
        t1 = time.time()
        page.goto(url, wait_until="commit", timeout=90000)
        if wait_until(page, PAGE1_JS, timeout_ms=60000):
            r.repeat_ms = (time.time() - t1) * 1000
        else:
            r.errors.append("kunjungan kedua: halaman 1 tidak terlihat")

    # --- opsional: perpindahan ke chapter berikutnya ---
    if do_next:
        # Modal promo login ("Masuk tanpa password") menutupi tombol dan
        # menelan klik. Tutup dulu — kalau tidak, harness ini GAGAL karena
        # alasan yang tidak ada hubungannya dengan performa.
        try:
            page.get_by_role("button", name="Nanti saja").click(timeout=1500)
        except Exception:
            pass
        link = page.query_selector("a[href*='/baca/']:has-text('Berikutnya')")
        if link:
            href = link.get_attribute("href") or ""
            url_before = page.url
            # `src` halaman 1 SEBELUM klik: route client-side mempertahankan
            # elemen <img> lama sampai data chapter baru tiba, jadi "halaman 1
            # terlihat" bisa cocok dengan gambar chapter LAMA (terukur 27 ms).
            src_before = page.evaluate(
                "() => document.querySelector('img[data-page=\"0\"]')?.getAttribute('src') || ''")
            t1 = time.time()
            link.click()
            try:
                page.wait_for_function(
                    "(old) => location.href !== old", arg=url_before, timeout=15000)
            except Exception:
                r.errors.append(f"URL tidak berubah setelah klik ({href})")
            NEW_PAGE1_JS = """(old) => {
                const el = document.querySelector('img[data-page="0"]');
                if (!el) return false;
                const s = el.getAttribute('src') || '';
                if (!s || s === old) return false;
                const op = parseFloat(getComputedStyle(el).opacity || '0');
                return el.naturalWidth > 0 && op > 0.99;
            }"""
            if wait_until_arg(page, NEW_PAGE1_JS, src_before, timeout_ms=90000):
                r.next_ms = (time.time() - t1) * 1000
            else:
                r.errors.append(f"chapter berikutnya ({href}) tidak tampil")
        else:
            r.errors.append("link 'Berikutnya' tidak ada")

    ctx.close()
    browser.close()
    return r


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--base", default="http://127.0.0.1:8788")
    ap.add_argument("--path", default="/baca/komiku:6167/232")
    ap.add_argument("--profile", default="slow3g", choices=list(PROFILES))
    ap.add_argument("--runs", type=int, default=1)
    ap.add_argument("--sw", default="block", choices=["block", "allow"],
                    help="block = cold jaringan sungguhan (default)")
    ap.add_argument("--warm", action="store_true", help="ukur juga kunjungan kedua")
    ap.add_argument("--next", action="store_true", help="ukur juga klik Berikutnya")
    ap.add_argument("--json", default=None)
    ap.add_argument("--no-budget", action="store_true")
    ap.add_argument("--verbose", action="store_true", help="cetak timeline tiap gambar")
    a = ap.parse_args()

    url = a.base.rstrip("/") + a.path
    print(f"PERF READER — {url}  profil={a.profile}  runs={a.runs}  sw={a.sw}")
    runs: list[Run] = []
    with sync_playwright() as pw:
        for i in range(a.runs):
            r = run_once(pw, url, a.profile, a.next, a.warm, a.sw, verbose=a.verbose)
            runs.append(r)
            d = r.as_dict()
            print(f"  run {i+1}: " + "  ".join(f"{k}={v}" for k, v in d.items() if v not in (None, [])))

    # ringkasan: median lintas run (angka tunggal cepat berisik)
    def med(key):
        vals = [getattr(r, key) for r in runs if getattr(r, key) is not None]
        return statistics.median(vals) if vals else None

    m_img = med("img_bytes")
    m_total = med("total_bytes")
    m_cls = med("cls")

    summary = {
        "profile": a.profile,
        "runs": a.runs,
        "sw": a.sw,
        "fcp_ms": rnd(med("fcp_ms")),
        "page1_ms": rnd(med("page1_ms")),
        "title_ms": rnd(med("title_ms")),
        "img_kb": round(float(m_img) / 1024, 1) if m_img is not None else None,
        "img_sw": med("img_sw"),
        "total_kb": round(float(m_total) / 1024, 1) if m_total is not None else None,
        "cls": round(float(m_cls), 4) if m_cls is not None else None,
        "repeat_ms": rnd(med("repeat_ms")),
        "next_ms": rnd(med("next_ms")),
        "errors": [e for r in runs for e in r.errors],
    }
    print("\nMEDIAN:", json.dumps(summary, ensure_ascii=False))

    if a.json:
        with open(a.json, "w", encoding="utf-8") as f:
            json.dump({"summary": summary, "runs": [r.as_dict() for r in runs]}, f, indent=2)
        print("ditulis:", a.json)

    if a.no_budget or a.profile not in BUDGET:
        return 0

    budget = BUDGET[a.profile]
    fails = 0
    print(f"\n--- anggaran profil {a.profile} ---")
    for key, limit in budget.items():
        got = summary.get(key)
        if got is None:
            print(f"  [FAIL] {key}: tidak terukur")
            fails += 1
            continue
        ok = got <= limit
        print(f"  [{'PASS' if ok else 'FAIL'}] {key:9s} {got:10.1f}  budget {limit}")
        fails += 0 if ok else 1
    if summary["errors"]:
        print("  errors:", summary["errors"])
    return 1 if fails else 0


if __name__ == "__main__":
    sys.exit(main())
