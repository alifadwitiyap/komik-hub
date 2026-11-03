#!/usr/bin/env python3
"""reader_hidden_controls_a11y_e2e.py — bukti empiris bug F5 (kontrol reader
hilang dari accessibility tree + tidak bisa di-fokus keyboard saat chrome
tersembunyi).

Konteks bug (QA report: scripts/_QA_AUDIT_SUPERVISOR.md, temuan F5)
------------------------------------------------------------------
`ReaderMarathonToggle.tsx` dan `ReaderFullscreenButton.tsx` menerima
`visible={chrome.visible}` lalu merender:

    aria-hidden={!visible}  inert={!visible}
    className="... pointer-events-none opacity-0"   (saat !visible)

`inert` + `aria-hidden` MEMANG membuang elemen dari accessibility tree dan
mematikan fokus — itu perilaku yang benar untuk chrome dekoratif. Masalahnya
tombol MARATON dan LAYAR PENUH adalah kontrol NAVIGASI, bukan dekorasi: saat
chrome tersembunyi (setelah scroll turun / tap tengah), keduanya lenyap total
dari pohon a11y DAN tidak bisa dijangkau Tab. Pengguna keyboard/screen-reader
tidak punya jalan masuk ke mode maraton atau layar penuh sama sekali.

Skrip ini membuktikan klaim itu dengan tiga sumber bukti independen:

  1. DOM      — atribut/komputasi: aria-hidden, inert, opacity, pointer-events.
  2. AX tree  — Chrome DevTools Protocol `Accessibility.getFullAXTree` +
                `getPartialAXTree` (node jadi `ignored:true` dengan alasan
                `ariaHiddenElement`) + `aria_snapshot()` Playwright.
  3. Keyboard — Tab sweep nyata dari sentinel, plus `el.focus()` programatik.

Kontrol positif WAJIB: saat chrome TAMPIL, kedua tombol harus terbukti ADA di
AX tree dan TERJANGKAU Tab. Tanpa kontrol positif, "tidak ada saat tersembunyi"
bisa jadi cuma selektor salah / halaman belum render. Skrip ini gagal
(exit 2) kalau kontrol positif tidak terbukti.

Mode
----
  --expect bug    (default) lulus bila bug TERBUKTI ada  -> dipakai untuk
                  memverifikasi build BASELINE.
  --expect fixed  lulus bila bug TIDAK ada lagi          -> dipakai sebagai
                  gate regresi setelah perbaikan.

Exit code
---------
  0 = verdict sesuai --expect (bug terbukti / bug sudah hilang)
  1 = verdict TIDAK sesuai --expect (baseline tidak mereproduksi bug, atau
      perbaikan belum bekerja)
  2 = prasyarat/lingkungan (server mati, halaman tak render, tombol tak ada)

Pemakaian
---------
  python scripts/reader_hidden_controls_a11y_e2e.py
  python scripts/reader_hidden_controls_a11y_e2e.py http://127.0.0.1:8788/baca/komiku:1284/77
  python scripts/reader_hidden_controls_a11y_e2e.py --base-url http://127.0.0.1:8789
  python scripts/reader_hidden_controls_a11y_e2e.py <url> --expect fixed
  python scripts/reader_hidden_controls_a11y_e2e.py <url> --json-out scripts/_f5_evidence.json
  python scripts/reader_hidden_controls_a11y_e2e.py <url> --headed --keep-open

Konvensi stack (references/e2e-verification.md): Playwright sync melawan server
live, blokir service worker sebelum navigasi pertama (supaya aset build yang
diuji benar-benar yang disajikan server, bukan cache SW), poll predikat bukan
sleep buta, dan jangan menulis state akun (skrip ini read-only).
"""

from __future__ import annotations

import argparse
import datetime as _dt
import hashlib
import json
import re
import sys
import time
import urllib.error
import urllib.request
from urllib.parse import urljoin, urlsplit

try:
    from playwright.sync_api import sync_playwright
except ImportError:  # pragma: no cover - prasyarat lingkungan
    print("FATAL: butuh python-playwright. Install: pip install playwright && "
          "python -m playwright install chromium")
    raise SystemExit(2)

SCHEMA = "komiku.f5.hidden-controls-a11y/1"
DEFAULT_BASE = "http://127.0.0.1:8788"
DEFAULT_CHAPTER = "/baca/komiku:1284/77"

# Kontrak selector — cocok dengan data-testid di
# src/components/ReaderMarathonToggle.tsx & ReaderFullscreenButton.tsx.
BUTTONS = {
    "marathon": {
        "selector": '[data-testid="reader-marathon-toggle"]',
        "name": "Masuk maraton",
        "label": "tombol Maraton",
    },
    "fullscreen": {
        "selector": '[data-testid="reader-fullscreen-toggle"]',
        "name": "Masuk layar penuh",
        "label": "tombol Layar Penuh",
    },
}

# Chrome = toolbar atas + footer bawah. Dipakai HANYA sebagai sinyal state
# "chrome tersembunyi", bukan sebagai subjek uji.
CHROME_SELECTORS = ('[data-reader-chrome="toolbar"]', '[data-reader-chrome="footer"]')

