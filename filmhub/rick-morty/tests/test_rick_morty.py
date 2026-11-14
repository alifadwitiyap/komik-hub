"""Smoke tests for rick-morty fallback data & provider.
Run: python rick-morty/tests/test_rick_morty.py
"""
import json, os, sys
HERE = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.join(HERE, "..", "data", "fallback_data.json")

def check(name, fn):
    global passed, failed
    try:
        fn(); passed += 1; print(f"ok   {name}")
    except AssertionError as e:
        failed += 1; print(f"FAIL {name}: {e}")

passed = failed = 0

def t_shape():
    d = json.load(open(DATA, encoding="utf-8"))
    assert d["tmdb_id"] == 60625
    assert d["title"] == "Rick and Morty"
    assert len(d["seasons"]) == 9
    assert [len(s["episodes"]) for s in d["seasons"]] == \
        [11,10,10,10,10,10,10,10,10]
    total = sum(len(s["episodes"]) for s in d["seasons"])
    assert total == 91
    assert len(d["related"]) == 12
    assert "poster" in d and "backdrop" in d
check("fallback shape & episode counts", t_shape)

def t_episode_keys():
    d = json.load(open(DATA, encoding="utf-8"))
    e = d["seasons"][0]["episodes"][0]
    for k in ("episode", "title", "still", "watch_url"):
        assert k in e, k
    assert e["watch_url"] == "https://flystream.net/tv/60625?season=1&episode=1&play=1"
check("episode fields", t_episode_keys)

print(f"\n{passed} passed, {failed} failed")
sys.exit(1 if failed else 0)
