"""E2E ADVERSARIAL untuk fitur "sudah dibaca" (Komik Hub).

Skenario sengaja تاريخ/berlawanan dengan alur正常使用. Setiap skenario
menyatakan: APA yang diharapkan, APA yang diamati, dan DASAR pass/fail.

  A1 bocor-antar-akun-lewat-cache-SW
     Service worker cache `API` di-shared antar akun (key cache = URL, bukan
     header). Kalau request ber-header X-Komik-User masih boleh lewat cache,
     respons akun A bisa dilayani ke akun B.
     HARAP: akun B tidak melihat mark akun A meski SW aktif & cache terisi.
     DASAR : aria-label baris chapter di halaman series B.

  A2 mark-hilang-saat-tab-ditutup-cepat
     Push di-debounce 1,2 s. Kalau tab ditutup/reload sebelum timer jalan,
     mark harus tetap sampai ke server (pending di-persist).
     HARAP: mark chapter yang dibuka <1,2 s sebelum reload ada di server.
     DASAR : isi /api/read milik akun A.

  A3 union-tidak-bisa-dihapus-oleh-push-lain
     Merge server = union. Akun B push chapter lain tidak boleh menghapus
     mark yang sudah ada.
     HARAP: setelah push B, mark A utuh.
     DASAR : isi /api/read.

  A4 payload-rusak-tidak-crash-server
     Body bukan JSON, marks bukan object, chapter bukan string, at bukan
     angka, marks null.
     HARAP: 400 (bukan 500) dan server tetap hidup setelahnya.
     DASAR : status HTTP + health setelah setiap payload.

  A5 judul-dengan-karakter-khas
     title_key berisi karakter aneh (spasi, titik, unicode). Chapter list
     ber-title_key sama harus tetap ter-match.
     HARAP: mark tersimpan & terbaca kembali utuh.
     DASAR : isi /api/read (round-trip).

  A6 guest-lalu-daftar-mengadopsi-mark-lokal
     Guest (tanpa akun) membaca chapter → mark disimpan lokal di scope
     'anon'. Lalu daftar akun BARU → mark guest harus diadopsi (created
     === true → PUSH), seperti favorit & progress.
     HARAP: mark chapter guest ada di server akun baru.
     DASAR : isi /api/read akun baru.

  A7 chapter-nomor-aneh-tetap-nyambung
     Nomor chapter non-numerik ("extra-9", "00.1") harus punya key yang
     sama di reader dan di halaman series.
     HARAP: mark untuk nomor aneh round-trip dan match daftar.
     DASAR : isi /api/read + aria-label.

  A8 dua-tab-satu-akun-tidak-mengganggu
     Dua tab akun sama: tab 1 mark chapter, tab 2 buka series → tab 2
     harus melihat mark itu (state bukan per-tab).
     HARAP: baris chapter abu di tab 2.
     DASAR : aria-label.

  A9 sneak-remote-lewat-URL-params
     Query `?series=` Dicecraft dari user lain tidak boleh menambah mark
     ke akun ini (mark hanya lahir dari chapter yang DIBUKA).
     HARAP: /api/read akun A tetap hanya berisi mark yang benar-benar dibuka.
     DASAR : isi /api/read.

  A10 mark-tidak-bocor-ke-akun-lain-via-URL-handle
     Membuka chapter dengan handle series lain tidak boleh menandai
     chapter milik series pertama.
     HARAP: mark series lain tidak muncul di /api/read series pertama.
     DASAR : isi /api/read per series.

  python scripts/readmark_hostile_e2e.py
"""
from __future__ import annotations

import argparse
import json
import os
import random
import string
import sys
import time
import urllib.error
import urllib.parse
import time
import urllib.request

import e2e_cleanup

from playwright.sync_api import sync_playwright

DEFAULT_BASE = "http://127.0.0.1:8788"
HANDLE = "komiku:1284"
SHOTS = r"C:\Users\LENOVO LEGION\AppData\Local\Temp\readmark_hostile"

passed: list[str] = []
failed: list[str] = []


def check(name: str, cond: bool, extra: str = "") -> bool:
    (passed if cond else failed).append(name)
    print(f"  {'PASS' if cond else 'FAIL'}  {name}" + (f"  [{extra}]" if extra else ""))
    return bool(cond)