# Sentinel fixed di awal/akhir body: titik start Tab yang deterministik dan
# tidak memicu scroll (scroll akan mengubah state chrome di tengah sweep).
SENTINEL_START = "f5-sentinel-start"
SENTINEL_END = "f5-sentinel-end"


class PrereqError(RuntimeError):
    """Lingkungan tidak siap — bukan regresi produk."""


# --------------------------------------------------------------------------
# util
# --------------------------------------------------------------------------
def http_get(url: str, timeout: float = 10.0) -> tuple[int, bytes, dict]:
    req = urllib.request.Request(url, headers={"User-Agent": "komiku-f5-a11y/1"})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status, r.read(), dict(r.headers)
    except urllib.error.HTTPError as e:
        return e.code, e.read(), dict(e.headers)


def sha256_bytes(b: bytes) -> str:
    return hashlib.sha256(b).hexdigest()


def now_iso() -> str:
    return _dt.datetime.now(_dt.timezone.utc).astimezone().isoformat(timespec="seconds")


class Report:
    def __init__(self) -> None:
        self.checks: list[dict] = []
        self.sections: dict = {}

    def check(self, cid: str, ok: bool, detail: str = "") -> bool:
        self.checks.append({"id": cid, "ok": bool(ok), "detail": detail})
        print(f"  {'PASS' if ok else 'FAIL'}  {cid}" + (f"  [{detail}]" if detail else ""))
        return bool(ok)

    def info(self, cid: str, detail: str) -> None:
        self.checks.append({"id": cid, "ok": None, "detail": detail})
        print(f"  INFO  {cid}  [{detail}]")

    def failed(self) -> list[dict]:
        return [c for c in self.checks if c["ok"] is False]


# --------------------------------------------------------------------------
# halaman
# --------------------------------------------------------------------------
def wait_ready(page, timeout_ms: int) -> None:
    """Tunggu reader benar-benar ter-render (kedua tombol ter-attach)."""
    for key, meta in BUTTONS.items():
        try:
            page.wait_for_selector(meta["selector"], state="attached", timeout=timeout_ms)
        except Exception as exc:  # noqa: BLE001
            raise PrereqError(
                f"{meta['label']} ({meta['selector']}) tidak pernah muncul di DOM "
                f"dalam {timeout_ms} ms — halaman belum ter-render / chapter gagal "
                f"dimuat. Ini masalah prasyarat, bukan bukti F5. ({type(exc).__name__})"
            ) from exc


def install_sentinels(page) -> None:
    page.evaluate(
        """([startId, endId]) => {
            document.querySelectorAll('#' + startId + ',#' + endId).forEach(e => e.remove());
            const mk = (id, txt) => {
                const a = document.createElement('a');
                a.id = id; a.href = '#' + id; a.tabIndex = 0; a.textContent = txt;
                a.style.cssText = 'position:fixed;top:0;left:0;width:2px;height:2px;'
                                + 'opacity:0.01;z-index:2147483647;';
                return a;
            };
            document.body.prepend(mk(startId, 'sentinel-start'));
            document.body.append(mk(endId, 'sentinel-end'));
        }""",
        [SENTINEL_START, SENTINEL_END],
    )


def dom_state(page, selector: str) -> dict:
    return page.evaluate(
        """(sel) => {
            const el = document.querySelector(sel);
            if (!el) return {exists: false};
            const cs = getComputedStyle(el);
            const r = el.getBoundingClientRect();
            return {
                exists: true,
                ariaHidden: el.getAttribute('aria-hidden'),
                inertAttr: el.hasAttribute('inert'),
                inertProp: !!el.inert,
                opacity: cs.opacity,
                pointerEvents: cs.pointerEvents,
                visibility: cs.visibility,
                display: cs.display,
                tabIndex: el.tabIndex,
                disabled: !!el.disabled,
                rect: {x: r.x, y: r.y, w: r.width, h: r.height},
                inViewport: r.width > 0 && r.height > 0 &&
                            r.bottom > 0 && r.right > 0 &&
                            r.top < innerHeight && r.left < innerWidth,
                text: (el.textContent || '').trim().slice(0, 60),
            };
        }""",
        selector,
    )


def aria_snapshot_of(page, selector: str) -> str:
    try:
        return page.locator(selector).aria_snapshot(timeout=3000) or ""
    except Exception:  # noqa: BLE001 - elemen tak terlihat / tak ada
        return ""


def body_aria_snapshot(page) -> str:
    try:
        return page.locator("body").aria_snapshot(timeout=8000) or ""
    except Exception:  # noqa: BLE001
        return ""


def ax_full_tree(cdp) -> list[dict]:
    cdp.send("Accessibility.enable")
    return cdp.send("Accessibility.getFullAXTree")["nodes"]


def ax_find(nodes: list[dict], name: str) -> dict | None:
    """Cari node AX yang TIDAK ignored dengan nama persis `name`."""
    for n in nodes:
        if n.get("ignored"):
            continue
        if (n.get("name") or {}).get("value") == name:
            return n
    return None


