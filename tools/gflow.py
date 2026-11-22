#!/usr/bin/env python3
"""gflow - CLI otomasi Google Flow via Chrome CDP attach (port 9222).
Basis: sesi login hidup di Chrome asli (junction .chrome-flow-debug-profile).
Deteksi otomatis: workspace (authenticated) vs landing /about (bukan login).
Subcommand: ping | status | list-projects | open <url> | project <uuid>
"""
import argparse, json, re, sys, time, urllib.request
import websocket

CDP_HTTP = "http://127.0.0.1:9222"
FLOW_URL  = "https://flow.google.com/"

def _tabs():
    return json.load(urllib.request.urlopen(CDP_HTTP + "/json/list", timeout=5))

def _flow_tab():
    tabs = _tabs()
    for t in tabs:
        if t.get("type") == "page" and "flow.google.com" in t.get("url", ""):
            return t
    raise SystemExit("gflow: tidak ada tab flow.google.com di port 9222 (jalankan launch dulu)")

def _cdp():
    tab = _flow_tab()
    ws = websocket.create_connection(tab["webSocketDebuggerUrl"], timeout=30)
    seq = [0]
    def cmd(method, params=None):
        seq[0] += 1
        ws.send(json.dumps({"id": seq[0], "method": method, "params": params or {}}))
        while True:
            m = json.loads(ws.recv())
            if m.get("id") == seq[0]:
                if "error" in m:
                    raise RuntimeError(m["error"])
                return m.get("result", {})
    return ws, cmd

def _eval(cmd, expr):
    r = cmd("Runtime.evaluate", {"expression": expr, "returnByValue": True})
    return r.get("result", {}).get("value")

def _nav_open(cmd, url):
    cmd("Page.navigate", {"url": url})
    # wait for load
    time.sleep(3.0)

def cmd_ping(_):
    v = json.load(urllib.request.urlopen(CDP_HTTP + "/json/version", timeout=5))
    print("ok  browser=%s" % v.get("Browser"))

def cmd_status(_):
    ws, cmd = _cdp()
    try:
        url = _eval(cmd, "location.href")
        # authenticated = anchor href accounts.google.com/SignOutOptions ada di workspace
        has_signout = _eval(cmd, "!!document.querySelector('a[href*=\"SignOutOptions\"]')")
        has_proj    = "Project baru" in (_eval(cmd, "document.body.innerText") or "")
        if has_signout and has_proj:
            print("authenticated  url=%s  workspace=YES" % url)
        elif has_signout:
            print("authenticated  url=%s  workspace=(tanpa daftar project)" % url)
        else:
            print("not-authenticated (landing)  url=%s" % url)
        print("page-title: %s" % (_eval(cmd, "document.title") or ""))
    finally:
        ws.close()

DISPLAY = {
    "Terakhir diubah": "TERAKHIR-DIUBAH",
    "Tanggal dibuat": "TANGGAL-DIBUAT",
    "Judul (A—Z)": "JUDUL-AZ",
    "Judul (Z—A)": "JUDUL-ZA",
}
DISPLAY_REV = {v: k for k, v in DISPLAY.items()}

def _workspace_cards(ev):
    """Return list of {uuid, title} for project cards."""
    raw = ev(r"""(() => {
      const c=[...document.querySelectorAll('div.project-card')];
      return JSON.stringify(c.map(x=>{
        const a=x.querySelector('a[href*="/project/"]');
        const m=a? /\/project\/([0-9a-f-]+)\/?$/.exec(a.getAttribute('href')) : null;
        const line=(x.innerText||'').trim().split('\n')[0] || '';
        return {uuid: m? m[1] : '', line};
      }));
    })()""")
    cards = json.loads(raw or "[]")
    out = []
    for c in cards:
        line = c.get("line", "")
        # first line is title when renamed, else timestamp
        title = "(untitled)" if (line and line.startswith(("Nov ", "Dec ", "Jan ", "Feb ", "Mar ", "Apr ", "May ", "Jun ", "Jul ", "Aug ", "Sep ", "Oct "))) else (line or "(untitled)")
        out.append({"uuid": c.get("uuid"), "title": title, "line": line})
    return out