def wait_reader_loaded(page, chapter: str | None = None, timeout_s: float = 45.0) -> bool:
    """Tunggu reader menampilkan chapter + minimal 1 gambar (poll, bukan sleep).

    `chapter` = nomor chapter yang diharapkan; None = cukup header "Chapter"
    dan ada gambar.
    """
    deadline = time.time() + timeout_s
    while time.time() < deadline:
        try:
            ok = page.evaluate(
                """(n) => {
                    const head = document.querySelector('header')?.innerText || '';
                    const imgs = Array.from(document.querySelectorAll('img'))
                        .filter(i => i.naturalWidth > 0).length;
                    const hasChapter = n ? head.includes('Chapter ' + n)
                                         : head.includes('Chapter');
                    return hasChapter && imgs > 0;
                }""",
                chapter,
            )
        except Exception:
            ok = False
        if ok:
            return True
        page.wait_for_timeout(500)
    return False


def rand_user(tag: str) -> str:
    alphabet = string.ascii_lowercase + string.digits
    return e2e_cleanup.track(
        "e2eh" + tag + "".join(random.choice(alphabet) for _ in range(6))
    )


def api(base, path, user=None, body=None, method=None, raw=None, timeout=30):
    """Return (status, json|None). Body mentah pakai `raw`.

    `method` WAJIB eksplisit untuk /api/read (hanya GET+PUT yang diizinkan;
    default "POST" akan kena 405 dan memalsukan hasil).
    """
    data = raw if raw is not None else (json.dumps(body).encode() if body is not None else None)
    headers = {"Accept": "application/json"}
    if data is not None:
        headers["Content-Type"] = "application/json"
    if user:
        headers["X-Komik-User"] = user
    m = method or ("POST" if body is not None else "GET")
    req = urllib.request.Request(base + path, data=data, headers=headers, method=m)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            txt = resp.read()
            try:
                return resp.status, json.loads(txt or b"{}")
            except Exception:
                return resp.status, None
    except urllib.error.HTTPError as e:
        txt = e.read()
        try:
            return e.code, json.loads(txt or b"{}")
        except Exception:
            return e.code, None


def put_marks(base, user, marks):
    """PUT /api/read (method eksplisit)."""
    return api(base, "/api/read", user=user, body={"marks": marks}, method="PUT")


def marks_of(base, user):
    st, js = api(base, "/api/read", user=user)
    return (js or {}).get("marks", {}) or {}


def chapters_of(marks):
    out = set()
    for series in marks.values():
        out.update(str(c) for c in series)
    return out