def ax_partial(cdp, selector: str) -> dict:
    doc = cdp.send("DOM.getDocument", {"depth": -1})
    nid = cdp.send("DOM.querySelector", {"nodeId": doc["root"]["nodeId"], "selector": selector})["nodeId"]
    if not nid:
        return {"missing": True}
    nodes = cdp.send("Accessibility.getPartialAXTree", {"nodeId": nid, "fetchRelatives": False})["nodes"]
    return nodes[0] if nodes else {"missing": True}


def ax_summary(node: dict | None) -> dict:
    if not node:
        return {"present": False}
    props = {p.get("name"): (p.get("value") or {}).get("value") for p in node.get("properties", [])}
    return {
        "present": True,
        "ignored": bool(node.get("ignored")),
        "ignoredReasons": [r.get("name") for r in node.get("ignoredReasons", [])],
        "role": (node.get("role") or {}).get("value"),
        "name": (node.get("name") or {}).get("value"),
        "focusable": props.get("focusable"),
        "disabled": props.get("disabled"),
    }


def tab_sweep(page, max_presses: int, stop_when: set[str] | None = None) -> list[str]:
    """Tekan Tab dari sentinel-start; kembalikan urutan identitas fokus."""
    page.evaluate("(id) => document.getElementById(id).focus()", SENTINEL_START)
    seen: list[str] = []
    for _ in range(max_presses):
        page.keyboard.press("Tab")
        ident = page.evaluate(
            """() => {
                const a = document.activeElement;
                if (!a || a === document.body) return 'BODY';
                return a.id || a.getAttribute('data-testid') || a.getAttribute('aria-label') || a.tagName;
            }"""
        )
        seen.append(ident)
        if stop_when and stop_when.issubset(set(seen)):
            break
        # dua sentinel berurutan = sudah berputar penuh (tidak ada tab stop lain)
        if len(seen) >= 4 and seen[-1] == SENTINEL_END and seen[-3] == SENTINEL_END:
            break
    return seen


def programmatic_focus(page, selector: str) -> dict:
    return page.evaluate(
        """(sel) => {
            const el = document.querySelector(sel);
            if (!el) return {exists: false};
            const before = document.activeElement;
            try { el.focus(); } catch (e) { return {exists: true, threw: String(e)}; }
            const a = document.activeElement;
            return {
                exists: true,
                accepted: a === el,
                activeTag: a ? a.tagName : null,
                activeId: a ? (a.id || a.getAttribute('data-testid') ||
                               a.getAttribute('aria-label') || '') : null,
                activeBefore: before ? before.tagName : null,
            };
        }""",
        selector,
    )


def hit_test(page, selector: str) -> dict:
    return page.evaluate(
        """(sel) => {
            const el = document.querySelector(sel);
            if (!el) return {exists: false};
            const r = el.getBoundingClientRect();
            const x = Math.min(innerWidth - 1, Math.max(0, r.x + r.width / 2));
            const y = Math.min(innerHeight - 1, Math.max(0, r.y + r.height / 2));
            const at = document.elementFromPoint(x, y);
            return {
                exists: true,
                hitTag: at ? at.tagName : null,
                hitTestId: at ? (at.getAttribute('data-testid') || at.id || '') : null,
                hitIsButton: !!(at && (at === el || el.contains(at))),
            };
        }""",
        selector,
    )


def chrome_state(page) -> dict:
    """State chrome dari TOOLBAR/FOOTER — sinyal independen dari tombol uji.

    Sengaja TIDAK memakai tombol maraton/fullscreen sebagai sinyal: setelah bug
    diperbaiki tombol itu tetap tampil, sedangkan toolbar tetap ikut scroll.
    Dengan begitu skrip yang sama sahih untuk `--expect bug` maupun `fixed`.
    """
    return page.evaluate(
        """(sels) => {
            const out = {};
            for (const s of sels) {
                const el = document.querySelector(s);
                out[s] = el ? {
                    exists: true,
                    ariaHidden: el.getAttribute('aria-hidden'),
                    inert: !!el.inert,
                    hidden: el.getAttribute('aria-hidden') === 'true' || !!el.inert,
                } : {exists: false};
            }
            const present = Object.values(out).filter(v => v.exists);
            return {
                parts: out,
                any_present: present.length > 0,
                hidden: present.length > 0 && present.every(v => v.hidden),
            };
        }""",
        list(CHROME_SELECTORS),
    )


def wait_chrome(page, want_hidden: bool, timeout_s: float = 6.0) -> bool:
    deadline = time.time() + timeout_s
    while time.time() < deadline:
        if chrome_state(page)["hidden"] == want_hidden:
            return True
        page.wait_for_timeout(100)
    return chrome_state(page)["hidden"] == want_hidden