def _select_sort(ev, opt_key):
    """Open sort dropdown and pick option (maps to display key)."""
    disp = DISPLAY_REV.get(opt_key)
    if not disp:
        return False
    ev("(() => { const b=[...document.querySelectorAll('button')].find(x=>(x.innerText||'').includes('Terakhir diubah')); if(b) b.click(); return !!b; })()")
    time.sleep(1.2)
    ok = ev("(() => { const opts=[...document.querySelectorAll('.mat-mdc-option')]; const o=opts.find(x=>(x.innerText||'').includes(%r)); if(o) o.click(); return !!o; })()" % disp)
    time.sleep(1.0)
    return ok

def cmd_list(args):
    ws, cmd = _cdp()
    try:
        ev = lambda e: _eval(cmd, e)
        # ensure workspace
        if not (ev("location.href") or "").rstrip("/").endswith("flow.google.com"):
            _nav_open(cmd, FLOW_URL)
        if getattr(args, "sort", None):
            _select_sort(ev, args.sort)
        cards = _workspace_cards(ev)
        if not cards:
            print("(tidak ada project terlihat di workspace)")
        for c in cards:
            print("%s\t%s\t%s" % (c["uuid"], c["title"], c["line"]))
    finally:
        ws.close()

def cmd_open(args):
    ws, cmd = _cdp()
    try:
        _nav_open(cmd, args.url)
        print("navigated -> %s" % args.url)
        print("title: %s" % (_eval(cmd, "document.title") or ""))
    finally:
        ws.close()

def cmd_project(args):
    ws, cmd = _cdp()
    try:
        url = "https://flow.google.com/project/%s" % args.uuid
        _nav_open(cmd, url)
        print("opened project %s" % args.uuid)
        print("title: %s" % (_eval(cmd, "document.title") or ""))
    finally:
        ws.close()

def cmd_create(args):
    ws, cmd = _cdp()
    try:
        _nav_open(cmd, FLOW_URL)
        if not (_eval(cmd, "location.href") or "").rstrip("/").endswith("flow.google.com"):
            _nav_open(cmd, FLOW_URL)
        ok = _eval(cmd, r"""(() => {
          const b=document.querySelector('button.new-project-button');
          if(!b) return false;
          b.click(); return true;
        })()""")
        if not ok:
            print("gflow: tombol 'Project baru' tidak ditemukan"); return
        time.sleep(4.0)
        url = _eval(cmd, "location.href") or ""
        m = __import__("re").search(r"/project/([0-9a-f-]+)", url)
        uid = m.group(1) if m else "?"
        print("created %s  (title: %s)" % (uid, _eval(cmd, "document.title") or ""))
    finally:
        ws.close()

def cmd_rename(args):
    ws, cmd = _cdp()
    try:
        _nav_open(cmd, FLOW_URL)
        # open rename dialog on target card
        ok = _eval(cmd, r"""(() => {
          const cards=[...document.querySelectorAll('div.project-card')];
          const card=cards.find(c=> { const a=c.querySelector('a[href*="/project/"]'); return a && a.getAttribute('href').endsWith(%r); });
          if(!card) return 'no-card';
          const b=[...card.querySelectorAll('button')].find(x=>x.getAttribute('aria-label')==='Edit judul project');
          if(!b) return 'no-btn';
          b.click(); return 'opened';
        })()""" % ("/" + args.uuid))
        time.sleep(1.0)
        if ok != "opened":
            print("gflow: gagal buka dialog rename (%s)" % ok); return
        # set input value via native setter + dispatch input
        inp = _eval(cmd, r"""(() => {
          const i=document.querySelector('input.title-input');
          if(!i) return false;
          const set=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set;
          set.call(i, %r);
          i.dispatchEvent(new Event('input',{bubbles:true}));
          return true;
        })()""" % args.title)
        if not inp:
            print("gflow: input.title-input tidak ditemukan"); return
        time.sleep(0.5)
        # click save button
        ok2 = _eval(cmd, r"""(() => {
          const b=[...document.querySelectorAll('button')].find(x=>x.getAttribute('aria-label')==='Simpan judul project');
          if(!b) return false; b.click(); return true;
        })()""")
        if not ok2:
            print("gflow: tombol simpan tidak ditemukan"); return
        time.sleep(1.5)
        print("renamed %s -> %s" % (args.uuid, args.title))
    finally:
        ws.close()