def main() -> int:
    ap = argparse.ArgumentParser(prog="readmark_hostile_e2e.py")
    ap.add_argument("--base-url", default=DEFAULT_BASE)
    args = ap.parse_args()
    base = args.base_url
    os.makedirs(SHOTS, exist_ok=True)

    if api(base, "/api/health")[0] != 200:
        print("FATAL: server tidak hidup di %s" % base, flush=True)
        return 2

    # ------------------------------------------------------------------ A4
    print("== A4 payload rusak ==")
    user_a = rand_user("a")
    api(base, "/api/user/claim", body={"username": user_a})
    bad_payloads = [
        ("bukan JSON", b"{{{"),
        ("marks = string", json.dumps({"marks": "bukan-object"}).encode()),
        ("marks = array", json.dumps({"marks": [1, 2, 3]}).encode()),
        ("marks = null", json.dumps({"marks": None}).encode()),
        ("at = array", json.dumps({"marks": {"s": {"1": [1, 2]}}}).encode()),
        ("at = float", json.dumps({"marks": {"s": {"1": 2.5}}}).encode()),
        ("chapters = array", json.dumps({"marks": {"s": [1, 2]}}).encode()),
        ("at = string", json.dumps({"marks": {"s": {"1": "bukan-angka"}}}).encode()),
        ("nested terlalu dalam", json.dumps({"marks": {"s": {"1": {"2": {"3": 1}}}}}).encode()),
        ("body = array", b"[1,2,3]"),
        ("body kosong", b""),
    ]
    for label, raw in bad_payloads:
        st, _ = api(base, "/api/read", user=user_a, raw=raw, method="PUT")
        check("A4 %s → 400 (bukan 500)" % label, st == 400, "status=%s" % st)
    st, _ = api(base, "/api/health")
    check("A4 server tetap hidup setelah payload rusak", st == 200, "status=%s" % st)
    # payload valid minimal harus tetap jalan setelahnya
    st, js = put_marks(base, user_a, {"s": {"1": 1}})
    check("A4 PUT valid tetap jalan setelah payload rusak", st == 200, "status=%s" % st)

    # ------------------------------------------------------------------ A3
    print("== A3 union tidak bisa dihapus push lain ==")
    user_b = rand_user("b")
    api(base, "/api/user/claim", body={"username": user_b})
    put_marks(base, user_a, {"s-union": {"10": 1, "11": 2}})
    put_marks(base, user_b, {"s-union": {"12": 3}})
    ka = chapters_of(marks_of(base, user_a))
    kb = chapters_of(marks_of(base, user_b))
    check("A3 push B tidak menghapus mark A", {"10", "11"} <= ka, "A=%s" % sorted(ka))
    check("A3 A tidak melihat mark B", "12" not in ka, "A=%s" % sorted(ka))
    check("A3 B melihat marknya sendiri", "12" in kb, "B=%s" % sorted(kb))

    # ------------------------------------------------------------------ A5
    print("== A5 title_key karakter khas ==")
    weird_keys = [
        "judul dengan spasi",
        "judul.dengan.titik",
        "judul/garis",
        "judul:kolon",
        "judul-dash",
        "jüdül-unicode",
        "-judul",
    ]
    for wk in weird_keys:
        put_marks(base, user_a, {wk: {"1": 1}})
    round_ok = True
    detail = []
    m_all = marks_of(base, user_a)
    for wk in weird_keys:
        got = m_all.get(wk, {}).get("1")
        if got is None:
            round_ok = False
            detail.append(wk)
    check("A5 title_key aneh round-trip utuh", round_ok, "hilang: %s" % detail)
    check("A5 jumlah series tersimpan sesuai", len(m_all) >= len(weird_keys), "%d keys" % len(m_all))

    # ------------------------------------------------------------------ A7
    print("== A7 nomor chapter non-numerik ==")
    put_marks(base, user_a, {"s-aneh": {"extra-9": 1, "00.1": 2, "1.5": 3}})
    m7 = marks_of(base, user_a).get("s-aneh", {})
    check("A7 nomor non-numerik tersimpan utuh",
          set(m7) == {"extra-9", "00.1", "1.5"}, "keys=%s" % sorted(m7))

    # ------------------------------------------------------------------ A9
    print("== A9 mark tak bisa dicuri lewat URL param ==")
    before9 = chapters_of(marks_of(base, user_a))
    api(base, "/api/read?series=s-union&extra=1", user=user_a)
    after9 = chapters_of(marks_of(base, user_a))
    check("A9 GET tidak menambah mark", before9 == after9,
          "tambahan=%s" % sorted(after9 - before9))

    # ------------------------------------------------------------------ A11
    print("== A11 kapasitas & prune ==")
    # Satu manga panjang bisa punya >1000 chapter. Cap per-series yang lebih
    # kecil dari itu akan membuat chapter lama SELALU terlihat belum dibaca.
    st, js = api(base, "/api/unified/series/komiku:6426")
    js = js or {}
    long_series = (js.get("manga") or {}).get("title_key", "one piece")
    n_ch = len(js.get("chapters") or [])
    print("  series panjang:", long_series, "chapter:", n_ch)
    put_marks(base, user_a, {long_series: {str(i): i for i in range(1, n_ch + 1)}})
    stored = marks_of(base, user_a).get(long_series, {})
    kept = len(stored)
    check("A11 semua chapter seri panjang tersimpan (tak ada yang ter-prune)",
          kept == n_ch, "tersimpan=%d dari %d" % (kept, n_ch))
    check("A11 chapter paling awal masih ada", "1" in stored, "ada=%s" % ("1" in stored))
    check("A11 chapter terakhir ada", str(n_ch) in stored, "")

    # ------------------------------------------------------------------ A12
    print("== A12 bodyلياً besar ==")
    huge = json.dumps({"marks": {"s": {str(i): i for i in range(200000)}}}).encode()
    st, _ = api(base, "/api/read", user=user_a, raw=huge, method="PUT", timeout=60)
    check("A12 body 2MB+ → ditolak rapi (400/413), bukan 500",
          st in (400, 413), "status=%s ukuran=%d" % (st, len(huge)))
    st, _ = api(base, "/api/health")
    check("A12 server tetap hidup setelah body besar", st == 200, "status=%s" % st)

    # ------------------------------------------------------------------ A13
    print("== A13 push paralel (race read-modify-write) ==")
    # Server: read_state -> merge -> write_state. Kalau dua PUT jalan
    # bersamaan, keduanya bisa baca state LAMA lalu tulis -> salah satu mark
    # hilang. Yang hilang = chapter yang SUDAH dibaca tampil belum dibaca.
    par_user = rand_user("p")
    api(base, "/api/user/claim", body={"username": par_user})
    import threading
    results: list[int] = []

    def push(i):
        st, _ = put_marks(base, par_user, {"s-par": {str(1000 + i): 1}})
        results.append(st)

    threads = [threading.Thread(target=push, args=(i,)) for i in range(24)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    par_stored = marks_of(base, par_user).get("s-par", {})
    check("A13 24 push paralel: semua mark tersimpan (tak ada yang hilang)",
          len(par_stored) == 24, "tersimpan=%d dari 24 (status=%s)" % (len(par_stored), set(results)))

    # ------------------------------------------------------------------ A14
    print("== A14 pull per-serial dengan title_key aneh ==")
    pull_user = rand_user("q")
    api(base, "/api/user/claim", body={"username": pull_user})
    weird = "judul dengan spasi & символ/+#?"
    put_marks(base, pull_user, {weird: {"1": 1, "2": 2}})
    st, js = api(base, "/api/read?series=" + urllib.parse.quote(weird), user=pull_user)
    got = (js or {}).get("marks", {}) or {}
    check("A14 pull ?series= dengan title_key ter-encoderound-trip",
          got.get(weird, {}).get("1") == 1, "marks=%s" % list(got))

    # ------------------------------------------------------------------ browser
    user_c = rand_user("c")
    user_d = rand_user("d")
    api(base, "/api/user/claim", body={"username": user_c})
    api(base, "/api/user/claim", body={"username": user_d})

    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        ctx = browser.new_context(viewport={"width": 1280, "height": 900}, locale="id-ID")
        page = ctx.new_page()
        errs: list[str] = []
        page.on("pageerror", lambda e: errs.append(str(e)))

        def set_acct(u):
            page.evaluate("(u) => localStorage.setItem('komik-akun-v1', u)", u)
            page.reload(wait_until="networkidle")

        # ------------------------------- A1: bocor antar akun lewat cache SW
        print("== A1 bocor antar akun lewat cache SW ==")
        # pastikan SW terpasang & cache API terisi untuk akun C
        page.goto(base + "/", wait_until="networkidle")
        page.wait_for_timeout(2500)
        sw_active = page.evaluate("""async () => {
            if (!('serviceWorker' in navigator)) return false;
            const regs = await navigator.serviceWorker.getRegistrations();
            return regs.length > 0;
        }""")
        check("A1 service worker terdaftar", bool(sw_active), "regs=%s" % sw_active)
        set_acct(user_c)
        page.goto(f"{base}/manga/{HANDLE}", wait_until="networkidle")
        page.wait_for_timeout(2500)
        # akun C mark satu chapter lewat API (server) lalu buka seri di akun D
        put_marks(base, user_c, {"reincarnator": {"121": 1}})
        set_acct(user_d)
        page.goto(f"{base}/manga/{HANDLE}", wait_until="networkidle")
        page.wait_for_timeout(3000)
        lbl_d = page.locator('a[aria-label^="Chapter 121"]').first.get_attribute("aria-label") or ""
        check("A1 akun D TIDAK melihat mark akun C (cache SW tidak bocor)",
              "sudah dibaca" not in lbl_d, "label=%r" % lbl_d)
        # dan D sendiri harus tetap bisa mark -> mark sendiri ada
        d_marks = chapters_of(marks_of(base, user_d))
        check("A1 akun D punya mark sendiri saja", "121" not in d_marks, "D=%s" % sorted(d_marks))

        # ------------------------------- A2: mark hilang saat tab ditutup cepat
        print("== A2 mark hilang saat tab ditutup cepat ==")
        set_acct(user_c)
        page.goto(f"{base}/manga/{HANDLE}", wait_until="networkidle")
        page.wait_for_timeout(2500)
        target = "120"
        page.locator(f'a[aria-label^="Chapter {target}"]').first.click()
        page.wait_for_url("**/baca/**", timeout=20000)
        page.wait_for_timeout(3000)
        # PREKONDISI: chapter termuat. Kalau tidak, mark tak pernah dibuat dan
        # check mark gagal karena alasan yang salah (lingkungan, bukan fitur).
        if not wait_reader_loaded(page, target):
            check("PRASYARAT: chapter termuat di reader", False,
                  "reader tak menampilkan chapter (server/upstream, bukan fitur)")
            browser.close()
            print("\nGAGAL PRASYARAT: chapter tak termuat. Masalah lingkungan, bukan fitur.")
            return 2
        check("PRASYARAT: chapter termuat di reader", True)
        # tunggu mark tercatat di storage LALU reload < 1,2 s (sebelum debounce)
        recorded = False
        for _ in range(60):
            recorded = bool(page.evaluate(
                """(ch) => Object.keys(localStorage)
                    .filter(k => k.startsWith('komik.readmarks.v1'))
                    .some(k => Object.keys(JSON.parse(localStorage.getItem(k) || '{}'))
                              .some(mk => mk.endsWith(':' + ch)))""",
                target))
            if recorded:
                break
            page.wait_for_timeout(50)
        page.reload(wait_until="networkidle")   # reload =bunuh timer debounce
        page.wait_for_timeout(4000)            # boot: pending dimuat ulang + dipush
        c_marks = chapters_of(marks_of(base, user_c))
        check("A2 mark tetap sampai ke server walau reload < debounce",
              target in c_marks, "C=%s" % sorted(c_marks))

        # ------------------------------- A8: dua tab satu akun
        print("== A8 dua tab satu akun ==")
        set_acct(user_c)
        page.goto(f"{base}/manga/{HANDLE}", wait_until="networkidle")
        page.wait_for_timeout(2000)
        other = "119"
        page.locator(f'a[aria-label^="Chapter {other}"]').first.click()
        page.wait_for_url("**/baca/**", timeout=20000)
        page.wait_for_timeout(3500)
        # tab kedua:Account sama, halaman series
        page2 = ctx.new_page()
        page2.goto(f"{base}/manga/{HANDLE}", wait_until="networkidle")
        page2.wait_for_timeout(3000)
        lbl2 = page2.locator(f'a[aria-label^="Chapter {other}"]').first.get_attribute("aria-label") or ""
        check("A8 tab kedua melihat mark tab pertama", "sudah dibaca" in lbl2, "label=%r" % lbl2)
        page2.close()

        # ------------------------------- A6: guest -> daftar, adopsi mark
        print("== A6 guest lalu daftar, adopsi mark lokal ==")
        # guest: tanpa header, mark disimpan lokal scope 'anon'
        guest_ctx = browser.new_context(viewport={"width": 1280, "height": 900}, locale="id-ID")
        gp = guest_ctx.new_page()
        gp.goto(f"{base}/manga/{HANDLE}", wait_until="networkidle")
        gp.wait_for_timeout(2000)
        guest_target = "118"
        gp.locator(f'a[aria-label^="Chapter {guest_target}"]').first.click()
        gp.wait_for_url("**/baca/**", timeout=20000)
        gp.wait_for_timeout(3500)
        guest_local = gp.evaluate("""() => {
            const out = [];
            for (const k of Object.keys(localStorage)) {
                if (k.startsWith('komik.readmarks.v1')) {
                    for (const mk of Object.keys(JSON.parse(localStorage.getItem(k) || '{}'))) out.push(mk);
                }
            }
            return out;
        }""")
        check("A6 mark guest tercatat di storage lokal (scope anon)",
              any(mk.endswith(":" + guest_target) for mk in guest_local),
              "keys=%s" % guest_local[:5])
        # daftar akun BARU di device yang sama -> created=true -> adopsi mark anon
        new_user = rand_user("n")
        gp.evaluate("""() => localStorage.removeItem('komik-akun-v1')""")
        gp.goto(base + "/akun", wait_until="networkidle")
        gp.wait_for_timeout(1500)
        gp.fill("#akun-username", new_user)
        gp.click("button[type=submit]")
        gp.wait_for_timeout(4000)
        n_marks = chapters_of(marks_of(base, new_user))
        check("A6 mark guest DIADOPSI ke akun baru",
              guest_target in n_marks, "akun baru=%s marks=%s" % (new_user, sorted(n_marks)))
        guest_ctx.close()

        # ------------------------------- A10: mark series lain tak muncul
        print("== A10 mark tidak bocor antar series ==")
        set_acct(user_c)
        page.goto(f"{base}/manga/{HANDLE}", wait_until="networkidle")
        page.wait_for_timeout(2000)
        # buka chapter series LAIN (handle berbeda) -> title_key berbeda
        other_handle = "komiku:6426"
        page.goto(f"{base}/baca/{other_handle}/1195", wait_until="networkidle")
        page.wait_for_timeout(3500)
        m10 = marks_of(base, user_c)
        reinc = set(m10.get("reincarnator", {}))
        one_piece = set(m10.get("one piece", {}))
        check("A10 chapter series lain tidak menandai seri pertama",
              "1195" not in reinc, "reincarnator=%s" % sorted(reinc))
        check("A10 chapter series lain ter-mark di title_key-nya sendiri",
              "1195" in one_piece, "one piece=%s" % sorted(one_piece))

        # ------------------------------------------------------------------ A15
        print("== A15 dua chapter dibuka beruntun (tanpa reload) ==")
        # Dua chapter dibuka beruntun lewat "Berikutnya" (SPA) -> dua mark
        # dibuat dalam satu sesi. Keduanya harus sampai ke server.
        seq_user = rand_user("q2")
        api(base, "/api/user/claim", body={"username": seq_user})
        seq_ctx = browser.new_context(viewport={"width": 1280, "height": 900}, locale="id-ID")
        sq = seq_ctx.new_page()
        sq.goto(base + "/", wait_until="networkidle")
        sq.evaluate("(u) => localStorage.setItem('komik-akun-v1', u)", seq_user)
        sq.reload(wait_until="networkidle")
        sq.goto(f"{base}/manga/{HANDLE}", wait_until="networkidle")
        sq.wait_for_timeout(2000)
        sq.locator('a[aria-label^="Chapter 117"]').first.click()
        sq.wait_for_url("**/baca/**", timeout=20000)
        # tunggu footer reader siap (tombol Berikutnya muncul setelah data chapter)
        for _ in range(80):
            if sq.locator('footer a:has-text("Berikutnya")').count() > 0:
                break
            sq.wait_for_timeout(100)
        nxt2 = sq.locator('footer a:has-text("Berikutnya")')
        if nxt2.count() == 0:
            check("A15 ada link 'Berikutnya' di footer", False, "tidak ketemu")
        else:
            nxt2.first.click()
            sq.wait_for_timeout(6000)
            seq_marks = chapters_of(marks_of(base, seq_user))
            check("A15 dua chapter beruntun keduanya sampai ke server",
                  {"117", "118"} <= seq_marks, "marks=%s" % sorted(seq_marks))
        seq_ctx.close()

        check("A1-A15 tidak ada pageerror JS", not errs, "; ".join(errs[:2]))
        browser.close()

    # ------------------------------------------------------------------ A2 total
    # Bersihkan state akun throwaway (file users/progress/read). Tanpa ini
    # tiap run meninggalkan file di data/ server — 121 file terkumpul dari
    # belasan run read-mark.
    removed = e2e_cleanup.cleanup_claimed()
    if removed:
        print(f"cleanup: {len(removed)} file state akun tes dihapus")

    print()
    print(f"lulus: {len(passed)}  gagal: {len(failed)}")
    if failed:
        for f in failed:
            print("  FAIL:", f)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