def wait_transition_settled(page, want_opacity: float, timeout_s: float = 3.0) -> dict:
    """Tunggu transisi `transition-opacity duration-200` selesai.

    Mengukur opacity di tengah fade (mis. 0.35) membuat asersi rapuh dan
    menyesatkan; opacity hanya sinyal pendukung, jadi tunggu sampai settle.
    """
    deadline = time.time() + timeout_s
    last = {}
    while time.time() < deadline:
        last = page.evaluate(
            """(sels) => sels.map(s => {
                const el = document.querySelector(s);
                return el ? parseFloat(getComputedStyle(el).opacity) : -1;
            })""",
            [m["selector"] for m in BUTTONS.values()],
        )
        if all(abs(o - want_opacity) <= 0.02 for o in last):
            return {"settled": True, "opacity": last}
        page.wait_for_timeout(80)
    return {"settled": False, "opacity": last}



def hide_chrome(page, vw: int, vh: int) -> str:
    """Sembunyikan chrome; kembalikan mekanisme yang berhasil."""
    if chrome_state(page)["hidden"]:
        return "already-hidden"

    # 1) scroll turun > ambang 40px (jalur utama useChromeOnScroll)
    page.evaluate("window.scrollTo({top: 900, behavior: 'instant'})")
    if wait_chrome(page, True, 2.5):
        return "scroll-down"

    # 2) tap tengah area baca = chrome.toggle()
    page.mouse.click(vw / 2, vh / 2)
    if wait_chrome(page, True, 3.0):
        return "tap-center"

    # 3) scroll lagi (kalau tap tadi justru menampilkan)
    page.evaluate(
        "window.scrollTo({top: Math.min(1200, document.body.scrollHeight - innerHeight - 1),"
        " behavior: 'instant'})"
    )
    if wait_chrome(page, True, 2.5):
        return "scroll-down-2"
    raise PrereqError(
        "chrome reader (toolbar/footer) tidak bisa disembunyikan lewat scroll maupun "
        "tap tengah — state 'hidden' tidak tercapai, jadi F5 tidak bisa diuji di "
        "halaman ini."
    )


# --------------------------------------------------------------------------
# pengukuran per tombol
# --------------------------------------------------------------------------
def measure_button(page, cdp, key: str, phase: str) -> dict:
    meta = BUTTONS[key]
    sel = meta["selector"]
    nodes = ax_full_tree(cdp)
    snap_el = aria_snapshot_of(page, sel)
    data = {
        "phase": phase,
        "dom": dom_state(page, sel),
        "ax_full": ax_summary(ax_find(nodes, meta["name"])),
        "ax_partial": ax_summary(ax_partial(cdp, sel)),
        "aria_snapshot_element": snap_el,
        "aria_snapshot_element_empty": snap_el.strip() == "",
        "focus": programmatic_focus(page, sel),
        "hit": hit_test(page, sel),
    }
    d = data["dom"]
    print(
        f"    {key:10s} aria-hidden={str(d.get('ariaHidden')):5s} "
        f"inert={str(d.get('inertProp')):5s} opacity={str(d.get('opacity')):9s} "
        f"pe={str(d.get('pointerEvents')):5s} "
        f"| AX ignored={data['ax_partial'].get('ignored')} "
        f"role={data['ax_partial'].get('role')} "
        f"| snap={snap_el!r} | focus={data['focus'].get('accepted')} "
        f"| hit={data['hit'].get('hitTestId')!r}"
    )
    return data


def measure_phase(page, cdp, phase: str) -> dict:
    print(f"\n[{phase}]")
    body = body_aria_snapshot(page)
    out = {
        "phase": phase,
        "scrollY": page.evaluate("window.scrollY"),
        "chrome": chrome_state(page),
        "tab_sequence": tab_sweep(page, 10),
        "body_snapshot_has_marathon": BUTTONS["marathon"]["name"] in body,
        "body_snapshot_has_fullscreen": BUTTONS["fullscreen"]["name"] in body,
        "body_snapshot_len": len(body),
        # kontrol negatif: halaman TETAP punya konten a11y. Kalau ini juga
        # kosong, "tombol hilang" cuma artefak halaman blank.
        "body_snapshot_has_content": bool(re.search(r"-\s+(img|main|status)\b", body)),
        "body_snapshot_imgs": len(re.findall(r"-\s+img\b", body)),
        "buttons": {},
    }
    print(f"    chrome.hidden={out['chrome']['hidden']}  tab_sequence={out['tab_sequence']}")
    for key in BUTTONS:
        out["buttons"][key] = measure_button(page, cdp, key, phase)
    return out


def reachability(page) -> dict:
    """Inventaris semua focusable yang masih bisa dipakai keyboard."""
    return page.evaluate(
        """() => {
            const all = [...document.querySelectorAll(
                'a[href],button,input,select,textarea,[tabindex]:not([tabindex="-1"])')];
            const usable = all.filter(el => {
                if (el.closest('[inert]')) return false;
                if (el.disabled) return false;
                const cs = getComputedStyle(el);
                return cs.display !== 'none' && cs.visibility !== 'hidden';
            });
            return {
                total_focusables: all.length,
                usable_focusables: usable.length,
                usable_ids: usable.map(el => el.getAttribute('data-testid') ||
                                          el.getAttribute('aria-label') ||
                                          (el.textContent || '').trim().slice(0, 30)),
            };
        }"""
    )


