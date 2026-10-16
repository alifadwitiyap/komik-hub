#!/usr/bin/env python3
"""akun_e2e.py - E2E isolasi antar-akun Komik Hub (API-level, tanpa UI).

Membuktikan dua akun (username-only, header `X-Komik-User`) TIDAK saling
membocorkan empat permukaan state yang di-scope per akun:

  1. favorit    - GET/PUT /api/notif/favorites
  2. notifikasi - GET /api/notif/list + POST /api/notif/read
  3. unduhan    - POST /api/unified/download-pdf, GET/DELETE /api/unified/downloads
  4. progress   - GET/PUT /api/progress

Plus kontrak akses: header hilang / username belum terdaftar / username invalid
=> 401 di setiap endpoint ber-scope akun (dan 400 untuk `claim` invalid).

Server HARUS jalan (default http://127.0.0.1:8788). `--help` tetap bekerja
tanpa server. Exit 0 = semua check lulus; non-zero = ada yang gagal.

  python scripts/akun_e2e.py
  python scripts/akun_e2e.py --base-url http://127.0.0.1:8789
  python scripts/akun_e2e.py --keep        # jangan bersihkan fixture di akhir
  python scripts/akun_e2e.py -v            # cetak tiap request + status

Kontrak (dibekukan; lihat komiku-server/src/user.rs + progress.rs + notif.rs +
docs/superpowers/specs/2026-10-16-komik-hub-accounts-design.md):

  POST /api/user/claim {username}            -> {ok, username, created}
  GET  /api/user/me                          -> {username}
  GET  /api/notif/favorites                  -> {favorites:[{title_key,title,...}]}
  PUT  /api/notif/favorites {favorites:[..]} -> {ok, count, filling}
  GET  /api/notif/list                       -> {items:[...], unread, last_check_at}
  POST /api/notif/read {all:true}            -> {ok, marked}
  GET  /api/progress                         -> {entries:[...]}
  PUT  /api/progress {entries:[...]}         -> {ok, count}
  GET  /api/unified/downloads                -> {items:[...], total_bytes, limit_bytes}

Script ini self-contained: hanya stdlib (urllib), tanpa Playwright.
"""

from __future__ import annotations

import argparse
import json
import random
import string
import sys
import time
import urllib.error
import urllib.request

DEFAULT_BASE = "http://127.0.0.1:8788"
DEFAULT_HANDLE = "komiku:6426"

PASSED: list[str] = []
FAILED: list[str] = []


# --------------------------------------------------------------- util / http


def check(name: str, cond: bool, extra: str = "") -> bool:
    """Catat + cetak satu baris hasil. Return cond (biar bisa dipakai lanjut)."""
    (PASSED if cond else FAILED).append(name)
    line = "  %s  %s" % ("PASS" if cond else "FAIL", name)
    if extra:
        line += "  [%s]" % extra
    print(line, flush=True)
    return bool(cond)


def _maybe_json(raw: bytes):
    if not raw:
        return None
    try:
        return json.loads(raw.decode("utf-8"))
    except Exception:
        return None


def req(base: str, method: str, path: str, *, user=None, body=None,
        timeout: int = 30, verbose: bool = False):
    """Satu request HTTP. Return (status, json_atau_None).

    HTTPError (4xx/5xx) TIDAK di-raise: status-nya yang kita periksa. Error
    koneksi (URLError) dibiarkan naik supaya `main` bisa melaporkan server mati.
    """
    url = base.rstrip("/") + path
    data = None
    headers = {"Accept": "application/json"}
    if body is not None:
        data = json.dumps(body).encode("utf-8")
        headers["Content-Type"] = "application/json"
    if user is not None:
        headers["X-Komik-User"] = user
    r = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(r, timeout=timeout) as resp:
            status, raw = resp.status, resp.read()
    except urllib.error.HTTPError as e:
        status, raw = e.code, e.read()
    if verbose:
        print("      %-6s %s -> %s" % (method, path, status), flush=True)
    return status, _maybe_json(raw)


def probe(base: str) -> bool:
    """Server hidup? (GET /api/unified/health, timeout pendek)."""
    try:
        status, _ = req(base, "GET", "/api/unified/health", timeout=6)
        return status == 200
    except Exception:
        return False


