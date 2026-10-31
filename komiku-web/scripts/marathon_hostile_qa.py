"""Adversarial QA fitur MARATON Komik Hub (hostile edge cases).

Skenario (wajib expected+observed+verdict):
  a. resume rantai tidak-full lalu scroll ke atas -> blok awal masih ada
  b. ekstrem: buka lalu langsung keluar tanpa scroll -> buka lagi di awal, tanpa crash
  c. ganti series A ke B -> posisi terisolasi (dua arah)
  d. F5 di tengah maraton -> pulih
  e. baca reader biasa lalu klik Maraton -> tidak crash & tidak menimpa posisi reader
  f. 'Mulai maraton dari awal' setelah 3+ blok -> reset ke blok pertama
  g. tombol Maraton di series: tanpa sesi mulai awal, dengan sesi lanjutkan
  h. cross-account: posisi tidak bocor antar akun

Verifikasi di surface DOM (bukan sekadar kode). Screenshot ke
C:/Users/LENOVO LEGION/AppData/Local/Temp/marathon_qa/

  python scripts/marathon_hostile_qa.py --base-url http://127.0.0.1:8788
"""
from __future__ import annotations
import argparse, json, os, sys, time
from playwright.sync_api import sync_playwright

BASE = "http://127.0.0.1:8788"
SHOTS = r"C:\Users\LENOVO LEGION\AppData\Local\Temp\marathon_qa"
H_A = "komiku:1284"
H_B = "shinigami:48270276-bd79-4a46-b15e-fdd2cf5655b1"
STORE = "komiku.web.marathon.v1"
ACCT = "komik-akun-v1"

POS_JS = """() => {
  const imgs = [...document.querySelectorAll('img[data-b], img[data-page]')].filter(i => i.offsetHeight > 0);
  const mid = window.scrollY + window.innerHeight / 2;
  let best = null, bestD = Infinity;
  for (const im of imgs) {
    const r = im.getBoundingClientRect();
    const d = Math.abs(r.top + window.scrollY + r.height / 2 - mid);
    if (d < bestD) { bestD = d; best = { src: im.getAttribute('src'), b: im.dataset.b, p: im.dataset.page }; }
  }
  const set = new Set([...document.querySelectorAll('img[data-b]')].map(i => Number(i.dataset.b)));
  return JSON.stringify({ scrollY: window.scrollY, innerHeight: window.innerHeight, mid,
    page: best, blocks: set.size });
}"""

BLOCKS_JS = """() => {
  const imgs=[...document.querySelectorAll('img[data-b]')].filter(i=>i.offsetHeight>0);
  const set=new Set(imgs.map(i=>Number(i.dataset.b)));
  return JSON.stringify({ blocks: set.size, maxB: set.size? Math.max(...set): -1, scrollY: window.scrollY });
}"""

MARATON_BTN_JS = """() => {
  const els=[...document.querySelectorAll('a')];
  const b=els.find(a => (a.textContent||'').trim() === 'Maraton');
  if(!b) return null;
  return JSON.stringify({ href: b.getAttribute('href'), title: b.getAttribute('title')||'', text: b.textContent.trim() });
}"""

passed: list[str] = []
failed: list[str] = []

def check(name, cond, extra="", shot=None):
    (passed if cond else failed).append(name)
    print(f"  {'PASS' if cond else 'FAIL'}  {name}" + (f"  [{extra}]" if extra else ""))
    return bool(cond)

def pos(page): return json.loads(page.evaluate(POS_JS))
def blocks(page): return json.loads(page.evaluate(BLOCKS_JS))
def stored(page, user=None):
    key = STORE if not user else f"{STORE}:{user}"
    raw = page.evaluate("(k)=>localStorage.getItem(k)", key)
    return json.loads(raw) if raw else []
def stored_for(page, handle, user=None):
    return [e for e in stored(page, user) if (e.get("seriesKey") or "") == handle]
def wait_btn(page, deadline=20):
    t = time.time() + deadline
    b = None
    while time.time() < t and not b:
        b = maraton_btn(page)
        if not b:
            page.wait_for_timeout(400)
    return b
def maraton_btn(page):
    r = page.evaluate(MARATON_BTN_JS)
    return json.loads(r) if r else None
def chapter_href_match(sess, href, handle):
    """href tombol Maraton = /maraton/{handle}/{number}. Ambil number dari
    chapterKey (setelah ':' terakhir) dan cocokkan, bukan substring penuh."""
    if not sess or not href:
        return False
    key = sess[0].get("chapterKey") or ""
    num = key.rsplit(":", 1)[-1] if ":" in key else key
    return f"/maraton/{handle}/{num}" in href