# --------------------------------------------------------------------------
# asersi
# --------------------------------------------------------------------------
def _tab_ids(seq: list[str]) -> set[str]:
    """Petakan entri tab_sequence ke kunci tombol (data-testid / aria-label)."""
    out: set[str] = set()
    for s in seq:
        for key, meta in BUTTONS.items():
            if s == meta["selector"] or s == meta["name"] or key in (s or ""):
                out.add(key)
    return out


def not_aria_hidden(dom: dict) -> bool:
    """True bila elemen TIDAK disembunyikan dari a11y tree.

    `aria-hidden` absen (None) sama sahnya dengan "false" — build yang sudah
    diperbaiki biasanya membuang atributnya, bukan menulis "false".
    """
    return dom.get("ariaHidden") not in ("true", True)


def assert_visible_phase(rep: Report, visible: dict) -> bool:
    """KONTROL POSITIF — saat chrome tampil, tombol wajib ada & terjangkau.

    Tanpa ini, "tombol tidak ada saat tersembunyi" tidak bisa dibedakan dari
    selektor yang salah atau halaman yang belum render.
    """
    print("\n[1] kontrol positif — tombol HARUS ada & terjangkau saat chrome tampil")
    ok = True
    tab_ids = _tab_ids(visible["tab_sequence"])
    for key, meta in BUTTONS.items():
        v = visible["buttons"][key]
        print(f"  -- {meta['label']}")
        ok &= rep.check(f"visible.{key}.dom_present", bool(v["dom"].get("exists")),
                        f"opacity={v['dom'].get('opacity')} "
                        f"pe={v['dom'].get('pointerEvents')}")
        ok &= rep.check(f"visible.{key}.not_aria_hidden", not_aria_hidden(v["dom"]),
                        f"aria-hidden={v['dom'].get('ariaHidden')}")
        ok &= rep.check(f"visible.{key}.not_inert", not v["dom"].get("inertProp"), "inert=false")
        ok &= rep.check(f"visible.{key}.in_ax_tree",
                        bool(v["ax_full"].get("present")) and not v["ax_partial"].get("ignored"),
                        f"role={v['ax_partial'].get('role')} "
                        f"name={v['ax_partial'].get('name')!r}")
        ok &= rep.check(f"visible.{key}.aria_snapshot", not v["aria_snapshot_element_empty"],
                        repr(v["aria_snapshot_element"]))
        ok &= rep.check(f"visible.{key}.tab_reachable", key in tab_ids,
                        f"seq={visible['tab_sequence']}")
        ok &= rep.check(f"visible.{key}.focus_accepted", bool(v["focus"].get("accepted")),
                        f"active={v['focus'].get('activeId')!r}")
    ok &= rep.check("positive_control", ok,
                    "kedua tombol terbukti ada di AX tree + terjangkau Tab saat chrome tampil")
    return ok


def assert_bug_phase(rep: Report, hidden: dict, reach: dict) -> bool:
    """MODE --expect bug: buktikan tombol hilang dari AX tree & tidak fokusable."""
    print("\n[2] bug F5 — saat chrome tersembunyi")
    ok = True
    tab_ids = _tab_ids(hidden["tab_sequence"])
    for key, meta in BUTTONS.items():
        h = hidden["buttons"][key]
        print(f"  -- {meta['label']}")
        # (a) dibuang dari accessibility tree
        ok &= rep.check(f"hidden.{key}.aria_hidden_true", h["dom"].get("ariaHidden") == "true",
                        f"aria-hidden={h['dom'].get('ariaHidden')}")
        ok &= rep.check(f"hidden.{key}.inert_true", bool(h["dom"].get("inertProp")), "inert=true")
        ok &= rep.check(f"hidden.{key}.ax_node_ignored",
                        bool(h["ax_partial"].get("present")) and bool(h["ax_partial"].get("ignored")),
                        f"ignored={h['ax_partial'].get('ignored')} "
                        f"reasons={h['ax_partial'].get('ignoredReasons')}")
        ok &= rep.check(f"hidden.{key}.ax_name_absent", not bool(h["ax_full"].get("present")),
                        f"node bernama {meta['name']!r} di AX tree: "
                        f"{h['ax_full'].get('present')}")
        ok &= rep.check(f"hidden.{key}.aria_snapshot_empty",
                        bool(h["aria_snapshot_element_empty"]),
                        repr(h["aria_snapshot_element"]))
        ok &= rep.check(f"hidden.{key}.absent_from_body_snapshot",
                        not hidden[f"body_snapshot_has_{key}"],
                        "nama tombol tidak ada di snapshot body")
        # (b) tidak bisa di-fokus keyboard
        ok &= rep.check(f"hidden.{key}.not_tab_reachable", key not in tab_ids,
                        f"seq={hidden['tab_sequence']}")
        ok &= rep.check(f"hidden.{key}.programmatic_focus_rejected",
                        not bool(h["focus"].get("accepted")),
                        f"activeElement={h['focus'].get('activeTag')}/"
                        f"{h['focus'].get('activeId')!r}")
        # (c) jalur pointer juga tertutup (konteks F1/F4, bukan F5 murni)
        ok &= rep.check(f"hidden.{key}.pointer_blocked", not bool(h["hit"].get("hitIsButton")),
                        f"elementFromPoint -> {h['hit'].get('hitTestId')!r}")

    ok &= rep.check("hidden.opacity_zero",
                    all(hidden["buttons"][k]["dom"].get("opacity") == "0" for k in BUTTONS),
                    "opacity: 0")
    ok &= rep.check("hidden.pointer_events_none",
                    all(hidden["buttons"][k]["dom"].get("pointerEvents") == "none"
                        for k in BUTTONS), "pointer-events: none")
    ok &= rep.check("hidden.no_keyboard_path_to_marathon",
                    not any("maraton" in (s or "").lower() for s in reach["usable_ids"]),
                    f"{reach['usable_focusables']} focusable tersisa, tidak satu pun = maraton")
    ok &= rep.check("hidden.no_keyboard_path_to_fullscreen",
                    not any(("layar penuh" in (s or "").lower())
                            or ("fullscreen" in (s or "").lower())
                            for s in reach["usable_ids"]),
                    f"{reach['usable_focusables']} focusable tersisa, "
                    f"tidak satu pun = layar penuh")
    return ok


