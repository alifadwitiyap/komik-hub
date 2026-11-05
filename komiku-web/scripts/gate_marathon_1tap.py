#!/usr/bin/env python3
"""GERBANG REGRESI — bug "1-tap" tombol maraton + invarian yang tidak boleh rusak.

Latar
-----
Di build BASELINE, tombol toggle maraton (`Masuk`/`Keluar`) ikut disembunyikan
oleh `useChromeOnScroll`. Saat chrome tersembunyi tombol mendapat
`opacity-0` + `pointer-events-none` + `inert`, sehingga tap pertama TIDAK
pernah sampai ke tombol: tap itu mendarat di lapisan `*-tap-layer` (z-10) yang
justru memunculkan chrome. Akibatnya user butuh 2 tap.

Gerbang ini mengunci dua hal sekaligus.

BUG — harus GAGAL di baseline, harus LULUS setelah perbaikan
  B01  SATU tap tombol maraton saat chrome tersembunyi   -> /maraton/
  B02  SATU tap "Keluar maraton" saat chrome tersembunyi -> /baca/

GUARD — harus LULUS di baseline DAN setelah perbaikan (yang tidak boleh rusak)
  G01  geometri tombol idle 44x44 CSS px
  G02  geometri tombol aktif ("Keluar") >= 44x44 px
  G03  tombol maraton & tombol layar penuh tidak bertumpuk
  G04  tap area baca: tap tengah -> chrome tersembunyi
  G05  tap area baca: tap tengah -> chrome muncul kembali
  G06  gesture gulir DIMULAI DI ATAS TOMBOL (chrome tampil) -> menggulir, tanpa aktivasi
  G07  gesture gulir DIMULAI DI ATAS TOMBOL (chrome sembunyi) -> menggulir, tanpa aktivasi
  G08  chrome menyembunyikan diri saat scroll turun (opacity)
  G09  chrome muncul lagi saat scroll naik
  G10  pemulihan: tap berikutnya tetap bisa masuk maraton (user tidak terjebak)
  G11  pemulihan: tap berikutnya tetap bisa keluar maraton
  G12  tap tombol saat chrome TAMPIL tetap 1 tap (jalur normal tidak rusak)

Catatan desain (kenapa begini, bukan sebaliknya)
------------------------------------------------
1. G08 sengaja HANYA mengunci `opacity`. `pointer-events`/`inert` saat chrome
   tersembunyi TIDAK dikunci, karena justru di situ akar bug: perbaikan yang
   benar hampir pasti mengubahnya (mis. `pointer-events:auto` tanpa `inert`,
   atau zona aman di atas tap-layer). Mengunci nilai lama = gerbang mustahil lulus.
2. G06/G07 ada karena fix termudah yang SALAH adalah mematikan scroll saat jari
   menyentuh tombol (`touch-action:none` / `preventDefault`). Itu membuat 1 tap
   berhasil tetapi merusak kebiasaan menggulir dari mana saja — regresi yang
   dicegah di sini.
3. `page.click()` tidak dipakai: Playwright menolak mengklik elemen
   ber-`pointer-events:none`, sehingga justru menyembunyikan bug yang dialami
   jempol manusia.

Mode
----
  (default)      mode "fix" : lulus bila 1 tap sudah berfungsi (untuk CI setelah fix)
  --expect-bug   mode "bug" : lulus bila bug MASIH ADA (untuk membuktikan baseline)

Kode keluar
-----------
  0  semua asersi untuk mode ini terpenuhi
  1  bug masih ada padahal mode "fix"   (normal saat dijalankan di baseline)
  2  ada GUARD yang rusak               -> REGRESI perilaku yang dilindungi
  3  harness gagal (halaman tidak siap / tombol tidak ada) -> hasil tidak sah

Pemakaian
---------
  python scripts/gate_marathon_1tap.py http://127.0.0.1:8788 --expect-bug
  python scripts/gate_marathon_1tap.py http://127.0.0.1:8788
  python scripts/gate_marathon_1tap.py http://127.0.0.1:8788 --json hasil.json
  BASE_URL=https://staging.example python scripts/gate_marathon_1tap.py
  python scripts/gate_marathon_1tap.py URL --desktop
  python scripts/gate_marathon_1tap.py URL --viewports 412x915,390x844

Metode
------
Gesture SENTUH SUNGGUHAN lewat CDP `Input.dispatchTouchEvent`
(touchStart/touchMove/touchEnd) -> Chromium menghasilkan PointerEvent
`pointerType='touch'` + TouchEvent asli. Mode `--desktop` memakai
`Input.dispatchMouseEvent` (klik) + `mouseWheel` (gulir), sebab drag mouse
tidak menggulir halaman.
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import time
import traceback

from playwright.sync_api import sync_playwright

HANDLE = "komiku:1284"
CH = "157"
BTN = 'button[data-testid="reader-marathon-toggle"]'
MIN_TOUCH = 44
READER_URL = f"/baca/{HANDLE}/{CH}"
MARATHON_URL = f"/maraton/{HANDLE}/{CH}"

# --------------------------------------------------------------------------
# Instrumentasi: hanya MENDENGARKAN (capture, passive) — tidak mengubah produk.
# --------------------------------------------------------------------------
INIT_JS = r"""
window.__g = {events: [], mark: 'init'};
const push = (e) => {
  if (window.__g.events.length > 4000) return;
  const t = e.target;
  window.__g.events.push({
    m: window.__g.mark,
    t: e.type,
    pt: e.pointerType || null,
    x: e.clientX != null ? Math.round(e.clientX) : null,
    y: e.clientY != null ? Math.round(e.clientY) : null,
    sy: Math.round(window.scrollY),
    ts: Math.round(performance.now()),
    tgt: t ? (t.tagName + (t.dataset && t.dataset.testid ? '[' + t.dataset.testid + ']' : '')) : null,
    onBtn: !!(t && t.closest && t.closest('button[data-testid="reader-marathon-toggle"]')),
    onLayer: !!(t && t.dataset && /-tap-layer$/.test(t.dataset.testid || '')),
  });
};
for (const n of ['touchstart','touchmove','touchend','pointerdown','pointerup','click']) {
  window.addEventListener(n, push, {capture: true, passive: true});
}
"""

STATE_JS = r"""() => {
  const b = document.querySelector('button[data-testid="reader-marathon-toggle"]');
  const fs = document.querySelector('button[data-testid="reader-fullscreen-toggle"]');
  const box = (el) => {
    const r = el.getBoundingClientRect();
    return {x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height),
            right: Math.round(r.right), bottom: Math.round(r.bottom)};
  };
  const out = {
    path: location.pathname,
    scrollY: Math.round(window.scrollY),
    scrollH: document.documentElement.scrollHeight,
    vw: innerWidth, vh: innerHeight,
    overflowX: Math.max(0, document.documentElement.scrollWidth - document.documentElement.clientWidth),
    scripts: [...document.querySelectorAll('script[src]')].map(s => s.getAttribute('src')),
  };
  if (!b) { out.present = false; return out; }
  const cs = getComputedStyle(b);
  const r = b.getBoundingClientRect();
  const cx = r.x + r.width / 2, cy = r.y + r.height / 2;
  const top = document.elementFromPoint(cx, cy);
  Object.assign(out, {
    present: true,
    label: b.getAttribute('aria-label'),
    opacity: Number(cs.opacity),
    pointerEvents: cs.pointerEvents,
    inert: b.hasAttribute('inert'),
    ariaHidden: b.getAttribute('aria-hidden'),
    rect: box(b),
    cx: Math.round(cx), cy: Math.round(cy),
    topEl: top ? (top.tagName + (top.dataset && top.dataset.testid ? '[' + top.dataset.testid + ']' : '')) : null,
    hitsButton: !!(top && (top === b || b.contains(top))),
    fs: fs ? box(fs) : null,
  });
  return out;
}"""


# ------------------------------------------------------------------- drivers
class TouchDriver:
    """Jempol sungguhan: touchStart / touchMove / touchEnd lewat CDP."""
    kind = "touch"

    def __init__(self, cdp):
        self.cdp = cdp

    def tap(self, x, y, hold_ms=70):
        self.cdp.send("Input.dispatchTouchEvent", {
            "type": "touchStart",
            "touchPoints": [{"x": x, "y": y, "id": 1, "radiusX": 11, "radiusY": 11, "force": 1}],
        })
        time.sleep(hold_ms / 1000)
        self.cdp.send("Input.dispatchTouchEvent", {"type": "touchEnd", "touchPoints": []})

    def swipe(self, x, y0, y1, steps=12, step_ms=16, hold_ms=110):
        """Drag jari bertahap lalu DITAHAN sebelum lepas (tanpa momentum)."""
        self.cdp.send("Input.dispatchTouchEvent", {
            "type": "touchStart",
            "touchPoints": [{"x": x, "y": y0, "id": 1, "radiusX": 11, "radiusY": 11, "force": 1}],
        })
        for i in range(1, steps + 1):
            f = i / steps
            self.cdp.send("Input.dispatchTouchEvent", {
                "type": "touchMove",
                "touchPoints": [{"x": x, "y": y0 + (y1 - y0) * f, "id": 1,
                                 "radiusX": 11, "radiusY": 11, "force": 1}],
            })
            time.sleep(step_ms / 1000)
        time.sleep(hold_ms / 1000)
        self.cdp.send("Input.dispatchTouchEvent", {"type": "touchEnd", "touchPoints": []})


class MouseDriver:
    """Mouse desktop: klik koordinat + wheel (drag mouse tidak menggulir halaman)."""
    kind = "mouse"

    def __init__(self, cdp):
        self.cdp = cdp

    def tap(self, x, y, hold_ms=40):
        self.cdp.send("Input.dispatchMouseEvent", {
            "type": "mouseMoved", "x": x, "y": y, "button": "none"})
        self.cdp.send("Input.dispatchMouseEvent", {
            "type": "mousePressed", "x": x, "y": y, "button": "left", "clickCount": 1})
        time.sleep(hold_ms / 1000)
        self.cdp.send("Input.dispatchMouseEvent", {
            "type": "mouseReleased", "x": x, "y": y, "button": "left", "clickCount": 1})

    def swipe(self, x, y0, y1, steps=12, step_ms=16, hold_ms=110):
        """Padanan gulir untuk mouse: wheel bertahap pada titik (x, y0)."""
        total = y0 - y1                      # drag ke atas == gulir ke bawah (deltaY positif)
        n = max(1, min(steps, 8))
        for _ in range(n):
            self.cdp.send("Input.dispatchMouseEvent", {
                "type": "mouseWheel", "x": x, "y": y0,
                "deltaX": 0, "deltaY": total / n, "button": "none"})
            time.sleep(step_ms / 1000)


# -------------------------------------------------------------------- helpers
def mark(pg, m):
    pg.evaluate("(m) => { window.__g.mark = m; window.__g.events = []; }", m)


def drain(pg):
    ev = pg.evaluate("window.__g.events")
    pg.evaluate("window.__g.events = []")
    return ev


def wait_js(pg, expr, timeout=10000, poll=80):
    """Tunggu kondisi (bukan sleep buta). False kalau habis waktu."""
    try:
        pg.wait_for_function(expr, timeout=timeout, polling=poll)
        return True
    except Exception:
        return False


def state(pg):
    return pg.evaluate(STATE_JS)


def overlaps(a, b):
    if not a or not b:
        return 0
    ox = max(0, min(a["right"], b["right"]) - max(a["x"], b["x"]))
    oy = max(0, min(a["bottom"], b["bottom"]) - max(a["y"], b["y"]))
    return ox * oy


# -------------------------------------------------------------------- results
class Gate:
    def __init__(self):
        self.rows = []

    def add(self, cid, viewport, kind, name, ok, detail, evidence=None):
        self.rows.append({"id": cid, "viewport": viewport, "kind": kind, "name": name,
                          "ok": bool(ok), "detail": detail, "evidence": evidence or {}})
        tag = "PASS" if ok else "FAIL"
        print(f"  [{tag}] {cid} ({kind:5s}) {name}")
        if not ok:
            print(f"         -> {detail}")
        return ok

    def of(self, kind):
        return [r for r in self.rows if r["kind"] == kind]


# ------------------------------------------------------------------ scenarios
def open_reader(pg, base):
    pg.goto(f"{base}{READER_URL}", wait_until="domcontentloaded", timeout=60000)
    if not wait_js(pg, f"() => !!document.querySelector('{BTN}')", timeout=45000):
        raise RuntimeError("tombol maraton tidak muncul di /baca (halaman tidak siap)")
    if not wait_js(pg, "() => document.documentElement.scrollHeight > 2500", timeout=30000):
        raise RuntimeError("halaman baca tidak punya tinggi scroll (gambar tidak termuat?)")
    wait_js(pg, "() => document.querySelectorAll('img').length > 3", timeout=15000)
    pg.wait_for_timeout(500)


def open_marathon(pg, base):
    pg.goto(f"{base}{MARATHON_URL}", wait_until="domcontentloaded", timeout=60000)
    ready = (
        "() => { const b = document.querySelector('%s');"
        " return !!b && b.getAttribute('aria-label') === 'Keluar maraton'; }" % BTN
    )
    if not wait_js(pg, ready, timeout=45000):
        raise RuntimeError("tombol 'Keluar maraton' tidak muncul di /maraton")
    if not wait_js(pg, "() => document.documentElement.scrollHeight > 2500", timeout=30000):
        raise RuntimeError("halaman maraton tidak punya tinggi scroll")
    pg.wait_for_timeout(600)


def scroll_hidden(pg, drv, vw, vh):
    """Gulir turun sampai chrome menyembunyikan diri (opacity <= 0.05)."""
    for _ in range(3):
        drv.swipe(vw // 2, int(vh * 0.75), int(vh * 0.28), steps=12)
        pg.wait_for_timeout(600)
        s = state(pg)
        if s.get("opacity", 1) <= 0.05:
            drain(pg)
            return s
    drain(pg)
    return state(pg)


def scroll_visible(pg, drv, vw, vh):
    """Gulir naik sampai chrome kembali (opacity >= 0.95)."""
    for _ in range(3):
        drv.swipe(vw // 2, int(vh * 0.30), int(vh * 0.78), steps=12)
        pg.wait_for_timeout(600)
        s = state(pg)
        if s.get("opacity", 0) >= 0.95:
            drain(pg)
            return s
    drain(pg)
    return state(pg)


def tap_area_toggle(pg, drv, vw, vh, want_visible):
    """Tap di area baca (tengah layar) sampai chrome mencapai kondisi yang diminta."""
    cands = [(vw // 2, int(vh * 0.45)), (vw // 2, int(vh * 0.55)),
             (vw // 2, int(vh * 0.35)), (vw // 2, int(vh * 0.62))]
    target = ("() => { const b = document.querySelector('%s');"
              " const o = b ? Number(getComputedStyle(b).opacity) : -1;"
              " return %s; }" % (BTN, "o >= 0.95" if want_visible else "o <= 0.05"))
    last = {}
    for (x, y) in cands:
        hit = pg.evaluate("""([x,y]) => {
            const el = document.elementFromPoint(x,y);
            return el ? (el.tagName + (el.dataset && el.dataset.testid ? '['+el.dataset.testid+']' : '')) : null;
        }""", [x, y])
        if not hit or "tap-layer" not in hit:
            last = {"point": [x, y], "hit": hit, "reason": "bukan tap-layer"}
            continue
        mark(pg, f"tap-area-{'show' if want_visible else 'hide'}")
        drv.tap(x, y)
        if wait_js(pg, target, timeout=3000):
            ev = drain(pg)
            clicks = [e for e in ev if e["t"] == "click"]
            pg.wait_for_timeout(320)      # biarkan transisi 200ms selesai -> angka stabil
            return True, {"point": [x, y], "hit": hit,
                          "click_targets": [c["tgt"] for c in clicks],
                          "on_layer": any(c["onLayer"] for c in clicks),
                          "opacity": state(pg).get("opacity")}
        ev = drain(pg)
        last = {"point": [x, y], "hit": hit,
                "click_targets": [e["tgt"] for e in ev if e["t"] == "click"],
                "opacity": state(pg).get("opacity")}
    return False, last


def scroll_over_button(pg, drv, vw, vh, dy, label):
    """Gulir yang DIMULAI tepat di tengah tombol; harus menggulir, bukan mengaktifkan."""
    s0 = state(pg)
    if not s0.get("present"):
        return {"error": "tombol tidak ada", "delta": 0, "clicks": 0,
                "click_targets": [], "click_on_button": False, "path": s0.get("path")}
    x = s0["cx"]
    y = s0["rect"]["y"] + s0["rect"]["h"] // 2
    mark(pg, label)
    drv.swipe(x, y, y - dy, steps=12)
    pg.wait_for_timeout(700)
    ev = drain(pg)
    s1 = state(pg)
    clicks = [e for e in ev if e["t"] == "click"]
    return {
        "start": [x, y], "dy": dy,
        "scroll_before": s0["scrollY"], "scroll_after": s1["scrollY"],
        "delta": s1["scrollY"] - s0["scrollY"],
        "clicks": len(clicks), "click_targets": [c["tgt"] for c in clicks],
        "click_on_button": any(c["onBtn"] for c in clicks),
        "path": s1["path"],
    }


def taps_to_act(pg, drv, want_prefix, max_taps=4):
    """Tap tombol berulang; catat butuh berapa tap sampai path berubah."""
    log = []
    for i in range(1, max_taps + 1):
        s = state(pg)
        if not s.get("present"):
            return None, log
        mark(pg, f"tap{i}")
        drv.tap(s["cx"], s["cy"])
        pg.wait_for_timeout(1500)
        ev = drain(pg)
        s2 = state(pg)
        clicks = [e for e in ev if e["t"] == "click"]
        log.append({
            "tap": i,
            "before": {"opacity": s["opacity"], "pointerEvents": s["pointerEvents"],
                       "inert": s["inert"], "hitsButton": s["hitsButton"], "topEl": s["topEl"]},
            "click_targets": [c["tgt"] for c in clicks],
            "click_on_button": any(c["onBtn"] for c in clicks),
            "click_on_tap_layer": any(c["onLayer"] for c in clicks),
            "after_path": s2.get("path"), "after_opacity": s2.get("opacity"),
        })
        if str(s2.get("path", "")).startswith(want_prefix):
            return i, log
    return None, log


def describe_failure(log, n, what):
    """Kalimat bukti: berapa tap, tap pertama mendarat di mana, state CSS-nya."""
    if not log:
        return f"tidak ada event tap tercatat — {what}"
    first = log[0]
    taps = n if n else f">{len(log)}"
    return ("butuh %s tap (bukan 1); tap#1 mendarat di %s "
            "(opacity=%s, pointer-events=%s, inert=%s) — %s"
            % (taps, first["click_targets"] or ["<tanpa click>"],
               first["before"]["opacity"], first["before"]["pointerEvents"],
               first["before"]["inert"], what))


# --------------------------------------------------------------- main runner
def run_viewport(p, base, vw, vh, drv_kind, headed, g: Gate):
    vid = f"{vw}x{vh}"
    print(f"\n########## VIEWPORT {vid} ({drv_kind}) ##########")
    b = p.chromium.launch(args=["--no-sandbox"], headless=not headed)
    ctx = b.new_context(
        viewport={"width": vw, "height": vh},
        is_mobile=(drv_kind == "touch"),
        has_touch=(drv_kind == "touch"),
        service_workers="block", locale="id-ID",
    )
    pg = ctx.new_page()
    pg.add_init_script(INIT_JS)
    cdp = ctx.new_cdp_session(pg)
    drv = TouchDriver(cdp) if drv_kind == "touch" else MouseDriver(cdp)
    ex = {"viewport": vid, "driver": drv_kind}
    try:
        # ---------------------------------------------- B02 dulu (halaman /maraton)
        open_marathon(pg, base)
        mfresh = state(pg)
        mr = mfresh.get("rect") or {}
        g.add("G02", vid, "GUARD", "geometri tombol aktif ('Keluar') >= 44x44 px",
              mr.get("h", 0) >= MIN_TOUCH and mr.get("w", 0) >= MIN_TOUCH,
              f"rect={mr} label={mfresh.get('label')} (butuh w>=44 & h>=44)",
              {"rect": mr, "label": mfresh.get("label"), "min": MIN_TOUCH})
        ex["marathon_fresh"] = {"rect": mr, "label": mfresh.get("label"),
                                "opacity": mfresh.get("opacity")}

        hid = scroll_hidden(pg, drv, vw, vh)
        ex["b02_pre"] = {k: hid.get(k) for k in
                         ("opacity", "pointerEvents", "inert", "hitsButton", "topEl", "scrollY")}
        n_exit, log_exit = taps_to_act(pg, drv, "/baca/")
        ex["exit"] = {"taps": n_exit, "log": log_exit}
        g.add("B02", vid, "BUG", "SATU tap 'Keluar maraton' (chrome tersembunyi) -> /baca/",
              n_exit == 1, describe_failure(log_exit, n_exit, "keluar maraton"),
              {"taps_to_exit": n_exit, "log": log_exit})
        g.add("G11", vid, "GUARD", "pemulihan: tap berikutnya tetap bisa keluar maraton",
              n_exit is not None and n_exit <= 3,
              f"butuh {n_exit} tap (user tidak terjebak)", {"taps_to_exit": n_exit})

        # ---------------------------------------------- halaman reader
        open_reader(pg, base)
        fresh = state(pg)
        ex["build"] = {"scripts": fresh.get("scripts", [])}
        ex["fresh"] = {k: fresh.get(k) for k in
                       ("rect", "opacity", "pointerEvents", "inert", "label",
                        "hitsButton", "fs", "overflowX", "scrollH")}

        r = fresh.get("rect") or {}
        g.add("G01", vid, "GUARD", "geometri tombol idle >= 44x44 CSS px",
              r.get("w", 0) >= MIN_TOUCH and r.get("h", 0) >= MIN_TOUCH,
              f"rect={r} (butuh w>=44 & h>=44)", {"rect": r, "min": MIN_TOUCH})

        fsr = fresh.get("fs") or {}
        ov = overlaps(r, fsr)
        g.add("G03", vid, "GUARD", "tombol maraton & layar penuh tidak bertumpuk",
              bool(fsr) and ov == 0,
              f"maraton={r} layarPenuh={fsr} luasIrisan={ov}px2",
              {"maraton": r, "fullscreen": fsr, "overlap_px2": ov})

        # ---------------------------------------------- G12 tap saat chrome TAMPIL
        s_vis = state(pg)
        mark(pg, "tap-visible")
        drv.tap(s_vis["cx"], s_vis["cy"])
        arrived = wait_js(pg, "() => location.pathname.startsWith('/maraton/')", timeout=4000)
        ev = drain(pg)
        clicks = [e for e in ev if e["t"] == "click"]
        g.add("G12", vid, "GUARD", "tap tombol saat chrome TAMPIL -> 1 tap masuk maraton",
              arrived and any(c["onBtn"] for c in clicks),
              f"navigasi={arrived} clickTargets={[c['tgt'] for c in clicks]}",
              {"navigated": arrived, "click_targets": [c["tgt"] for c in clicks]})
        ex["tap_visible"] = {"navigated": arrived,
                             "click_targets": [c["tgt"] for c in clicks]}

        # ---------------------------------------------- kembali ke reader
        open_reader(pg, base)

        # ---------------------------------------------- G04 / G05 tap area baca
        ok, e1 = tap_area_toggle(pg, drv, vw, vh, want_visible=False)
        g.add("G04", vid, "GUARD", "tap area baca: tap tengah -> chrome tersembunyi",
              ok and e1.get("on_layer", False), f"hasil={e1}", e1)
        ok2, e2 = tap_area_toggle(pg, drv, vw, vh, want_visible=True)
        g.add("G05", vid, "GUARD", "tap area baca: tap tengah -> chrome muncul kembali",
              ok2 and e2.get("on_layer", False), f"hasil={e2}", e2)
        ex["tap_area"] = {"hide": e1, "reveal": e2}

        # ---------------------------------------------- G06 gulir di atas tombol (tampil)
        sw = scroll_over_button(pg, drv, vw, vh, dy=120, label="scroll-over-btn-visible")
        g.add("G06", vid, "GUARD", "gulir mulai DI ATAS TOMBOL (chrome tampil) -> menggulir",
              sw.get("delta", 0) >= 60 and sw.get("clicks", 1) == 0
              and "/maraton/" not in str(sw.get("path", "")),
              f"delta={sw.get('delta')}px clicks={sw.get('clicks')} path={sw.get('path')} "
              f"targets={sw.get('click_targets')}", sw)
        ex["scroll_visible"] = sw

        # ---------------------------------------------- G08 / G09 chrome ikut scroll
        if state(pg).get("opacity", 1) > 0.05:
            scroll_hidden(pg, drv, vw, vh)
        hid2 = state(pg)
        g.add("G08", vid, "GUARD", "chrome menyembunyikan diri saat scroll turun (opacity)",
              hid2.get("opacity", 1) <= 0.05,
              f"opacity={hid2.get('opacity')} pe={hid2.get('pointerEvents')} "
              f"inert={hid2.get('inert')} (hanya opacity yang dikunci)",
              {k: hid2.get(k) for k in ("opacity", "pointerEvents", "inert", "scrollY")})

        vis = scroll_visible(pg, drv, vw, vh)
        g.add("G09", vid, "GUARD", "chrome muncul lagi saat scroll naik",
              vis.get("opacity", 0) >= 0.95,
              f"opacity={vis.get('opacity')} scrollY={vis.get('scrollY')}",
              {"opacity": vis.get("opacity"), "scrollY": vis.get("scrollY")})

        # ---------------------------------------------- G07 gulir di atas tombol (sembunyi)
        hid3 = scroll_hidden(pg, drv, vw, vh)
        ex["hidden_state"] = {k: hid3.get(k) for k in
                              ("opacity", "pointerEvents", "inert", "hitsButton",
                               "topEl", "scrollY")}
        sw2 = scroll_over_button(pg, drv, vw, vh, dy=140, label="scroll-over-btn-hidden")
        g.add("G07", vid, "GUARD", "gulir mulai DI ATAS TOMBOL (chrome sembunyi) -> menggulir",
              sw2.get("delta", 0) >= 60 and sw2.get("clicks", 1) == 0
              and "/maraton/" not in str(sw2.get("path", "")),
              f"delta={sw2.get('delta')}px clicks={sw2.get('clicks')} path={sw2.get('path')} "
              f"targets={sw2.get('click_targets')}", sw2)
        ex["scroll_hidden"] = sw2

        # ---------------------------------------------- B01 masuk 1 tap
        if state(pg).get("opacity", 1) > 0.05:
            scroll_hidden(pg, drv, vw, vh)
        pre = state(pg)
        ex["b01_pre"] = {k: pre.get(k) for k in
                         ("opacity", "pointerEvents", "inert", "hitsButton", "topEl", "scrollY")}
        n_enter, log_enter = taps_to_act(pg, drv, "/maraton/")
        ex["enter"] = {"taps": n_enter, "log": log_enter}
        g.add("B01", vid, "BUG", "SATU tap tombol maraton (chrome tersembunyi) -> /maraton/",
              n_enter == 1, describe_failure(log_enter, n_enter, "masuk maraton"),
              {"taps_to_enter": n_enter, "log": log_enter})
        g.add("G10", vid, "GUARD", "pemulihan: tap berikutnya tetap bisa masuk maraton",
              n_enter is not None and n_enter <= 3,
              f"butuh {n_enter} tap (user tidak terjebak)", {"taps_to_enter": n_enter})
    finally:
        try:
            pg.screenshot(path=f"scripts/gate_1tap_{vid}.png")
        except Exception:
            pass
        ctx.close()
        b.close()
    return ex


# ------------------------------------------------------------------------ CLI
def parse_viewports(spec):
    out = []
    for part in spec.split(","):
        part = part.strip()
        if not part:
            continue
        w, h = part.lower().split("x")
        out.append((int(w), int(h)))
    return out


def main(argv=None):
    ap = argparse.ArgumentParser(
        description="Gerbang regresi: bug 1-tap tombol maraton + invarian yang dilindungi.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="Contoh:\n"
               "  python scripts/gate_marathon_1tap.py http://127.0.0.1:8788 --expect-bug\n"
               "  python scripts/gate_marathon_1tap.py http://127.0.0.1:8788\n")
    ap.add_argument("base_url", nargs="?",
                    default=os.environ.get("BASE_URL", "http://127.0.0.1:8788"),
                    help="URL dasar aplikasi (default: $BASE_URL atau http://127.0.0.1:8788)")
    ap.add_argument("--expect-bug", action="store_true",
                    help="mode bukti baseline: lulus bila bug MASIH ADA")
    ap.add_argument("--json", dest="json_path", default=None,
                    help="tulis bukti lengkap ke file JSON")
    ap.add_argument("--viewports", default="390x844,360x640",
                    help="daftar viewport sentuh, dipisah koma (default 390x844,360x640)")
    ap.add_argument("--desktop", action="store_true",
                    help="tambahkan viewport mouse 1280x800 (klik + wheel)")
    ap.add_argument("--headed", action="store_true", help="jalankan browser dengan UI")
    args = ap.parse_args(argv)

    base = args.base_url.rstrip("/")
    if not (base.startswith("http://") or base.startswith("https://")):
        print(f"URL tidak valid: {base!r} — harus diawali http:// atau https://",
              file=sys.stderr)
        return 3
    try:
        viewports = parse_viewports(args.viewports)
    except Exception:
        print(f"--viewports tidak valid: {args.viewports!r} (contoh: 390x844,360x640)",
              file=sys.stderr)
        return 3
    if not viewports:
        print("Tidak ada viewport yang valid.", file=sys.stderr)
        return 3

    plan = [(w, h, "touch") for (w, h) in viewports]
    if args.desktop:
        plan.append((1280, 800, "mouse"))

    mode = "bug" if args.expect_bug else "fix"
    print("=" * 78)
    print(f"GERBANG 1-TAP MARATON — {base}")
    print(f"mode={mode}  target={['%dx%d/%s' % v for v in plan]}  "
          f"mulai={time.strftime('%Y-%m-%d %H:%M:%S')}")
    print("=" * 78)

    g = Gate()
    evidence: dict = {"base_url": base, "mode": mode,
                      "started": time.strftime("%Y-%m-%dT%H:%M:%S"),
                      "viewports": {}}
    rc = 0
    try:
        with sync_playwright() as p:
            for (vw, vh, kind) in plan:
                evidence["viewports"][f"{vw}x{vh}"] = run_viewport(
                    p, base, vw, vh, kind, args.headed, g)
    except Exception as exc:
        print(f"\n[HARNESS] gagal: {exc}", file=sys.stderr)
        traceback.print_exc()
        evidence["harness_error"] = str(exc)
        rc = 3

    # -------------------------------------------------------------- ringkasan
    bugs = g.of("BUG")
    guards = g.of("GUARD")
    bug_failed = [r for r in bugs if not r["ok"]]
    guard_failed = [r for r in guards if not r["ok"]]
    bug_reproduced = len(bugs) > 0 and len(bug_failed) == len(bugs)

    def label(rows):
        return ", ".join(f"{r['id']}@{r['viewport']}" for r in rows)

    print("\n" + "-" * 78)
    print(f"GUARD : {len(guards) - len(guard_failed)}/{len(guards)} lulus"
          + ("" if not guard_failed else "   RUSAK -> " + label(guard_failed)))
    print(f"BUG   : {len(bugs) - len(bug_failed)}/{len(bugs)} lulus (1-tap berfungsi)"
          + ("" if not bug_failed else "   MASIH ADA -> " + label(bug_failed)))

    print("\nBASELINE TERUKUR (angka pembanding setelah perbaikan):")
    for vid, ex in evidence.get("viewports", {}).items():
        en = (ex.get("enter") or {}).get("taps")
        exi = (ex.get("exit") or {}).get("taps")
        r = (ex.get("fresh") or {}).get("rect") or {}
        mr = (ex.get("marathon_fresh") or {}).get("rect") or {}
        sv = ex.get("scroll_visible") or {}
        sh = ex.get("scroll_hidden") or {}
        ta = ex.get("tap_area") or {}
        print(f"  {vid:8s} taps_masuk={en} taps_keluar={exi} "
              f"geometri_idle={r.get('w')}x{r.get('h')} "
              f"geometri_aktif={mr.get('w')}x{mr.get('h')} "
              f"gulir_di_tombol={sv.get('delta')}px/{sh.get('delta')}px "
              f"tap_area_hide_op={(ta.get('hide') or {}).get('opacity')} "
              f"tap_area_show_op={(ta.get('reveal') or {}).get('opacity')}")

    if rc == 3:
        verdict = "HARNESS GAGAL — hasil tidak sah, jangan dipakai sebagai bukti."
    elif guard_failed:
        rc = 2
        verdict = ("REGRESI: perilaku yang dilindungi rusak -> " + label(guard_failed)
                   + ". Bug 1-tap tidak boleh diperbaiki dengan mengorbankan ini.")
    elif mode == "bug":
        if bug_reproduced:
            rc = 0
            verdict = ("BASELINE TERBUKTI: bug 1-tap tereproduksi di SEMUA viewport "
                       f"({label(bugs)}), dan seluruh {len(guards)} guard tetap lulus.")
        else:
            rc = 1
            verdict = ("Baseline TIDAK mereproduksi bug sepenuhnya — build ini mungkin "
                       "sudah diperbaiki, atau lingkungannya berbeda.")
    else:
        if bug_failed:
            rc = 1
            verdict = ("BUG MASIH ADA: tombol belum bisa diaktifkan dengan satu tap -> "
                       + label(bug_failed) + ".")
        else:
            rc = 0
            verdict = (f"LULUS: satu tap berfungsi di semua viewport dan seluruh "
                       f"{len(guards)} guard tetap utuh.")

    print("\n" + "=" * 78)
    print(f"VERDIKT: {verdict}")
    print(f"EXIT CODE: {rc}")
    print("=" * 78)

    evidence["exit_code"] = rc
    evidence["verdict"] = verdict
    evidence["checks"] = g.rows
    if args.json_path:
        with open(args.json_path, "w", encoding="utf-8") as fh:
            json.dump(evidence, fh, indent=1, ensure_ascii=False)
        print(f"bukti JSON: {args.json_path}")
    return rc


if __name__ == "__main__":
    sys.exit(main())