def cmd_delete(args):
    ws, cmd = _cdp()
    try:
        _nav_open(cmd, FLOW_URL)
        ok = _eval(cmd, r"""(() => {
          const cards=[...document.querySelectorAll('div.project-card')];
          const card=cards.find(c=> { const a=c.querySelector('a[href*="/project/"]'); return a && a.getAttribute('href').endsWith(%r); });
          if(!card) return 'no-card';
          const b=[...card.querySelectorAll('button')].find(x=>x.getAttribute('aria-label')==='Hapus project');
          if(!b) return 'no-btn';
          b.click(); return 'opened';
        })()""" % ("/" + args.uuid))
        time.sleep(1.0)
        if ok != "opened":
            print("gflow: gagal buka dialog hapus (%s)" % ok); return
        if not args.yes:
            print("konfirmasi: jalankan dengan --yes untuk menghapus permanen"); return
        conf = _eval(cmd, r"""(() => {
          const b=[...document.querySelectorAll('button')].filter(x=>(x.innerText||'').trim()==='Hapus project').pop();
          if(!b) return false; b.click(); return true;
        })()""")
        if not conf:
            print("gflow: tombol konfirmasi 'Hapus project' tidak ditemukan"); return
        time.sleep(2.0)
        print("deleted %s" % args.uuid)
    finally:
        ws.close()

def _composer(ev):
    return ev("(()=>{const d=document.querySelector('div[aria-label=\"Apa yang ingin Anda buat?\"]'); if(!d) return null; d.focus(); return true;})()")

def _type(ws, cmd, ev, text):
    js = ("(()=>{const sel=['div.ProseMirror[role=textbox]',"
          "'div[aria-label=\"Apa yang ingin Anda buat?\"]'];let d=null;"
          "for(const s of sel){d=document.querySelector(s);if(d)break;}"
          "if(!d) return false;d.focus();"
          "document.execCommand('selectAll');"
          "document.execCommand('insertText', false, %s);return true;})()" % json.dumps(text))
    ev(js)
    if not ev(js):
        ev("(()=>{const b=[...document.querySelectorAll('button')].find(x=>(x.innerText||'').includes('Buat sesi baru')); if(b) b.click(); return !!b;})()")
        time.sleep(1.5)
        ev(js)
    time.sleep(0.5)

def _enter(ws, cmd, ev):
    for t in ("keyDown", "keyUp"):
        cmd("Input.dispatchKeyEvent", {"type": t, "key": "Enter", "code": "Enter",
                                        "windowsVirtualKeyCode": 13, "nativeVirtualKeyCode": 13})

def cmd_video_generate(args):
    ws, cmd = _cdp()
    try:
        ev = lambda e: _eval(cmd, e)
        _nav_open(cmd, "https://flow.google.com/project/%s" % args.uuid)
        _type(ws, cmd, ev, args.prompt)
        _enter(ws, cmd, ev)
        print("prompt sent: %r" % args.prompt)
        if args.wait:
            # poll until assistant confirms completion: "sudah selesai dibuat"
            for _ in range(120):
                time.sleep(5)
                txt = _eval(cmd, "document.body.innerText") or ""
                if "sudah selesai dibuat" in txt or "siap untuk dilihat" in txt:
                    print("render selesai")
                    break
            else:
                print("timeout menunggu render selesai")
    finally:
        ws.close()