def assert_fixed_phase(rep: Report, hidden: dict, reach: dict) -> bool:
    """MODE --expect fixed: tombol wajib TETAP ada & fokusable saat chrome sembunyi."""
    print("\n[2] verifikasi perbaikan — saat chrome tersembunyi tombol harus TETAP ada")
    ok = True
    tab_ids = _tab_ids(hidden["tab_sequence"])
    for key, meta in BUTTONS.items():
        h = hidden["buttons"][key]
        print(f"  -- {meta['label']}")
        ok &= rep.check(f"fixed.{key}.not_aria_hidden", not_aria_hidden(h["dom"]),
                        f"aria-hidden={h['dom'].get('ariaHidden')}")
        ok &= rep.check(f"fixed.{key}.not_inert", not h["dom"].get("inertProp"), "inert=false")
        ok &= rep.check(f"fixed.{key}.in_ax_tree",
                        bool(h["ax_full"].get("present")) and not h["ax_partial"].get("ignored"),
                        f"role={h['ax_partial'].get('role')} "
                        f"name={h['ax_partial'].get('name')!r}")
        ok &= rep.check(f"fixed.{key}.aria_snapshot", not h["aria_snapshot_element_empty"],
                        repr(h["aria_snapshot_element"]))
        ok &= rep.check(f"fixed.{key}.present_in_body_snapshot",
                        hidden[f"body_snapshot_has_{key}"], "nama tombol ada di snapshot body")
        ok &= rep.check(f"fixed.{key}.tab_reachable", key in tab_ids,
                        f"seq={hidden['tab_sequence']}")
        ok &= rep.check(f"fixed.{key}.focus_accepted", bool(h["focus"].get("accepted")),
                        f"active={h['focus'].get('activeId')!r}")
        ok &= rep.check(f"fixed.{key}.keyboard_path_exists",
                        any((meta["name"] in (s or "")) or (key in (s or "").lower())
                            for s in reach["usable_ids"]),
                        f"{reach['usable_focusables']} focusable tersisa")
    return ok


def assert_negative(rep: Report, visible: dict, hidden: dict) -> bool:
    """KONTROL NEGATIF — halaman tidak blank & Tab tidak mati total."""
    print("\n[3] kontrol negatif — halaman tidak blank")
    ok = True
    ok &= rep.check("negative.page_has_a11y_content",
                    bool(hidden["body_snapshot_has_content"]) and hidden["body_snapshot_imgs"] > 0,
                    f"{hidden['body_snapshot_imgs']} img di snapshot body saat chrome tersembunyi")
    ok &= rep.check("negative.page_has_a11y_content_visible",
                    bool(visible["body_snapshot_has_content"]),
                    "snapshot body tidak kosong saat chrome tampil")
    ok &= rep.check("negative.tab_still_works", len(set(hidden["tab_sequence"])) > 1,
                    f"Tab masih memindahkan fokus: {sorted(set(hidden['tab_sequence']))}")
    return ok


# --------------------------------------------------------------------------
# build fingerprint
# --------------------------------------------------------------------------
def build_fingerprint(url: str) -> dict:
    """Hash aset yang benar-benar disajikan server — mengikat bukti ke build."""
    parts = urlsplit(url)
    origin = f"{parts.scheme}://{parts.netloc}"
    status, body, headers = http_get(url)
    html = body.decode("utf-8", "replace")
    assets = re.findall(r'(?:src|href)="([^"]+\.(?:js|css))"', html)
    fp = {
        "url": url,
        "http_status": status,
        "server": headers.get("Server") or headers.get("server"),
        "html_sha256": sha256_bytes(body),
        "html_bytes": len(body),
        "title": (re.search(r"<title>([^<]*)</title>", html) or [None, None])[1],
        "assets": {},
        "origin": origin,
    }
    for a in dict.fromkeys(assets):
        try:
            st, b, _ = http_get(urljoin(origin, a), timeout=15)
            fp["assets"][a] = {"status": st, "sha256": sha256_bytes(b), "bytes": len(b)}
        except Exception as exc:  # noqa: BLE001
            fp["assets"][a] = {"error": type(exc).__name__}
    return fp


