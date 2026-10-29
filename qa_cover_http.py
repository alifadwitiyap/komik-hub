"""QA: uji HTTP nyata semua cover_url KOMIKU & MANGAKU dari API komik-hub.

Read-only: hanya GET ke API lokal + GET ke CDN sumber. Tidak menyentuh kode.
Retry 2x untuk memisahkan kegagalan nyata dari timeout transien.
"""
import json
import glob
import collections
import subprocess

UA = (
    "Mozilla/5.0 (Linux; Android 13; SM-A536B) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36"
)

# --- 1. kumpulkan item per sumber dari banyak endpoint & halaman -----------
items = {}


def add(it):
    s = it.get("source")
    if s not in ("komiku", "mangaku"):
        return
    h = it.get("handle")
    if not h:
        return
    items.setdefault(s, {})[h] = {
        "cover_url": it.get("cover_url"),
        "title": it.get("title"),
    }


for f in sorted(glob.glob("/tmp/cat_*.json") + glob.glob("/tmp/lat_*.json")):
    try:
        d = json.load(open(f))
    except Exception:
        continue
    for it in d.get("items", []):
        add(it)

for f in sorted(glob.glob("/tmp/s_*.json")):
    try:
        d = json.load(open(f))
    except Exception:
        continue
    for it in d.get("items", []):
        add(it)


def probe(url, tries=2):
    """GET nyata. Kembalikan (code, content_type, bytes, attempts)."""
    last = ("000", "", 0, 0)
    for i in range(1, tries + 1):
        p = subprocess.run(
            [
                "curl", "-sS", "-o", "/dev/null",
                "-w", "%{http_code}|%{content_type}|%{size_download}",
                "-A", UA, "--max-time", "30", "-L", url,
            ],
            capture_output=True, text=True,
        )
        out = p.stdout.strip()
        if out.count("|") >= 2:
            code, ct, size = out.split("|")[:3]
            try:
                size = int(size)
            except ValueError:
                size = 0
        else:
            code, ct, size = "000", "", 0
        last = (code, ct, size, i)
        # sukses nyata = 200 + body gambar
        if code == "200" and ct.startswith("image/") and size > 0:
            return last
    return last


report = {}
for src, d in items.items():
    rows = []
    for h, v in d.items():
        u = v["cover_url"]
        if not u:
            rows.append({"handle": h, "title": v["title"], "url": None,
                         "code": "NO_URL", "ct": "", "bytes": 0, "tries": 0})
            continue
        code, ct, size, tries = probe(u)
        rows.append({"handle": h, "title": v["title"], "url": u,
                     "code": code, "ct": ct, "bytes": size, "tries": tries})
    report[src] = rows

json.dump(report, open("/tmp/cover_qa_report.json", "w"), ensure_ascii=False, indent=1)

# --- 2. ringkas ------------------------------------------------------------
for src, rows in report.items():
    print("=" * 70)
    print(f"{src.upper()}: {len(rows)} cover unik diuji")
    c = collections.Counter(
        (r["code"], (r["ct"] or "-").split(";")[0]) for r in rows
    )
    for k, n in sorted(c.items(), key=lambda x: -x[1]):
        print(f"   {n:4d}  HTTP {k[0]}  {k[1]}")
    bad = [r for r in rows if not (r["code"] == "200" and r["ct"].startswith("image/"))]
    print(f"   -> GAGAL: {len(bad)}/{len(rows)}")
    hosts = collections.Counter(
        (r["url"] or "-").split("/")[2] if r["url"] and "://" in r["url"] else "-"
        for r in rows
    )
    print("   host:", dict(hosts))
    for b in bad:
        print("   FAIL", b["code"], b["ct"] or "-", b["bytes"], "B |", b["handle"])
        print("        ", (b["url"] or "")[:150])
