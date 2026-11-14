#!/usr/bin/env python3
"""CLI generator halaman tonton statis Rick and Morty.

Contoh:
  python -m rick_morty.render.generate                # tulis rick-morty/output.html
  python -m rick_morty.render.generate --json --out rick-morty/data/show.json
  python -m rick_morty.render.generate --live          # coba backend live, jatuh ke fallback
"""
from __future__ import annotations
import argparse, json, os, sys

_HERE = os.path.dirname(os.path.abspath(__file__))
_ROOT = os.path.abspath(os.path.join(_HERE, "..", "..", ".."))  # filmhub root
if _ROOT not in sys.path:
    sys.path.insert(0, _ROOT)

_DATA = os.path.join(_HERE, "..", "data")
_RENDER = _HERE
for _p in (_ROOT, _DATA, _RENDER):
    if _p not in sys.path:
        sys.path.insert(0, _p)

from provider import RickMortyProvider  # noqa: E402
from template import render_show  # noqa: E402

def main(argv=None):
    ap = argparse.ArgumentParser(description="Rick and Morty static watch page")
    ap.add_argument("--out", default=os.path.join(_HERE, "..", "output.html"),
                    help="output file (HTML, or JSON with --json)")
    ap.add_argument("--live", action="store_true", help="try live Flystream backend")
    ap.add_argument("--json", action="store_true", help="write show JSON instead of HTML")
    args = ap.parse_args(argv)

    prov = RickMortyProvider()
    show = prov.get_show() if args.live else prov.fallback

    out = os.path.normpath(args.out)
    os.makedirs(os.path.dirname(out), exist_ok=True)
    if args.json:
        with open(out, "w", encoding="utf-8") as fh:
            json.dump(show, fh, ensure_ascii=False, indent=2)
    else:
        with open(out, "w", encoding="utf-8") as fh:
            fh.write(render_show(show))
    print("wrote %s" % out)
    return 0

if __name__ == "__main__":
    sys.exit(main())
