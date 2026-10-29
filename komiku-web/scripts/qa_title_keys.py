import json
import subprocess
import urllib.parse
import collections

B = "http://localhost:8788"
H = ["-H", "X-Komik-User: qa_netral_42"]


def get(p, timeout=60):
    r = subprocess.run(["curl", "-sS", "-m", str(timeout), f"{B}{p}", *H],
                       capture_output=True, text=True, timeout=timeout + 10)
    try:
        return json.loads(r.stdout)
    except Exception:
        return None


# Bandingkan pakai title_key (yang dipakai failover), bukan title mentah
QUERIES = ["solo leveling", "tower", "villain", "necromancer", "reincarnation"]
allkeys = collections.defaultdict(lambda: collections.defaultdict(list))

for q in QUERIES:
    d = get(f"/api/unified/search?q={urllib.parse.quote(q)}")
    if not d:
        continue
    for it in d.get("items") or []:
        tk = it.get("title_key") or ""
        if tk:
            allkeys[tk][it.get("source")].append(it.get("title"))

print("=== title_key yang dipakai >1 sumber ===")
multi = {k: v for k, v in allkeys.items() if len(v) >= 2}
if multi:
    for k, v in list(multi.items())[:10]:
        print(f"  {k[:44]:44} sumber={sorted(v)}")
else:
    print("  TIDAK ADA title_key yang sama lintas sumber")

print(f"\ntotal title_key unik: {len(allkeys)}")

# Tampilkan beberapa judul mirip lintas sumber untuk lihat perbedaan ejaan
print("\n=== contoh judul yang MIRIP (manual look) ===")
titles = []
for q in QUERIES:
    d = get(f"/api/unified/search?q={urllib.parse.quote(q)}")
    if not d:
        continue
    for it in d.get("items") or []:
        titles.append((it.get("source"), it.get("title"), it.get("title_key")))

# cari pasangan yang share >=2 kata
seen = set()
shown = 0
for i in range(len(titles)):
    for j in range(i + 1, len(titles)):
        s1, t1, k1 = titles[i]
        s2, t2, k2 = titles[j]
        if s1 == s2 or not t1 or not t2:
            continue
        w1 = set(k1.split()) if k1 else set()
        w2 = set(k2.split()) if k2 else set()
        common = w1 & w2
        if len(common) >= 2:
            pair = tuple(sorted([t1, t2]))
            if pair in seen:
                continue
            seen.add(pair)
            print(f"  [{s1}] {t1[:42]:42} <-> [{s2}] {t2[:42]}")
            shown += 1
            if shown >= 8:
                break
    if shown >= 8:
        break
if shown == 0:
    print("  (tidak ada judul yang berbagi >=2 kata lintas sumber)")
