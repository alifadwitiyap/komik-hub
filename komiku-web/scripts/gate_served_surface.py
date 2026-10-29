"""Served-surface gate: render UI yang berubah di desktop & mobile.

Halaman yang berubah (perbaikan onError + allowlist):
  - /rak          (Rak.tsx  — Cover onError)
  - /manga/<h>    (SeriesUnified.tsx — cover onError)
  - /cari?q=...   (kartu cover)
  - /             (beranda)

Untuk Rak: localStorage diisi 2 entri — satu cover SEHAT (harus tampil gambar)
dan satu cover RUSAK/host mati (harus jadi placeholder, BUKAN ikon rusak).
Itu bukti langsung bahwa fallback onError bekerja di komponen nyata.
"""
import json
from playwright.sync_api import sync_playwright

EXE = "/home/tresna/.cache/ms-playwright/chromium_headless_shell-1249/chrome-headless-shell-linux64/chrome-headless-shell"
BASE = "http://localhost:8788"

RAK = {
    "favorites": {
        "sehat": {
            "title": "Cover Sehat",
            "cover_url": "https://thumbnail.komiku.org/uploads/manga/shimaichigai/manga_thumbnail-Manga-Shimaichigai.jpg",
            "handle": "komiku:4870",
            "source": "komiku",
            "title_key": "cover sehat",
            "loved_at": 1700000000,
        },
        "rusak": {
            "title": "Cover Rusak",
            "cover_url": "https://invalid.host.tidak.ada.example/x.jpg",
            "handle": "komiku:9999",
            "source": "komiku",
            "title_key": "cover rusak",
            "loved_at": 1700000001,
        },
    },
    "history": {},
}

PAGES = [
    ("beranda", "/"),
    ("cari", "/cari?q=necromancer"),
    ("manga-kiryuu", "/manga/kiryuu:solo-necromancer"),
    ("rak", "/rak"),
]

VIEWPORTS = [("desktop", 1280, 800, 1), ("mobile", 390, 844, 2)]


def audit(pg):
    return pg.evaluate("""() => {
      const imgs = [];
      for (const el of document.querySelectorAll('img')) {
        const r = el.getBoundingClientRect();
        if (r.width < 4 || r.height < 4) continue;
        const src = el.currentSrc || el.getAttribute('src') || '';
        imgs.push({
          src: src.slice(0, 70),
          nw: el.naturalWidth,
          complete: el.complete,
          brokenIconVisible: el.complete && el.naturalWidth === 0 && el.style.display !== 'none',
          w: Math.round(r.width), h: Math.round(r.height),
        });
      }
      const de = document.documentElement;
      let textOverflow = 0, clipped = 0;
      for (const el of document.querySelectorAll('h1,h2,h3,p,span,dd,dt,a,button,li')) {
        const cs = getComputedStyle(el);
        const r = el.getBoundingClientRect();
        if (r.width < 2 || r.height < 2) continue;
        if (el.scrollWidth > el.clientWidth + 2 && cs.overflow !== 'hidden' && cs.textOverflow !== 'ellipsis') {
          const t = (el.textContent || '').trim();
          if (t.length > 2) textOverflow++;
        }
        // teks terpotong vertikal (tinggi konten > tinggi kotak) tanpa scroll
        if (el.scrollHeight > el.clientHeight + 4 && cs.overflowY === 'hidden' && cs.textOverflow !== 'ellipsis') {
          const t = (el.textContent || '').trim();
          if (t.length > 2) clipped++;
        }
      }
      let smallTargets = [];
      for (const el of document.querySelectorAll('a,button')) {
        const r = el.getBoundingClientRect();
        if (r.width < 4 || r.height < 4) continue;
        if (r.width < 32 || r.height < 32) {
          smallTargets.push({ w: Math.round(r.width), h: Math.round(r.height),
                              label: el.getAttribute('aria-label') || (el.textContent||'').trim().slice(0,18) });
        }
      }
      return {
        imgTotal: imgs.length,
        brokenIconVisible: imgs.filter(i => i.brokenIconVisible).length,
        loaded: imgs.filter(i => i.nw > 0).length,
        overflowX: Math.max(0, de.scrollWidth - de.clientWidth),
        textOverflow, clipped, smallTargets,
      };
    }""")


out = []
with sync_playwright() as p:
    b = p.chromium.launch(executable_path=EXE, args=["--no-sandbox"])
    for vname, w, h, dpr in VIEWPORTS:
        ctx = b.new_context(viewport={"width": w, "height": h}, device_scale_factor=dpr)
        ctx.add_init_script(
            "try { localStorage.setItem('komik-rak-v1', %s); } catch(e) {}"
            % json.dumps(json.dumps(RAK))
        )
        pg = ctx.new_page()
        console = []
        pg.on("console", lambda m: console.append(m.text[:90]) if m.type == "error" else None)

        for pname, path in PAGES:
            pg.goto(BASE + path, wait_until="domcontentloaded", timeout=60000)
            pg.wait_for_timeout(4000)
            for _ in range(8):
                pg.mouse.wheel(0, 1200)
                pg.wait_for_timeout(300)
            pg.wait_for_timeout(2000)
            a = audit(pg)
            a["page"] = pname
            a["viewport"] = vname
            out.append(a)

        # interaksi: klik kartu hasil cari -> pindah ke /manga/
        pg.goto(BASE + "/cari?q=necromancer", wait_until="domcontentloaded", timeout=60000)
        pg.wait_for_timeout(4000)
        nav = pg.evaluate("""() => {
          const a = document.querySelector('a[href*="/manga/"]');
          return a ? { found: true, href: a.getAttribute('href') } : { found: false };
        }""")
        if nav.get("found"):
            before = pg.url
            pg.click('a[href*="/manga/"]', timeout=10000)
            pg.wait_for_timeout(3500)
            nav["navigated"] = pg.url != before
            nav["url"] = pg.url.replace(BASE, "")
            nav["coverAfterNav"] = pg.evaluate("""() => {
              const im = [...document.querySelectorAll('img')].filter(e => e.getBoundingClientRect().width > 8);
              return { n: im.length, broken: im.filter(e => e.complete && e.naturalWidth === 0).length };
            }""")
        out.append({"viewport": vname, "interaction": nav, "consoleErrors": console[:4]})
        ctx.close()
    b.close()

print(json.dumps(out, indent=1))