def rand_user(tag: str) -> str:
    """Username acak valid: 3-20 char, [a-z0-9_-], diawali alnum."""
    alphabet = string.ascii_lowercase + string.digits
    return "e2e" + tag + "".join(random.choice(alphabet) for _ in range(7))


# ----------------------------------------------------------- pembaca payload


def fav_keys(js) -> set:
    if not isinstance(js, dict):
        return set()
    return {str(f.get("title_key")) for f in js.get("favorites", []) if f.get("title_key")}


def notif_keys(js) -> set:
    if not isinstance(js, dict):
        return set()
    return {str(n.get("title_key")) for n in js.get("items", []) if n.get("title_key")}


def dl_ids(js) -> set:
    if not isinstance(js, dict):
        return set()
    return {str(it.get("id")) for it in js.get("items", []) if it.get("id")}


def prog_ids(js) -> set:
    if not isinstance(js, dict):
        return set()
    return {str(e.get("seriesId")) for e in js.get("entries", []) if isinstance(e, dict)}


# ------------------------------------------------------------------ skenario


def main() -> int:
    ap = argparse.ArgumentParser(
        prog="akun_e2e.py",
        description="E2E isolasi antar-akun Komik Hub (favorit/notif/unduhan/progress).",
    )
    ap.add_argument("--base-url", default=DEFAULT_BASE,
                    help="base URL server (default %(default)s)")
    ap.add_argument("--handle", default=DEFAULT_HANDLE,
                    help="handle series untuk uji unduhan (default %(default)s)")
    ap.add_argument("--keep", action="store_true",
                    help="jangan hapus fixture akun di akhir (default: bersihkan)")
    ap.add_argument("-v", "--verbose", action="store_true",
                    help="cetak tiap request + status HTTP")
    args = ap.parse_args()

    base = args.base_url
    v = args.verbose

    if not probe(base):
        print("FATAL: server tidak merespons di %s/api/unified/health" % base, flush=True)
        print("       jalankan komiku-server dulu (port default 8788), atau pakai --base-url.", flush=True)
        return 2

    # Username acak + distinct supaya tak bertabrakan dengan akun lama.
    user_a = rand_user("a")
    user_b = rand_user("b")
    while user_b == user_a:
        user_b = rand_user("b")
    print("base      : %s" % base)
    print("akun A    : %s" % user_a)
    print("akun B    : %s" % user_b)
    print()

    # ---- 1. claim + identitas -------------------------------------------
    print("== akun ==")
    st, js = req(base, "POST", "/api/user/claim", body={"username": user_a}, verbose=v)
    check("claim A: 200 ok created=true",
          st == 200 and isinstance(js, dict) and js.get("ok") is True and js.get("created") is True,
          "status=%s body=%s" % (st, js))
    st, js = req(base, "POST", "/api/user/claim", body={"username": user_b}, verbose=v)
    check("claim B: 200 ok created=true",
          st == 200 and isinstance(js, dict) and js.get("ok") is True and js.get("created") is True,
          "status=%s body=%s" % (st, js))
    st, js = req(base, "GET", "/api/user/me", user=user_a, verbose=v)
    check("me A: 200 username A",
          st == 200 and isinstance(js, dict) and js.get("username") == user_a,
          "status=%s body=%s" % (st, js))

    # ---- 2. favorit ------------------------------------------------------
    print("== favorit ==")
    tk_a = "akun-e2e-alpha-%s" % user_a
    tk_b = "akun-e2e-beta-%s" % user_b
    fav_a = {"title_key": tk_a, "title": "Akun E2E Alpha", "cover_url": None,
             "handle": "komiku:6426", "source": "komiku"}
    fav_b = {"title_key": tk_b, "title": "Akun E2E Beta", "cover_url": None,
             "handle": "komiku:6426", "source": "komiku"}

    st, js = req(base, "PUT", "/api/notif/favorites", user=user_a,
                 body={"favorites": [fav_a]}, verbose=v)
    check("PUT favorit A: 200 ok", st == 200 and isinstance(js, dict) and js.get("ok") is True,
          "status=%s body=%s" % (st, js))
    st, js = req(base, "GET", "/api/notif/favorites", user=user_a, verbose=v)
    check("A melihat favoritnya sendiri", tk_a in fav_keys(js), "keys=%s" % sorted(fav_keys(js)))
    st, js = req(base, "GET", "/api/notif/favorites", user=user_b, verbose=v)
    check("B TIDAK melihat favorit A (no leak)", tk_a not in fav_keys(js),
          "keys=%s" % sorted(fav_keys(js)))

    # B push favoritnya. Karena replace-all PER-AKUN, push B tidak boleh
    # menghapus favorit A (bug lama: satu slot global saling menimpa).
    st, js = req(base, "PUT", "/api/notif/favorites", user=user_b,
                 body={"favorites": [fav_b]}, verbose=v)
    check("PUT favorit B: 200 ok", st == 200 and isinstance(js, dict) and js.get("ok") is True,
          "status=%s body=%s" % (st, js))
    st, js = req(base, "GET", "/api/notif/favorites", user=user_a, verbose=v)
    ka = fav_keys(js)
    check("push B tidak menghapus favorit A", tk_a in ka, "keys=%s" % sorted(ka))
    check("A TIDAK melihat favorit B", tk_b not in ka, "keys=%s" % sorted(ka))
    st, js = req(base, "GET", "/api/notif/favorites", user=user_b, verbose=v)
    kb = fav_keys(js)
    check("B melihat favoritnya sendiri", tk_b in kb, "keys=%s" % sorted(kb))
    check("B TIDAK melihat favorit A", tk_a not in kb, "keys=%s" % sorted(kb))

    # ---- 3. notifikasi ---------------------------------------------------
    print("== notifikasi ==")
    st, js_a = req(base, "GET", "/api/notif/list", user=user_a, verbose=v)
    st, js_b = req(base, "GET", "/api/notif/list", user=user_b, verbose=v)
    check("daftar notif A tidak memuat title_key B", tk_b not in notif_keys(js_a),
          "keys=%s" % sorted(notif_keys(js_a)))
    check("daftar notif B tidak memuat title_key A", tk_a not in notif_keys(js_b),
          "keys=%s" % sorted(notif_keys(js_b)))

    # Read-state per akun: A menandai SEMUA terbaca; unread B harus utuh.
    b_unread_before = (js_b or {}).get("unread") if isinstance(js_b, dict) else None
    st, js = req(base, "POST", "/api/notif/read", user=user_a, body={"all": True}, verbose=v)
    check("POST notif/read {all:true} A: 200 ok",
          st == 200 and isinstance(js, dict) and js.get("ok") is True,
          "status=%s body=%s" % (st, js))
    st, js_a2 = req(base, "GET", "/api/notif/list", user=user_a, verbose=v)
    check("unread A menjadi 0 setelah read all",
          isinstance(js_a2, dict) and js_a2.get("unread") == 0,
          "unread=%s" % ((js_a2 or {}).get("unread") if isinstance(js_a2, dict) else None))
    st, js_b2 = req(base, "GET", "/api/notif/list", user=user_b, verbose=v)
    b_unread_after = (js_b2 or {}).get("unread") if isinstance(js_b2, dict) else None
    check("read A tidak mengubah unread B (state per-akun)",
          b_unread_after == b_unread_before,
          "before=%s after=%s" % (b_unread_before, b_unread_after))

    # ---- 4. progress -----------------------------------------------------
    print("== progress ==")
    sid_a, sid_b = 990001, 990002
    prog_a = [{"seriesId": sid_a, "handle": "komiku:6426", "page": 7, "at": 111}]
    prog_b = [{"seriesId": sid_b, "handle": "komiku:6426", "page": 3, "at": 222}]
    st, js = req(base, "PUT", "/api/progress", user=user_a, body={"entries": prog_a}, verbose=v)
    check("PUT progress A: 200 ok count=1",
          st == 200 and isinstance(js, dict) and js.get("ok") is True and js.get("count") == 1,
          "status=%s body=%s" % (st, js))
    st, js = req(base, "GET", "/api/progress", user=user_a, verbose=v)
    check("A melihat progressnya sendiri", str(sid_a) in prog_ids(js),
          "ids=%s" % sorted(prog_ids(js)))
    st, js = req(base, "GET", "/api/progress", user=user_b, verbose=v)
    check("B TIDAK melihat progress A (no leak)", str(sid_a) not in prog_ids(js),
          "ids=%s" % sorted(prog_ids(js)))

    st, js = req(base, "PUT", "/api/progress", user=user_b, body={"entries": prog_b}, verbose=v)
    check("PUT progress B: 200 ok count=1",
          st == 200 and isinstance(js, dict) and js.get("ok") is True and js.get("count") == 1,
          "status=%s body=%s" % (st, js))
    st, js = req(base, "GET", "/api/progress", user=user_a, verbose=v)
    ia = prog_ids(js)
    check("progress B tidak menimpa progress A", str(sid_a) in ia, "ids=%s" % sorted(ia))
    check("A TIDAK melihat progress B", str(sid_b) not in ia, "ids=%s" % sorted(ia))
    st, js = req(base, "GET", "/api/progress", user=user_b, verbose=v)
    ib = prog_ids(js)
    check("B melihat progressnya sendiri", str(sid_b) in ib, "ids=%s" % sorted(ib))
    check("B TIDAK melihat progress A", str(sid_a) not in ib, "ids=%s" % sorted(ib))

    # ---- 5. unduhan ------------------------------------------------------
    print("== unduhan ==")
    created_ids = {"a": [], "b": []}
    st, js = req(base, "GET", "/api/unified/series/%s" % args.handle, timeout=60, verbose=v)
    nums = []
    if st == 200 and isinstance(js, dict):
        nums = [str(c.get("number")) for c in js.get("chapters", []) if c.get("number")]
    check("resolve chapter series %s" % args.handle, len(nums) >= 2,
          "%d chapter" % len(nums))

    if len(nums) >= 2:
        n_a, n_b = nums[0], nums[1]

        st, js = req(base, "POST", "/api/unified/download-pdf", user=user_a,
                     body={"handle": args.handle, "number": n_a}, timeout=300, verbose=v)
        id_a = js.get("id") if isinstance(js, dict) else None
        check("A unduh chapter %s: 200 + id" % n_a,
              st == 200 and bool(id_a), "status=%s body=%s" % (st, js))
        if id_a:
            created_ids["a"].append(id_a)

        st, js = req(base, "GET", "/api/unified/downloads", user=user_a, verbose=v)
        check("daftar unduhan A memuat unduhannya", bool(id_a) and id_a in dl_ids(js),
              "ids=%s" % sorted(dl_ids(js)))
        st, js = req(base, "GET", "/api/unified/downloads", user=user_b, verbose=v)
        check("B TIDAK melihat unduhan A (no leak)", bool(id_a) and id_a not in dl_ids(js),
              "ids=%s" % sorted(dl_ids(js)))

        st, js = req(base, "POST", "/api/unified/download-pdf", user=user_b,
                     body={"handle": args.handle, "number": n_b}, timeout=300, verbose=v)
        id_b = js.get("id") if isinstance(js, dict) else None
        check("B unduh chapter %s: 200 + id" % n_b,
              st == 200 and bool(id_b), "status=%s body=%s" % (st, js))
        if id_b:
            created_ids["b"].append(id_b)

        st, js = req(base, "GET", "/api/unified/downloads", user=user_b, verbose=v)
        ib = dl_ids(js)
        check("B melihat unduhannya sendiri", bool(id_b) and id_b in ib, "ids=%s" % sorted(ib))
        check("B TIDAK melihat unduhan A", bool(id_a) and id_a not in ib, "ids=%s" % sorted(ib))
        st, js = req(base, "GET", "/api/unified/downloads", user=user_a, verbose=v)
        ia = dl_ids(js)
        check("A melihat unduhannya sendiri", bool(id_a) and id_a in ia, "ids=%s" % sorted(ia))
        check("A TIDAK melihat unduhan B", bool(id_b) and id_b not in ia, "ids=%s" % sorted(ia))

        # Refcount: chapter yang SAMA -> satu file dibagi, tapi index tetap
        # per-akun. Hapus di A tidak boleh menghilangkan file milik B.
        st, js = req(base, "POST", "/api/unified/download-pdf", user=user_b,
                     body={"handle": args.handle, "number": n_a}, timeout=300, verbose=v)
        id_b_shared = js.get("id") if isinstance(js, dict) else None
        if check("B unduh chapter yang sama -> id identik (file dibagi)",
                 st == 200 and id_b_shared == id_a,
                 "A=%s B=%s status=%s" % (id_a, id_b_shared, st)):
            created_ids["b"].append(id_b_shared)
            st, js = req(base, "GET", "/api/unified/downloads", user=user_b, verbose=v)
            check("B melihat chapter bersama di index-nya", id_a in dl_ids(js),
                  "ids=%s" % sorted(dl_ids(js)))
            st, js = req(base, "DELETE", "/api/unified/downloads/%s" % id_a,
                         user=user_a, verbose=v)
            check("A hapus chapter bersama: 200", st == 200, "status=%s" % st)
            created_ids["a"] = [i for i in created_ids["a"] if i != id_a]
            st, js = req(base, "GET", "/api/unified/downloads", user=user_b, verbose=v)
            check("index B tetap memuatnya setelah A hapus", id_a in dl_ids(js),
                  "ids=%s" % sorted(dl_ids(js)))
            st, _ = req(base, "GET", "/api/unified/downloads/%s" % id_a,
                        user=user_b, timeout=60, verbose=v)
            check("file PDF masih bisa diambil B (refcount>0)", st == 200, "status=%s" % st)

    # ---- 6. kontrak akses 401 -------------------------------------------
    print("== akses (401/400) ==")
    unknown = rand_user("x")  # valid tapi belum terdaftar
    invalid = "../etc/passwd"  # path traversal: harus ditolak

    for path in ("/api/notif/favorites", "/api/notif/list",
                 "/api/progress", "/api/unified/downloads", "/api/user/me"):
        st, _ = req(base, "GET", path, verbose=v)
        check("tanpa header %s -> 401" % path, st == 401, "status=%s" % st)

    st, _ = req(base, "PUT", "/api/progress", body={"entries": []}, verbose=v)
    check("PUT progress tanpa header -> 401", st == 401, "status=%s" % st)

    st, _ = req(base, "GET", "/api/notif/favorites", user=unknown, verbose=v)
    check("username belum terdaftar -> 401", st == 401, "status=%s" % st)

    st, _ = req(base, "GET", "/api/progress", user=unknown, verbose=v)
    check("progress username belum terdaftar -> 401", st == 401, "status=%s" % st)

    st, _ = req(base, "GET", "/api/notif/favorites", user=invalid, verbose=v)
    check("username invalid (path traversal) -> 401", st == 401, "status=%s" % st)

    st, js = req(base, "POST", "/api/user/claim", body={"username": invalid}, verbose=v)
    check("claim username invalid -> 400", st == 400, "status=%s body=%s" % (st, js))

    # ---- 7. bersihkan fixture -------------------------------------------
    if not args.keep:
        print("== cleanup ==")
        for uid in created_ids["a"]:
            req(base, "DELETE", "/api/unified/downloads/%s" % uid, user=user_a, verbose=v)
        for uid in created_ids["b"]:
            req(base, "DELETE", "/api/unified/downloads/%s" % uid, user=user_b, verbose=v)
        for u in (user_a, user_b):
            req(base, "PUT", "/api/notif/favorites", user=u, body={"favorites": []}, verbose=v)
            req(base, "PUT", "/api/progress", user=u, body={"entries": []}, verbose=v)
        print("  fixture unduhan/favorit/progress dibersihkan "
              "(file data/users/<u>.json sengaja dibiarkan).", flush=True)

    # ---- ringkasan -------------------------------------------------------
    total = len(PASSED) + len(FAILED)
    print()
    print("%d/%d passed" % (len(PASSED), total))
    if FAILED:
        print("FAILED: " + "; ".join(FAILED))
        return 1
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except KeyboardInterrupt:
        print("\ndibatalkan", flush=True)
        sys.exit(130)
    except OSError as e:
        # URLError, ConnectionError, RemoteDisconnected, timeout — semuanya
        # OSError. Server mati / koneksi putus di tengah run = laporan bersih,
        # bukan traceback.
        print()
        print("%d/%d passed (run terputus)" % (len(PASSED), len(PASSED) + len(FAILED)), flush=True)
        if FAILED:
            print("FAILED: " + "; ".join(FAILED), flush=True)
        print("FATAL: koneksi ke server gagal: %s" % e, flush=True)
        sys.exit(2)