def same_place(a,b,tol=60):
    if not a.get("page") or not b.get("page"): return False
    if a["page"]["src"] != b["page"]["src"]: return False
    return abs(a["mid"]-b["mid"]) <= tol

def wait_page(page, deadline=60):
    t=time.time()+deadline
    while time.time()<t and not pos(page).get("page"):
        page.wait_for_timeout(400)
    return pos(page).get("page") is not None

def scroll_blocks(page, n, step=2200, pause=650):
    """gulir sampai jumlah blok unik >= n, tanpa menyentuh akhir (rantai tidak-full)."""
    t=time.time()+120
    b=blocks(page)
    while time.time()<t and b["blocks"]<n:
        page.evaluate("()=>window.scrollBy(0, %d)"%step)
        page.wait_for_timeout(pause)
        b=blocks(page)
    return b

def open_marathon(page, handle, num, deadline=60):
    page.goto(f"{BASE}/maraton/{handle}/{num}", wait_until="domcontentloaded")
    return wait_page(page, deadline)

def series_page(page, handle):
    page.goto(f"{BASE}/manga/{handle}", wait_until="domcontentloaded")
    page.wait_for_timeout(1200)

def login(page, u):
    page.goto(BASE + "/", wait_until="domcontentloaded")  # pastikan origin valid utk localStorage
    page.evaluate("(u)=>{localStorage.setItem('komik-akun-v1', u)}", u)
    page.reload(wait_until="domcontentloaded")

