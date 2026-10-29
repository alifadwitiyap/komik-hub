"""QA per sumber: health, search, series, chapter, cover, gambar halaman.

Bukti HTTP nyata. Read-only.
"""
import json
import subprocess
import urllib.parse

B = "http://localhost:8788"
HDR = ["-H", "X-Komik-User: qa_netral_42"]
UA = ("Mozilla/5.0 (Linux; Android 13; SM-S908B) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36")


def sh(*args, timeout=90):
    try:
        r = subprocess.run(["curl", "-sS", "-m", str(timeout), *args],
                           capture_output=True, text=True, timeout=timeout + 15)
        return r.stdout
    except subprocess.TimeoutExpired:
        return ""


def get_json(path, timeout=90):
    raw = sh(f"{B}{path}", *HDR, timeout=timeout)
    try:
        return json.loads(raw)
    except Exception:
        return None


def probe(url, referer=None, timeout=40):
    args = [url, "-o", "/dev/null", "-A", UA,
            "-w", "%{http_code}|%{content_type}|%{size_download}|%{time_total}"]
    if referer:
        args += ["-H", f"Referer: {referer}"]
    out = sh(*args, timeout=timeout)
    return out.strip() if out else "TIMEOUT"


SOURCES = {
    "komiku": ["one piece", "tower"],
    "mangaku": ["solo", "tower"],
    "shinigami": ["solo", "necromancer"],
    "kiryuu": ["villain", "reincarnation"],
}

report = {}

for src, queries in SOURCES.items():
    print(f"\n{'='*60}\n### {src}\n{'='*60}")
    r = {"health": None, "search": None, "series": None, "chapter": None,
         "cover": None, "pages": None, "problems": []}

    # 1. health
    h = get_json("/api/unified/health?force=1", timeout=90)
    if h:
        for s in h.get("sources", []):
            if s.get("source") == src:
                r["health"] = {"ok": s.get("ok"), "latency_ms": s.get("latency_ms"),
                               "error": s.get("error")}
                print(f"health   : ok={s.get('ok')} {s.get('latency_ms')}ms "
                      f"err={str(s.get('error'))[:60]}")
                if not s.get("ok"):
                    r["problems"].append(f"health ok=false: {s.get('error')}")

    # 2. search
    handles = []
    for q in queries:
        d = get_json(f"/api/unified/search?q={urllib.parse.quote(q)}")
        if not d:
            r["problems"].append(f"search '{q}' tidak balas JSON")
            continue
        items = [i for i in (d.get("items") or []) if i.get("source") == src]
        print(f"search '{q}': {len(items)} item")
        for i in items[:2]:
            handles.append((i.get("handle"), i.get("cover_url")))
    r["search"] = {"handles_found": len(handles)}
    if not handles:
        r["problems"].append("search tidak menghasilkan handle untuk sumber ini")

    # 3. series (maks 2)
    ser_ok = 0
    covers = []
    for handle, cover in handles[:2]:
        enc = urllib.parse.quote(handle, safe="")
        d = get_json(f"/api/unified/series/{enc}", timeout=120)
        if not d:
            r["problems"].append(f"series {handle}: tidak balas JSON")
            continue
        m = d.get("manga") or {}
        ch = d.get("chapters") or []
        cu = m.get("cover_url")
        print(f"series {handle[:38]:38} title={str(m.get('title'))[:28]:28} "
              f"chapters={len(ch):4} cover={'ADA' if cu else 'NULL'}")
        if not m.get("title"):
            r["problems"].append(f"series {handle}: title kosong")
        if len(ch) == 0:
            r["problems"].append(f"series {handle}: 0 chapter")
        if not cu:
            r["problems"].append(f"series {handle}: cover_url NULL")
        else:
            covers.append(cu)
        if ch:
            ser_ok += 1
            # 4. chapter pertama
            num = ch[0].get("number") if isinstance(ch[0], dict) else None
            if num:
                cd = get_json(f"/api/unified/chapter/{enc}/{urllib.parse.quote(str(num), safe='')}",
                              timeout=150)
                if cd:
                    imgs = cd.get("images") or []
                    print(f"chapter {num}: {len(imgs)} gambar")
                    if not imgs:
                        r["problems"].append(f"chapter {handle}/{num}: 0 gambar")
                    else:
                        r["chapter"] = {"number": num, "images": len(imgs),
                                        "hosts": sorted({u.split('/')[2] for u in imgs})}
                        r["pages"] = []
                        for u in imgs[:2]:
                            p = probe(u)
                            r["pages"].append(p)
                            print(f"  page -> {p}")
                            if not p.startswith("200|image/"):
                                r["problems"].append(f"gambar halaman gagal: {p[:40]}")
                else:
                    r["problems"].append(f"chapter {handle}/{num}: tidak balas JSON")

    # 5. cover
    r["cover"] = []
    for cu in covers[:2]:
        p = probe(cu)
        r["cover"].append(p)
        print(f"cover    -> {p}")
        if not p.startswith("200|image/"):
            r["problems"].append(f"cover gagal: {p[:40]}")

    r["series"] = {"ok": ser_ok}
    report[src] = r

print("\n\n" + "="*60)
print("RINGKASAN")
print("="*60)
for src, r in report.items():
    n = len(r["problems"])
    print(f"{src:11} masalah={n}")
    for p in r["problems"]:
        print(f"    - {p}")

with open("/tmp/qa_sources_report.json", "w") as f:
    json.dump(report, f, indent=1)
print("\nsaved /tmp/qa_sources_report.json")
