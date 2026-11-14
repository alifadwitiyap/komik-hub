"""RickMortyProvider — coba FlyStreamBackend live, jatuh ke fallback statis."""
from __future__ import annotations
import json, os
from cli_anything.flystream.utils.flystream_backend import FlyStreamBackend

_HERE = os.path.dirname(os.path.abspath(__file__))
_FALLBACK = os.path.join(_HERE, "fallback_data.json")

class RickMortyProvider:
    def __init__(self, backend=None, fallback_path=_FALLBACK):
        self.backend = backend or FlyStreamBackend()
        with open(fallback_path, encoding="utf-8") as fh:
            self.fallback = json.load(fh)

    def _live_show(self) -> dict | None:
        try:
            tv = self.backend.tv_details(60625)
        except Exception:
            return None
        out = dict(self.fallback)
        out["title"] = tv.get("name") or out["title"]
        out["synopsis"] = tv.get("overview") or out["synopsis"]
        if tv.get("vote_average"):
            out["rating"] = round(tv["vote_average"], 1)
        if tv.get("poster_path"):
            out["poster"] = self.backend.tmdb_image_url("w500", tv["poster_path"])
        if tv.get("backdrop_path"):
            out["backdrop"] = self.backend.tmdb_image_url("w1280", tv["backdrop_path"])
        return out

    def get_show(self) -> dict:
        live = self._live_show()
        if live:
            return live
        return dict(self.fallback)