def cmd_media_list(args):
    ws, cmd = _cdp()
    try:
        ev = lambda e: _eval(cmd, e)
        if not ev("location.href").startswith("https://flow.google.com/project/"):
            _nav_open(cmd, "https://flow.google.com/project/%s" % args.uuid)
        time.sleep(3)
        raw = ev(r"""(() => {
          const out=[];
          for (const s of document.querySelectorAll('a[href*="/edit/"],a[href*="/media/"]')) {
            const m=s.getAttribute('href').match(/\/(edit|media)\/([0-9a-f-]+)/);
            if(!m) continue;
            out.push({type:m[1], uuid:m[2], title:(s.innerText||s.getAttribute('aria-label')||'').trim().slice(0,40)});
          }
          return JSON.stringify(out);
        })()""")
        items = json.loads(raw or "[]")
        if not items:
            print("(tidak ada media terlihat)")
        for it in items:
            print("%s\t%s\t%s" % (it["type"], it["uuid"], it["title"]))
    finally:
        ws.close()

def cmd_download(args):
    ws, cmd = _cdp()
    try:
        ev = lambda e: _eval(cmd, e)
        _nav_open(cmd, "https://flow.google.com/edit/%s" % args.uuid)
        time.sleep(4)
        # click "Download media" button (top-right toolbar)
        ok = ev("(()=>{const b=[...document.querySelectorAll('button')].find(x=>x.getAttribute('aria-label')==='Download media'); if(!b) return false; b.click(); return true;})()")
        if not ok:
            print("gflow: tombol 'Download media' tidak ditemukan"); return
        time.sleep(1.0)
        # pick quality: 270p/720p/1080p (720p = 'Ukuran asli')
        q = args.quality
        label = "720p" if q == "720p" else q
        got = ev("(()=>{const items=[...document.querySelectorAll('*')].filter(x=>(x.innerText||'').trim().includes(%r) && x.getBoundingClientRect().width>0); const it=items[items.length-1]; if(!it) return null; const r=it.getBoundingClientRect(); return {x:r.x,y:r.y,w:r.width,h:r.height};})()" % label)
        if not got:
            print("gflow: opsi kualitas %s tidak ditemukan" % q); return
        cx, cy = got["x"]+got["w"]/2, got["y"]+got["h"]/2
        cmd("Input.dispatchMouseEvent", {"type":"mouseMoved","x":cx,"y":cy})
        time.sleep(0.3)
        cmd("Input.dispatchMouseEvent", {"type":"mousePressed","x":cx,"y":cy,"button":"left","clickCount":1})
        cmd("Input.dispatchMouseEvent", {"type":"mouseReleased","x":cx,"y":cy,"button":"left","clickCount":1})
        print("download %s (%s) diklik" % (args.uuid, q))
        print("file jatuh ke ~/Downloads — cek dengan ls -lt ~/Downloads")
    finally:
        ws.close()

def cmd_trash(args):
    ws, cmd = _cdp()
    try:
        ev = lambda e: _eval(cmd, e)
        _nav_open(cmd, "https://flow.google.com/project/%s/trash" % args.uuid)
        time.sleep(3)
        if args.empty:
            if not args.yes:
                print("konfirmasi: jalankan dengan --yes untuk menghapus semua"); return
            ok = ev("(()=>{const b=[...document.querySelectorAll('button')].filter(x=>(x.innerText||'').trim()==='Hapus semua').pop(); if(!b) return false; b.click(); return true;})()")
            print("hapus semua" if ok else "tombol 'Hapus semua' tidak ditemukan")
        else:
            txt = _eval(cmd, "document.body.innerText") or ""
            if "0 item di sampah" in txt or "Sampah kosong" in txt:
                print("sampah kosong")
            else:
                print("sampah berisi item (lihat di UI)")
    finally:
        ws.close()