def chapter_num(page, handle):
    import urllib.request
    with urllib.request.urlopen(f"{BASE}/api/unified/series/{handle}", timeout=30) as r:
        s=json.loads(r.read())
    ch=s.get("chapters") or []
    assert ch, f"series {handle} tanpa chapter"
    return ch[-1]["number"], ch[len(ch)//2]["number"], ch

def main():
    ap=argparse.ArgumentParser(prog="marathon_hostile_qa.py")
    ap.add_argument("--base-url", default=BASE)
    args=ap.parse_args()
    os.makedirs(SHOTS, exist_ok=True)

    with sync_playwright() as p:
        browser=p.chromium.launch(headless=True)

        # ---------- a. resume rantai tidak-full, scroll ke atas, blok awal ada ----------
        print("\n=== a. resume tidak-full + scroll ke atas ===")
        ctx=browser.new_context(viewport={"width":420,"height":820}, locale="id-ID", service_workers="block")
        pg=ctx.new_page(); errs=[]; pg.on("pageerror", lambda e: errs.append(str(e)))
        oldA, midA, _ = chapter_num(pg, H_A)
        open_marathon(pg, H_A, oldA)
        scroll_blocks(pg, 3)   # rantai 3 blok, tidak-full
        b3=blocks(pg)
        check("a.setup: rantai >= 3 blok", b3["blocks"]>=3, f"blocks={b3['blocks']}")
        pg.evaluate("()=>window.scrollTo(0,0)"); pg.wait_for_timeout(1200)
        btop=blocks(pg)
        check("a.scroll atas: blok awal masih ada di DOM", btop["blocks"]>=1 and btop["maxB"]>=0 and btop["scrollY"]<50, f"scrollY={btop['scrollY']:.0f} blocks={btop['blocks']}")
        first=pg.query_selector('img[data-b="0"]')
        vis = bool(first) and bool(pg.evaluate("(el)=>el.offsetHeight>0", first))
        check("a.head block pertama terlihat (offsetHeight>0)", vis)
        check("a.tanpa pageerror", not errs, "; ".join(errs[:2]))
        pg.screenshot(path=SHOTS+"/a-scroll-atas-blok-awal.png"); ctx.close()

        # ---------- b. buka->langsung keluar tanpa scroll -> buka lagi di awal ----------
        print("\n=== b. ekstrem: buka lalu keluar tanpa scroll ===")
        ctx=browser.new_context(viewport={"width":420,"height":820}, locale="id-ID", service_workers="block")
        pg=ctx.new_page(); errs=[]; pg.on("pageerror", lambda e: errs.append(str(e)))
        open_marathon(pg, H_A, oldA)
        pg.goto(BASE+"/", wait_until="domcontentloaded")   # keluar tanpa scroll
        pg.wait_for_timeout(800)
        open_marathon(pg, H_A, oldA)
        pg.wait_for_timeout(1500)
        p2=pos(pg); b2=blocks(pg)
        check("b.buka ulang: tetap di awal (blok pertama)", b2["blocks"]>=1 and (p2["page"] is None or str(p2["page"]["b"])=="0"), f"blocks={b2['blocks']} scrollY={p2['scrollY']:.0f}")
        check("b.scrollY dekat puncak (bukan di tengah rantai)", p2["scrollY"]<6000, f"scrollY={p2['scrollY']:.0f}")
        check("b.maraton termuat tanpa crash", bool(p2.get("page")), "-")
        check("b.tanpa pageerror", not errs, "; ".join(errs[:2]))
        pg.screenshot(path=SHOTS+"/b-buka-lagi-awal.png"); ctx.close()

        # ---------- c. ganti series A->B: posisi terisolasi ----------
        print("\n=== c. ganti series A->B, posisi terisolasi ===")
        ctx=browser.new_context(viewport={"width":420,"height":820}, locale="id-ID", service_workers="block")
        pg=ctx.new_page(); errs=[]; pg.on("pageerror", lambda e: errs.append(str(e)))
        oldA, _, _ = chapter_num(pg, H_A)
        oldB, _, _ = chapter_num(pg, H_B)
        open_marathon(pg, H_A, oldA); scroll_blocks(pg, 2)
        check("c.setup: sesi A tersimpan", bool(stored_for(pg, H_A)))
        series_page(pg, H_B)
        btn=wait_btn(pg)
        check("c.series B tanpa sesi: tombol 'Mulai'", btn and "Mulai" in (btn["title"] or ""), f"title={btn and btn['title']}")
        check("c.series B tanpa sesi: href ke chapter awal B", btn and f"/maraton/{H_B}" in btn["href"], f"href={btn and btn['href']}")
        # buat sesi B (posisi beda)
        open_marathon(pg, H_B, oldB); scroll_blocks(pg, 2)
        check("c.setup: sesi B tersimpan", bool(stored_for(pg, H_B)))
        # balik ke A
        series_page(pg, H_A)
        btnA=wait_btn(pg); sessA=stored_for(pg, H_A)
        check("c.series A dgn sesi: tombol 'Lanjutkan'", btnA and sessA and "Lanjutkan" in (btnA["title"] or ""), f"title={btnA and btnA['title']}")
        check("c.series A dgn sesi: href ke sesi A", btnA and sessA and chapter_href_match(sessA, btnA["href"], H_A), f"href={btnA and btnA['href']} key={sessA and sessA[0]['chapterKey']}")
        # series B masih punya sesi sendiri (terisolasi dari A)
        series_page(pg, H_B)
        btnB=wait_btn(pg); sessB=stored_for(pg, H_B)
        check("c.series B dgn sesi: href ke sesi B (bukan A)", btnB and sessB and chapter_href_match(sessB, btnB["href"], H_B), f"href={btnB and btnB['href']} key={sessB and sessB[0]['chapterKey']}")
        check("c.tanpa pageerror", not errs, "; ".join(errs[:2]))
        pg.screenshot(path=SHOTS+"/c-isolasi-series.png"); ctx.close()

        # ---------- d. F5 di tengah maraton tetap pulih ----------
        print("\n=== d. F5 di tengah maraton ===")
        ctx=browser.new_context(viewport={"width":420,"height":820}, locale="id-ID", service_workers="block")
        pg=ctx.new_page(); errs=[]; pg.on("pageerror", lambda e: errs.append(str(e)))
        open_marathon(pg, H_A, oldA)
        scroll_blocks(pg, 2)
        pg.evaluate("()=>window.scrollBy(0,3000)"); pg.wait_for_timeout(1200)
        before=pos(pg)
        check("d.setup: posisi di tengah", before["scrollY"]>500, f"scrollY={before['scrollY']:.0f}")
        pg.keyboard.press("F5"); pg.wait_for_timeout(2000)
        t=time.time()+60; after=pos(pg)
        while time.time()<t and not same_place(before, after):
            pg.wait_for_timeout(500); after=pos(pg)
        check("d.F5: pulih ke halaman sama", same_place(before,after), f"bsrc={before['page'] and before['page']['src'][-20:]} asrc={after['page'] and after['page']['src'][-20:]}")
        check("d.scrollY tetap dalam", after["scrollY"]>500, f"scrollY={after['scrollY']:.0f}")
        check("d.tanpa pageerror", not errs, "; ".join(errs[:2]))
        pg.screenshot(path=SHOTS+"/d-f5-pulih.png"); ctx.close()

        # ---------- e. reader biasa -> klik Maraton: tidak crash & tidak menimpa reader ----------
        print("\n=== e. reader biasa lalu Maraton ===")
        ctx=browser.new_context(viewport={"width":420,"height":820}, locale="id-ID", service_workers="block")
        pg=ctx.new_page(); errs=[]; pg.on("pageerror", lambda e: errs.append(str(e)))
        oldA, midA, _ = chapter_num(pg, H_A)
        # baca reader biasa
        pg.goto(f"{BASE}/baca/{H_A}/{midA}", wait_until="domcontentloaded")
        t=time.time()+45
        while time.time()<t and not pos(pg).get("page"): pg.wait_for_timeout(400)
        pg.evaluate("()=>window.scrollBy(0,4000)"); pg.wait_for_timeout(1200)
        r_before=pos(pg)
        check("e.setup: reader termuat & scroll", bool(r_before.get("page")) and r_before["scrollY"]>500, f"scrollY={r_before['scrollY']:.0f}")
        # ke series, klik Maraton
        series_page(pg, H_A)
        btn=wait_btn(pg)
        check("e.series: tombol Maraton ada", btn is not None, "-")
        if btn:
            pg.evaluate("(href)=>{const a=[...document.querySelectorAll('a')].find(x=>x.getAttribute('href')===href); if(a)a.click()}", btn["href"])
            pg.wait_for_timeout(2500)
            check("e.maraton terbuka tanpa crash", "/maraton/" in pg.url and wait_page(pg), pg.url)
            check("e.tanpa pageerror saat maraton", not errs, "; ".join(errs[:2]))
            # balik ke reader chapter yang sama -> posisi reader harus tetap (tak tertimpa)
            pg.goto(f"{BASE}/baca/{H_A}/{midA}", wait_until="domcontentloaded")
            t=time.time()+45
            while time.time()<t and not pos(pg).get("page"): pg.wait_for_timeout(400)
            pg.wait_for_timeout(2000)
            r_after=pos(pg)
            check("e.reader kembali ke posisi sama (tak tertimpa maraton)", same_place(r_before, r_after, tol=80), f"mid={r_before['mid']:.0f}->{r_after['mid']:.0f}")
        pg.screenshot(path=SHOTS+"/e-reader-tak-tertimpa.png"); ctx.close()

        # ---------- f. Mulai maraton dari awal setelah 3+ blok ----------
        print("\n=== f. Mulai maraton dari awal setelah 3+ blok ===")
        ctx=browser.new_context(viewport={"width":420,"height":820}, locale="id-ID", service_workers="block")
        pg=ctx.new_page(); errs=[]; pg.on("pageerror", lambda e: errs.append(str(e)))
        open_marathon(pg, H_A, oldA)
        b=scroll_blocks(pg, 3)
        st=stored_for(pg, H_A)
        check("f.setup: 3+ blok tersimpan", st and st[0]["blocks"]>=3, f"blocks={st and st[0]['blocks']}")
        # menu -> Preferensi -> Mulai maraton dari awal
        pg.evaluate("()=>window.scrollTo(0,0)"); pg.wait_for_timeout(1000)
        pg.evaluate("""()=>{const b=document.querySelector('header button[aria-label="Menu"]'); if(b)b.click();}""")
        pg.wait_for_timeout(800)
        pg.evaluate("""()=>{const b=[...document.querySelectorAll('button')].find(x=>(x.textContent||'').includes('Preferensi')); if(b)b.click();}""")
        pg.wait_for_timeout(800)
        pg.evaluate("""()=>{const e=[...document.querySelectorAll('div[role="button"],button')].find(x=>(x.textContent||'').includes('Mulai maraton dari awal')); if(e)e.click();}""")
        pg.wait_for_timeout(3000)
        after_st=stored_for(pg, H_A)
        check("f.posisi maraton dihapus", not after_st, f"sisa {len(after_st)} entri")
        pb=pos(pg)
        check("f.kembali ke blok pertama (scrollY 0)", pb["scrollY"]<300, f"scrollY={pb['scrollY']:.0f}")
        bb=blocks(pg)
        check("f.hanya blok pertama termuat", bb["maxB"]<=0, f"maxB={bb['maxB']}")
        check("f.tanpa pageerror", not errs, "; ".join(errs[:2]))
        pg.screenshot(path=SHOTS+"/f-restart-awal.png"); ctx.close()

        # ---------- g. tombol Maraton: tanpa sesi mulai awal, dengan sesi lanjutkan ----------
        print("\n=== g. tombol Maraton series: tanpa/dgn sesi ===")
        ctx=browser.new_context(viewport={"width":420,"height":820}, locale="id-ID", service_workers="block")
        pg=ctx.new_page(); errs=[]; pg.on("pageerror", lambda e: errs.append(str(e)))
        # tanpa sesi
        series_page(pg, H_A)
        btn=wait_btn(pg)
        check("g.tanpa sesi: tombol ada & 'Mulai'", btn and "Mulai" in (btn["title"] or ""), f"title={btn and btn['title']}")
        check("g.tanpa sesi: href chapter awal", btn and f"/maraton/{H_A}/{oldA}" in btn["href"], f"href={btn and btn['href']}")
        if btn:
            pg.evaluate("(href)=>{const a=[...document.querySelectorAll('a')].find(x=>x.getAttribute('href')===href); if(a)a.click()}", btn["href"])
            pg.wait_for_timeout(2500)
            check("g.tanpa sesi: klik mulai dari awal (scrollY 0)", "/maraton/" in pg.url and pos(pg)["scrollY"]<300, f"scrollY={pos(pg)['scrollY']:.0f}")
        # dengan sesi
        scroll_blocks(pg, 2); pg.evaluate("()=>window.scrollBy(0,3000)"); pg.wait_for_timeout(1200)
        series_page(pg, H_A)
        btn2=wait_btn(pg); sess=stored_for(pg, H_A)
        check("g.dgn sesi: tombol 'Lanjutkan'", btn2 and "Lanjutkan" in (btn2["title"] or ""), f"title={btn2 and btn2['title']}")
        check("g.dgn sesi: href = sesi tersimpan", btn2 and sess and chapter_href_match(sess, btn2["href"], H_A), f"href={btn2 and btn2['href']}")
        if btn2 and sess:
            pg.evaluate("(href)=>{const a=[...document.querySelectorAll('a')].find(x=>x.getAttribute('href')===href); if(a)a.click()}", btn2["href"])
            pg.wait_for_timeout(2500)
            pv=pos(pg)
            check("g.dgn sesi: klik lanjutkan ke posisi tersimpan", "/maraton/" in pg.url and pv["scrollY"]>500, f"scrollY={pv['scrollY']:.0f}")
        check("g.tanpa pageerror", not errs, "; ".join(errs[:2]))
        pg.screenshot(path=SHOTS+"/g-series-btn-maraton.png"); ctx.close()

        # ---------- h. cross-account: posisi tidak bocor ----------
        print("\n=== h. cross-account posisi tidak bocor ===")
        ctx=browser.new_context(viewport={"width":420,"height":820}, locale="id-ID", service_workers="block")
        pg=ctx.new_page(); errs=[]; pg.on("pageerror", lambda e: errs.append(str(e)))
        ua, ub = "qa_hostile_a", "qa_hostile_b"
        # akun A buat sesi maraton
        login(pg, ua)
        pg.goto(f"{BASE}/maraton/{H_A}/{oldA}", wait_until="domcontentloaded")
        scroll_blocks(pg, 2)
        check("h.setup: sesi A tersimpan utk akun A", bool(stored(pg, ua)), f"{len(stored(pg,ua))} entri")
        # pindah ke akun B
        login(pg, ub)
        check("h.akun B: storage maraton kosong", not stored(pg, ub), "-")
        series_page(pg, H_A)
        btn=wait_btn(pg)
        check("h.akun B: series A tampil 'Mulai' (tak bocor)", btn and "Mulai" in (btn["title"] or ""), f"title={btn and btn['title']}")
        # Home: FAB tidak boleh nuduh maraton A
        pg.goto(BASE+"/", wait_until="domcontentloaded"); pg.wait_for_timeout(2000)
        fab=pg.query_selector('a[aria-label="Lanjut baca"]')
        fab_href = fab.get_attribute("href") if fab else None
        check("h.akun B: FAB tidak nuduh /maraton/", not fab_href or "/maraton/" not in fab_href, str(fab_href))
        # balik ke A -> sesi tetap ada
        login(pg, ua)
        series_page(pg, H_A)
        btnA=wait_btn(pg); sessA=stored_for(pg, H_A, ua)
        check("h.akun A: sesi tetap ada (Lanjutkan)", btnA and sessA and "Lanjutkan" in (btnA["title"] or ""), f"title={btnA and btnA['title']}")
        check("h.tanpa pageerror", not errs, "; ".join(errs[:2]))
        pg.screenshot(path=SHOTS+"/h-cross-account.png"); ctx.close()

        browser.close()

    print(f"\n{len(passed)}/{len(passed)+len(failed)} passed")
    for f in failed: print("  FAIL:", f)
    print("SHOTS:", SHOTS)
    return 1 if failed else 0

if __name__ == "__main__":
    sys.exit(main())