def health(origin: str) -> dict:
    try:
        st, b, _ = http_get(origin + "/api/health", timeout=5)
        return {"status": st, "body": json.loads(b.decode("utf-8", "replace"))}
    except Exception as exc:  # noqa: BLE001
        return {"error": type(exc).__name__, "detail": str(exc)[:120]}


# --------------------------------------------------------------------------
# main
# --------------------------------------------------------------------------
def resolve_url(args) -> str:
    if args.url:
        return args.url
    return args.base_url.rstrip("/") + "/" + args.chapter.lstrip("/")


def run(args) -> int:
    url = resolve_url(args)
    started = time.time()
    rep = Report()

    print("=" * 78)
    print("F5 — kontrol reader hilang dari accessibility tree & tak bisa di-fokus")
    print(f"URL     : {url}")
    print(f"Expect  : {args.expect}")
    print("=" * 78)

    # ---- prasyarat -------------------------------------------------------
    print("\n[0] prasyarat")
    try:
        status, body, _ = http_get(url)
    except Exception as exc:  # noqa: BLE001
        raise PrereqError(f"server tidak merespons di {url} ({type(exc).__name__}: {exc})") from exc
    if status != 200:
        raise PrereqError(f"GET {url} -> HTTP {status} (harus 200)")
    rep.check("prereq.http_200", True, f"{len(body)} bytes")
    rep.check("prereq.spa_shell", b'id="root"' in body, "index.html memuat #root")
    parts = urlsplit(url)
    origin = f"{parts.scheme}://{parts.netloc}"

    fp = build_fingerprint(url)
    rep.sections["build"] = fp
    rep.sections["health"] = health(origin)
    rep.info("build.html_sha256", fp["html_sha256"][:16] + "...")
    for a, meta in fp["assets"].items():
        rep.info("build.asset", f"{a} -> {(meta.get('sha256') or meta.get('error') or '')[:16]}")

    with sync_playwright() as pw:
        browser = pw.chromium.launch(headless=not args.headed)
        ctx = browser.new_context(
            viewport={"width": args.width, "height": args.height},
            locale="id-ID",
            device_scale_factor=1,
        )
        # Service worker bisa menyajikan aset lama -> bukti harus dari build
        # yang benar-benar dikirim server sekarang.
        # Netralkan service worker: cache SW bisa menyajikan bundle LAMA, dan
        # Fulfill (bukan abort) supaya tidak memunculkan console.error palsu
        # "An unknown error occurred when fetching the script".
        ctx.route(
            "**/sw.js",
            lambda route: route.fulfill(status=200,
                                        content_type="application/javascript",
                                        body="/* sw disabled by a11y probe */"),
        )
        page = ctx.new_page()
        page_errors: list[str] = []
        console_errors: list[str] = []
        page.on("pageerror", lambda e: page_errors.append(str(e)))
        page.on("console", lambda m: console_errors.append(m.text) if m.type == "error" else None)

        page.goto(url, wait_until="domcontentloaded", timeout=args.timeout)
        wait_ready(page, args.timeout)
        page.wait_for_timeout(args.settle)

        cdp = ctx.new_cdp_session(page)
        cdp.send("Accessibility.enable")
        cdp.send("DOM.enable")
        install_sentinels(page)

        vw, vh = args.width, args.height
        rep.sections["environment"] = {
            "viewport": {"width": vw, "height": vh},
            "user_agent": page.evaluate("navigator.userAgent"),
            "browser_version": browser.version,
            "playwright": getattr(pw, "__version__", None) or "unknown",
            "reduced_motion": page.evaluate("matchMedia('(prefers-reduced-motion: reduce)').matches"),
            "chrome_selectors": list(CHROME_SELECTORS),
        }

        # ---- fase 1: chrome TAMPIL (kontrol positif) --------------------
        if chrome_state(page)["hidden"]:
            page.mouse.click(vw / 2, vh / 2)
            wait_chrome(page, False, 3.0)
        visible = measure_phase(page, cdp, "chrome-visible")
        rep.sections["visible"] = visible
        rep.check("visible.chrome_shown", not visible["chrome"]["hidden"],
                  f"toolbar hidden={visible['chrome']['hidden']}")

        # ---- fase 2: chrome TERSEMBUNYI ---------------------------------
        mech = hide_chrome(page, vw, vh)
        settle = wait_transition_settled(page, 0.0, 2.0)
        hidden = measure_phase(page, cdp, "chrome-hidden")
        hidden["mechanism"] = mech
        hidden["transition"] = settle
        rep.sections["hidden"] = hidden
        rep.info("chrome.hide_mechanism", mech)
        rep.info("chrome.transition", f"settled={settle['settled']} opacity={settle['opacity']}")

        rep.check("hidden.chrome_is_hidden", hidden["chrome"]["hidden"],
                  "toolbar/footer aria-hidden=true / inert")
        rep.check("hidden.state_stable_during_probe", chrome_state(page)["hidden"],
                  "chrome tetap tersembunyi setelah sweep Tab")
        rep.sections["reachability"] = reach = reachability(page)

        # ---- asersi -----------------------------------------------------
        positive = assert_visible_phase(rep, visible)
        negative = assert_negative(rep, visible, hidden)
        if args.expect == "bug":
            bug_present = assert_bug_phase(rep, hidden, reach)
            fix_holds = not bug_present
        else:
            fix_holds = assert_fixed_phase(rep, hidden, reach)
            bug_present = not fix_holds

        rep.sections["page_errors"] = page_errors[:10]
        rep.sections["console_errors"] = console_errors[:10]
        rep.info("console.page_errors", f"{len(page_errors)} pageerror")
        rep.info("console.console_errors", f"{len(console_errors)} console.error")

        if args.keep_open:
            print("\n--keep-open: tekan Ctrl+C untuk menutup browser")
            try:
                while True:
                    page.wait_for_timeout(1000)
            except KeyboardInterrupt:
                pass
        browser.close()

    # ---- verdict --------------------------------------------------------
    print("\n" + "=" * 78)
    if not (positive and negative):
        ok, verdict = False, "INCONCLUSIVE (kontrol positif/negatif gagal — hasil tak sahih)"
    elif args.expect == "bug":
        ok = bug_present
        verdict = "F5 CONFIRMED (bug ADA di build ini)" if ok else "F5 NOT REPRODUCED"
    else:
        ok = fix_holds
        verdict = "F5 FIXED (tombol tetap ada & bisa difokus)" if ok else "F5 STILL PRESENT"
    print(f"VERDICT : {verdict}")
    print(f"expect={args.expect}  bug_present={bug_present}  "
          f"positive_control={positive}  negative_control={negative}")
    failed = rep.failed()
    print(f"checks  : {len(rep.checks) - len(failed)} ok / {len(failed)} fail / "
          f"{sum(1 for c in rep.checks if c['ok'] is None)} info")
    if failed:
        print("gagal   : " + ", ".join(c["id"] for c in failed))
    print("=" * 78)

    out = {
        "schema": SCHEMA,
        "url": url,
        "started_at": now_iso(),
        "duration_s": round(time.time() - started, 2),
        "expect": args.expect,
        "verdict": verdict,
        "passed": bool(ok),
        "bug_present": bug_present,
        "positive_control": positive,
        "negative_control": negative,
        "checks": rep.checks,
        "sections": rep.sections,
    }
    if args.json_out:
        with open(args.json_out, "w", encoding="utf-8") as f:
            json.dump(out, f, indent=2, ensure_ascii=False)
        print(f"json    : {args.json_out}")
    return 0 if ok else 1


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(
        description="Bukti empiris F5: tombol Maraton & Layar Penuh hilang dari "
                    "accessibility tree dan tidak bisa di-fokus keyboard saat chrome "
                    "reader tersembunyi.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="Contoh:\n"
               "  python scripts/reader_hidden_controls_a11y_e2e.py\n"
               "  python scripts/reader_hidden_controls_a11y_e2e.py http://127.0.0.1:8788/baca/komiku:1284/77\n"
               "  python scripts/reader_hidden_controls_a11y_e2e.py <url> --expect fixed\n",
    )
    ap.add_argument("url", nargs="?", default=None,
                    help="URL halaman reader lengkap (default: base-url + chapter)")
    ap.add_argument("--base-url", default=DEFAULT_BASE,
                    help=f"origin server (default {DEFAULT_BASE})")
    ap.add_argument("--chapter", default=DEFAULT_CHAPTER,
                    help=f"path chapter bila URL tidak diberikan (default {DEFAULT_CHAPTER})")
    ap.add_argument("--expect", choices=["bug", "fixed"], default="bug",
                    help="'bug' (default) lulus bila F5 terbukti; 'fixed' lulus bila sudah hilang")
    ap.add_argument("--json-out", default=None, help="tulis bukti lengkap ke file JSON")
    ap.add_argument("--timeout", type=int, default=25000, help="timeout navigasi/selector (ms)")
    ap.add_argument("--settle", type=int, default=1200,
                    help="jeda setelah tombol ter-attach sebelum mengukur (ms)")
    ap.add_argument("--width", type=int, default=1280)
    ap.add_argument("--height", type=int, default=900)
    ap.add_argument("--headed", action="store_true", help="tampilkan browser")
    ap.add_argument("--keep-open", action="store_true", help="jangan tutup browser di akhir")
    args = ap.parse_args(argv)

    try:
        return run(args)
    except PrereqError as exc:
        print(f"\nFATAL (prasyarat): {exc}")
        return 2


if __name__ == "__main__":
    sys.exit(main())