def cmd_character(args):
    ws, cmd = _cdp()
    try:
        ev = lambda e: _eval(cmd, e)
        url = "https://flow.google.com/project/%s/character" % args.uuid
        _nav_open(cmd, url)
        time.sleep(3)
        if args.create:
            # focus the character prompt box and type description
            if not ev("(()=>{const d=document.querySelector('div[aria-label=\"Deskripsikan karakter Anda…\"]'); if(!d) return false; d.focus(); return true;})()"):
                print("gflow: prompt karakter tidak ditemukan"); return
            cmd("Input.insertText", {"text": args.create})
            _enter(ws, cmd, ev)
            print("karakter prompt dikirim: %r" % args.create)
        else:
            print("buka halaman karakter: %s" % url)
    finally:
        ws.close()

def main():
    p = argparse.ArgumentParser(prog="gflow", description="CLI Google Flow via Chrome CDP attach (9222)")
    sub = p.add_subparsers(dest="cmd", required=True)

    sub.add_parser("ping", help="health check port CDP")
    sub.add_parser("status", help="deteksi sesi (workspace vs landing)")
    pl = sub.add_parser("list-projects", help="daftar project di workspace")
    pl.add_argument("--sort", choices=sorted(DISPLAY_REV), help="urutan project")
    po = sub.add_parser("open", help="buka URL di tab flow")
    po.add_argument("url")
    pp = sub.add_parser("project", help="buka project by uuid")
    pp.add_argument("uuid")
    sub.add_parser("create", help="buat project baru")
    pr = sub.add_parser("rename", help="ganti judul project")
    pr.add_argument("uuid")
    pr.add_argument("title")
    pd = sub.add_parser("delete", help="hapus project")
    pd.add_argument("uuid")
    pd.add_argument("--yes", action="store_true", help="ski konfirmasi (hapus permanen)")

    pv = sub.add_parser("video", help="buat video/generate konten via prompt")
    pvv = pv.add_subparsers(dest="verb", required=True)
    pvg = pvv.add_parser("generate", help="kirim prompt generate ke project")
    pvg.add_argument("uuid")
    pvg.add_argument("prompt")
    pvg.add_argument("--wait", action="store_true", help="tunggu render selesai")

    pml = sub.add_parser("media", help="daftar media di project")
    pmlv = pml.add_subparsers(dest="verb", required=True)
    pml_list = pmlv.add_parser("list", help="daftar media (video/gambar)")
    pml_list.add_argument("uuid")

    pdw = sub.add_parser("download", help="download media by uuid (kualitas)")
    pdw.add_argument("uuid")
    pdw.add_argument("--quality", choices=["270p", "720p", "1080p"], default="720p")

    ptr = sub.add_parser("trash", help="kelola sampah project")
    ptr.add_argument("uuid")
    ptr.add_argument("--empty", action="store_true", help="hapus semua item sampah")
    ptr.add_argument("--yes", action="store_true", help="ski konfirmasi empty")

    pch = sub.add_parser("character", help="buka/buat karakter reusable di project")
    pch.add_argument("uuid")
    pch.add_argument("--create", help="deskripsi karakter untuk dikirim")

    args = p.parse_args()
    if args.cmd == "video":
        {"generate": cmd_video_generate}[args.verb](args)
    elif args.cmd == "media":
        {"list": cmd_media_list}[args.verb](args)
    else:
        {"ping": cmd_ping, "status": cmd_status, "list-projects": cmd_list,
         "open": cmd_open, "project": cmd_project, "create": cmd_create,
         "rename": cmd_rename, "delete": cmd_delete, "download": cmd_download,
         "trash": cmd_trash, "character": cmd_character}[args.cmd](args)

if __name__ == "__main__":
    main()
