"""render_show(show) -> HTML halaman tonton statis (warna asli refrensi)."""
from __future__ import annotations

_CSS = """
* { margin:0; padding:0; box-sizing:border-box; }
body { font-family:system-ui,-apple-system,'Segoe UI',Roboto,sans-serif; background:#0c0f17; color:#e8edf5; line-height:1.5; }
a { color:inherit; text-decoration:none; }
.hero { position:relative; min-height:420px; display:flex; align-items:flex-end; padding:40px 5vw 24px; overflow:hidden; }
.hero::before { content:""; position:absolute; inset:0; background-image:url('@BACKDROP@'); background-size:cover; background-position:center 30%; filter:brightness(.45); transform:scale(1.02); }
.hero::after { content:""; position:absolute; inset:auto 0 0 0; height:60%; background:linear-gradient(transparent,#0c0f17); }
.hero-inner { position:relative; z-index:2; display:flex; gap:24px; align-items:flex-end; max-width:1200px; margin:0 auto; width:100%; }
.poster { width:170px; border-radius:10px; box-shadow:0 12px 30px rgba(0,0,0,.6); border:1px solid #262d3d; }
.hero-info h1 { font-size:2rem; letter-spacing:.3px; }
.meta { color:#9aa8c2; margin:6px 0 14px; font-size:.92rem; }
.meta b { color:#e8edf5; }
.badges { display:flex; flex-wrap:wrap; gap:6px; }
.badge { background:#1b2231; border:1px solid #2b3547; padding:3px 10px; border-radius:999px; font-size:.8rem; color:#c6d2e8; }
.playbig { display:inline-flex; align-items:center; gap:8px; background:#f5b14c; color:#12161f; font-weight:700; padding:10px 18px; border-radius:8px; margin-top:14px; font-size:.95rem; transition:background .15s; }
.playbig:hover { background:#ffc56d; }
.wrap { max-width:1200px; margin:0 auto; padding:24px 5vw 60px; }
.section { margin-bottom:36px; }
.section h2 { font-size:1.15rem; color:#f5b14c; margin-bottom:14px; border-bottom:1px solid #1f2738; padding-bottom:8px; }
.overview { max-width:760px; color:#c2ccdf; font-size:.98rem; }
.tabs { display:flex; flex-wrap:wrap; gap:8px; margin-bottom:16px; }
.stab { background:#1b2231; border:1px solid #2b3547; color:#c6d2e8; padding:6px 14px; border-radius:8px; cursor:pointer; font-size:.9rem; }
.stab.active { background:#f5b14c; color:#12161f; border-color:#f5b14c; font-weight:700; }
.spane { display:none; }
.spane.active { display:block; }
.grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(200px,1fr)); gap:14px; }
.ep-card { background:#141a26; border:1px solid #232c3f; border-radius:10px; overflow:hidden; transition:transform .12s, border-color .12s; }
.ep-card:hover { transform:translateY(-2px); border-color:#f5b14c; }
.thumb { aspect-ratio:16/9; background-size:cover; background-position:center; display:flex; align-items:center; justify-content:center; }
.thumb .playbtn { width:42px; height:42px; border-radius:50%; background:rgba(0,0,0,.55); color:#fff; display:flex; align-items:center; justify-content:center; font-size:16px; opacity:.85; border:1px solid rgba(255,255,255,.25); }
.ep-card:hover .playbtn { background:#f5b14c; color:#12161f; opacity:1; }
.epmeta { padding:10px 12px; }
.epnum { color:#f5b14c; font-weight:700; font-size:.85rem; }
.eptitle { font-size:.88rem; color:#e0e7f2; margin-top:3px; display:-webkit-box; -webkit-line-clamp:2; -webkit-box-orient:vertical; overflow:hidden; }
.rel-grid { display:flex; flex-wrap:wrap; gap:10px; }
.rel-card { background:#141a26; border:1px solid #232c3f; padding:8px 16px; border-radius:8px; font-size:.9rem; color:#c6d2e8; }
.rel-card:hover { border-color:#f5b14c; color:#fff; }
footer { border-top:1px solid #1f2738; padding:20px 5vw; color:#7d8aa3; font-size:.8rem; text-align:center; }
"""

def _ep_card(e):
    return (
        '<a class="ep-card" href="{url}" target="_blank">'
        '<div class="thumb" style="background-image:url(\'{still}\')">'
        '<span class="playbtn">▶</span></div>'
        '<div class="epmeta"><div class="epnum">Ep {n}</div>'
        '<div class="eptitle">{title}</div></div></a>'
    ).format(url=e["watch_url"], still=e["still"], n=e["episode"], title=e["title"])

def render_show(show):
    seasons = show["seasons"]
    gen = ", ".join(show.get("genres", []))
    meta = "{year} · {gen} · {rating}★ · {seasons} seasons · {eps} episodes".format(
        year=show["year"], gen=gen, rating=show["rating"],
        seasons=show["seasons_count"], eps=show["episodes_count"])

    tabs = []
    panes = []
    for i, s in enumerate(seasons):
        act = " active" if i == 0 else ""
        tabs.append('<button class="stab%s" data-season="%d">S%d</button>' % (act, s["season"], s["season"]))
        cards = "\n".join(_ep_card(e) for e in s["episodes"])
        panes.append('<div class="spane%s" data-season="%d"><div class="grid">\n%s\n</div></div>' % (act, s["season"], cards))

    # latest 6 by (season, episode)
    latest = sorted((s["season"], e["episode"], e) for s in seasons for e in s["episodes"])[-6:]
    latest_cards = "\n".join(_ep_card(e) for _, _, e in latest)

    rel = "\n".join(
        '<a class="rel-card" href="%s" target="_blank">%s (%d)</a>' % (r["href"], r["title"], r["year"])
        for r in show["related"])

    css = _CSS.replace("@BACKDROP@", show["backdrop"])
    return """<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>{title}</title><style>{css}</style></head>
<body>
<div class="hero"><div class="hero-inner">
<img class="poster" src="{poster}" alt="{title}">
<div class="hero-info"><h1>{title}</h1>
<div class="meta">{meta}</div>
<div class="badges"><span class="badge">{created}</span>
<span class="badge">{network}</span><span class="badge">{language}</span></div>
<a class="playbig" href="?play=1" target="_blank">▶ Play</a>
</div></div></div>
<div class="wrap">
<section class="section"><h2>Overview</h2><p class="overview">{overview}</p></section>
<section class="section">
<h2>Episodes</h2>
<div class="tabs">{tabs}</div>
{panes}
</section>
<section class="section"><h2>Latest</h2><div class="grid">
{latest}
</div></section>
<section class="section"><h2>More Like This</h2><div class="rel-grid">
{rel}
</div></section>
</div>
<footer>Data: TMDB via Flystream · {title} — watch on <a href="https://flystream.net/tv/60625">Flystream</a></footer>
<script>
document.querySelectorAll('.stab').forEach(function(btn){{
  btn.onclick=function(){{
    var s=btn.getAttribute('data-season');
    document.querySelectorAll('.stab').forEach(function(b){{b.classList.toggle('active',b==btn)}});
    document.querySelectorAll('.spane').forEach(function(p){{p.classList.toggle('active',p.getAttribute('data-season')==s)}});
  }};
}});
</script>
</body></html>""".format(
        title=show["title"], css=css, poster=show["poster"],
        meta=meta, created="Created by " + show["created_by"],
        network="Network: " + show["network"], language="Original language: " + show["language"],
        overview=show["synopsis"], tabs="\n".join(tabs), panes="\n".join(panes),
        latest=latest_cards, rel=rel)
