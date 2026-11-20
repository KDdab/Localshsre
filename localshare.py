#!/usr/bin/env python3
"""
LocalShare - send files between devices on the same Wi-Fi. No internet, no accounts.

Run on every device:
    python localshare.py

Then open http://localhost:53317 (it opens automatically).
Requires Python 3.8+. No third-party packages.

How it works
    Discovery : every device broadcasts a small UDP "I'm here" message every 2 seconds
                and listens for the others.
    Offer     : the sender asks the receiver "may I send you these files?"
    Accept    : the receiver clicks Accept or Reject.
    Transfer  : the sender's browser streams each file straight to the receiver over HTTP.
"""
import argparse
import json
import os
import re
import shutil
import socket
import sys
import threading
import time
import uuid
import webbrowser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from types import SimpleNamespace
from urllib.parse import urlsplit

DISCOVERY_PORT = 53317      # UDP port used for "I'm here" broadcasts
ANNOUNCE_EVERY = 2.0        # seconds between broadcasts
PEER_TIMEOUT = 7.0          # forget a device after this many silent seconds
OFFER_TTL = 90              # an unanswered offer expires after this many seconds
CHUNK = 256 * 1024          # bytes read per step while receiving
MAX_PENDING = 10            # protects against offer spam from the network

CFG = SimpleNamespace(name="", port=53317, dir=Path("."), id=uuid.uuid4().hex)
lock = threading.Lock()
peers = {}                  # id -> {id, name, ip, port, seen}
offers = {}                 # id -> offer dict (see create_offer)


# ----------------------------------------------------------------------------
# helpers
# ----------------------------------------------------------------------------
def local_ip():
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect(("10.255.255.255", 1))   # no packet is sent; just picks the Wi-Fi interface
        return s.getsockname()[0]
    except OSError:
        return "127.0.0.1"
    finally:
        s.close()


def safe_name(name):
    name = os.path.basename(str(name).replace("\\", "/"))
    name = re.sub(r'[<>:"/\\|?*\x00-\x1f]', "_", name).strip(" .")
    return name[:200] or "file"


def unique_path(directory, name):
    p = directory / name
    i = 1
    while p.exists():
        p = directory / f"{Path(name).stem} ({i}){Path(name).suffix}"
        i += 1
    return p


def refresh_offer(o):
    """Call with the lock held."""
    if o["status"] == "pending" and time.time() - o["created"] > OFFER_TTL:
        o["status"] = "expired"
    return o


# ----------------------------------------------------------------------------
# discovery (UDP broadcast)
# ----------------------------------------------------------------------------
def announcer():
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    sock.setsockopt(socket.SOL_SOCKET, socket.SO_BROADCAST, 1)
    msg = json.dumps({"app": "localshare", "id": CFG.id, "name": CFG.name, "port": CFG.port}).encode()
    while True:
        targets = {"255.255.255.255"}
        ip = local_ip()
        if not ip.startswith("127."):
            targets.add(ip.rsplit(".", 1)[0] + ".255")   # assumes a /24 home or hotspot network
        for t in targets:
            try:
                sock.sendto(msg, (t, DISCOVERY_PORT))
            except OSError:
                pass
        time.sleep(ANNOUNCE_EVERY)


def listener():
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    if hasattr(socket, "SO_REUSEPORT"):
        try:
            sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEPORT, 1)
        except OSError:
            pass
    try:
        sock.bind(("", DISCOVERY_PORT))
    except OSError as e:
        print(f"! Could not listen for other devices ({e}). You can still add devices by IP.")
        return
    while True:
        data, (ip, _) = sock.recvfrom(2048)
        try:
            m = json.loads(data)
            if m.get("app") != "localshare" or m.get("id") == CFG.id:
                continue
            port = int(m["port"])
            if not 0 < port < 65536:
                continue
            with lock:
                peers[m["id"]] = {"id": str(m["id"]), "name": str(m.get("name", "Unknown"))[:40],
                                  "ip": ip, "port": port, "seen": time.time()}
        except (ValueError, KeyError, TypeError):
            continue


# ----------------------------------------------------------------------------
# state shown in the local UI
# ----------------------------------------------------------------------------
def snapshot():
    now = time.time()
    ip = local_ip()
    with lock:
        for pid in [k for k, p in peers.items() if now - p["seen"] > PEER_TIMEOUT]:
            del peers[pid]
        for oid in list(offers):
            o = refresh_offer(offers[oid])
            if o["status"] not in ("pending", "accepted") and now - o["created"] > 600:
                del offers[oid]
        return {
            "me": {"name": CFG.name, "ip": ip, "port": CFG.port, "dir": str(CFG.dir)},
            "peers": [{k: p[k] for k in ("id", "name", "ip", "port")} for p in peers.values()],
            "incoming": [
                {"id": o["id"], "from": o["from"], "status": o["status"],
                 "files": [{"name": f["name"], "size": f["size"], "received": f["received"]} for f in o["files"]]}
                for o in sorted(offers.values(), key=lambda x: x["created"])
            ][-10:],
        }


# ----------------------------------------------------------------------------
# HTTP server: serves the UI to this device and the transfer API to other devices
# ----------------------------------------------------------------------------
class Handler(BaseHTTPRequestHandler):
    timeout = 60   # drop stalled connections

    def log_message(self, *args):
        pass

    def _cors(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.send_header("Access-Control-Allow-Private-Network", "true")

    def _send(self, code, body=b"", ctype="application/json"):
        if isinstance(body, (dict, list)):
            body = json.dumps(body).encode()
        elif isinstance(body, str):
            body = body.encode()
        self.send_response(code)
        self.send_header("Content-Type", ctype + ("; charset=utf-8" if ctype != "application/json" else ""))
        self.send_header("Content-Length", str(len(body)))
        self._cors()
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def _is_local(self):
        return self.client_address[0] in ("127.0.0.1", "::1")

    def _json(self):
        n = int(self.headers.get("Content-Length") or 0)
        if n > 1_000_000:
            raise ValueError("too large")
        return json.loads(self.rfile.read(n) or b"{}")

    def _parts(self):
        return [p for p in urlsplit(self.path).path.split("/") if p]

    def do_OPTIONS(self):
        self._send(204)

    # ---- GET --------------------------------------------------------------
    def do_GET(self):
        parts = self._parts()
        if not parts:
            return self._send(200, PAGE, "text/html") if self._is_local() else self._send(403, {"error": "local only"})
        if parts == ["api", "info"]:
            return self._send(200, {"app": "localshare", "id": CFG.id, "name": CFG.name})
        if parts == ["api", "state"]:
            return self._send(200, snapshot()) if self._is_local() else self._send(403, {"error": "local only"})
        if len(parts) == 3 and parts[:2] == ["api", "offer"]:
            with lock:
                o = offers.get(parts[2])
                status = refresh_offer(o)["status"] if o else "unknown"
            return self._send(200, {"status": status})
        self._send(404, {"error": "not found"})

    # ---- POST -------------------------------------------------------------
    def do_POST(self):
        parts = self._parts()
        try:
            if parts == ["api", "offer"]:
                return self._create_offer()
            if len(parts) == 4 and parts[:2] == ["api", "offer"] and parts[3] == "respond":
                return self._respond(parts[2])
            if len(parts) == 4 and parts[:2] == ["api", "offer"] and parts[3] == "cancel":
                return self._cancel(parts[2])
            if len(parts) == 4 and parts[:2] == ["api", "upload"]:
                return self._upload(parts[2], int(parts[3]))
        except (ValueError, KeyError, TypeError):
            return self._send(400, {"error": "bad request"})
        self._send(404, {"error": "not found"})

    def _create_offer(self):
        data = self._json()
        files = []
        for f in list(data.get("files", []))[:500]:
            size = int(f["size"])
            if size < 0:
                raise ValueError
            files.append({"name": safe_name(f["name"]), "size": size, "received": 0, "state": "waiting", "path": None})
        if not files:
            raise ValueError
        with lock:
            if sum(1 for o in offers.values() if refresh_offer(o)["status"] == "pending") >= MAX_PENDING:
                return self._send(429, {"error": "too many pending requests"})
            oid = uuid.uuid4().hex
            offers[oid] = {"id": oid, "from": str(data.get("from", "Unknown"))[:40], "files": files,
                           "status": "pending", "created": time.time()}
        self._send(200, {"id": oid})

    def _respond(self, oid):
        if not self._is_local():
            return self._send(403, {"error": "only the receiving device can answer"})
        accept = bool(self._json().get("accept"))
        with lock:
            o = offers.get(oid)
            if not o or refresh_offer(o)["status"] != "pending":
                return self._send(409, {"error": "this request is no longer open"})
            if accept:
                need = sum(f["size"] for f in o["files"])
                if shutil.disk_usage(CFG.dir).free < need:
                    o["status"] = "failed"
                    return self._send(507, {"error": "not enough disk space"})
            o["status"] = "accepted" if accept else "rejected"
        self._send(200, {"ok": True})

    def _cancel(self, oid):
        with lock:
            o = offers.get(oid)
            if o and o["status"] == "pending":
                o["status"] = "cancelled"
        self._send(200, {"ok": True})

    def _upload(self, oid, idx):
        with lock:
            o = offers.get(oid)
            f = None
            if o and o["status"] == "accepted" and 0 <= idx < len(o["files"]):
                f = o["files"][idx]
                if f["state"] != "waiting":
                    f = None
                else:
                    f["state"] = "receiving"
        if f is None:
            return self._send(403, {"error": "upload not allowed"})
        if int(self.headers.get("Content-Length") or -1) != f["size"]:
            with lock:
                f["state"] = "waiting"
            return self._send(400, {"error": "size does not match the offer"})

        path = unique_path(CFG.dir, f["name"])
        try:
            with open(path, "wb") as out:
                remaining = f["size"]
                while remaining > 0:
                    chunk = self.rfile.read(min(CHUNK, remaining))
                    if not chunk:
                        raise ConnectionError("sender disconnected")
                    out.write(chunk)
                    remaining -= len(chunk)
                    with lock:
                        f["received"] += len(chunk)
        except Exception:
            try:
                path.unlink()
            except OSError:
                pass
            with lock:
                f["state"] = "failed"
                o["status"] = "failed"
            return
        with lock:
            f["state"], f["path"] = "done", str(path)
            if all(x["state"] == "done" for x in o["files"]):
                o["status"] = "done"
        self._send(200, {"ok": True})


# ----------------------------------------------------------------------------
# the web UI (served only to this device)
# ----------------------------------------------------------------------------
PAGE = r"""<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>LocalShare</title>
<style>
:root{--bg:#eef2f1;--card:#fff;--text:#13211f;--muted:#5d6e6b;--line:#d8e1df;--accent:#0b7a6b;--accent-ink:#fff;--accent-soft:#dff3ee;--danger:#b42318;--track:#dfe7e5}
@media(prefers-color-scheme:dark){:root{--bg:#0e1514;--card:#162120;--text:#e6efed;--muted:#8fa3a0;--line:#26373a;--accent:#2fd0b5;--accent-ink:#06211c;--accent-soft:#12302c;--danger:#ff8a80;--track:#223332}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--text);font:15px/1.5 "Segoe UI Variable","Segoe UI",system-ui,-apple-system,sans-serif}
.wrap{max-width:620px;margin:0 auto;padding:28px 16px 80px}
h1{font-size:24px;margin:0;letter-spacing:-.01em}
h2{font-size:15px;margin:0 0 10px;font-weight:600}
.muted{color:var(--muted);font-size:13px}
section{margin-top:26px}
.card{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:16px}
.peer{display:flex;align-items:center;gap:12px;padding:12px 14px;border:1px solid var(--line);border-radius:12px;background:var(--card);cursor:pointer;margin-bottom:8px}
.peer:hover{border-color:var(--accent)}
.peer.sel{border-color:var(--accent);background:var(--accent-soft)}
.dot{width:10px;height:10px;border-radius:50%;background:#22c55e;flex:none}
.pn{font-weight:600}
.empty{padding:18px;border:1px dashed var(--line);border-radius:12px;color:var(--muted)}
.row{display:flex;gap:8px;align-items:center}
.row.end{justify-content:flex-end}
.grow{flex:1;min-width:0}
input[type=text]{flex:1;padding:9px 12px;border:1px solid var(--line);border-radius:10px;background:var(--card);color:var(--text);font:inherit}
button{font:inherit;padding:9px 16px;border-radius:10px;border:1px solid var(--line);background:var(--card);color:var(--text);cursor:pointer}
button:hover{border-color:var(--accent)}
button.primary{background:var(--accent);color:var(--accent-ink);border-color:var(--accent);font-weight:600}
button.danger{color:var(--danger)}
button:disabled{opacity:.45;cursor:not-allowed}
button:focus-visible,input:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
.drop{padding:26px 16px;text-align:center;border:2px dashed var(--line);border-radius:14px;color:var(--muted);background:var(--card)}
.drop.over{border-color:var(--accent);background:var(--accent-soft)}
.file{display:flex;align-items:center;gap:10px;padding:8px 2px;border-bottom:1px solid var(--line)}
.file:last-child{border-bottom:0}
.fn{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.x{padding:2px 9px;border:0;background:none;color:var(--muted);font-size:18px}
.bar{height:14px;border-radius:7px;background:var(--track);overflow:hidden;margin:12px 0 6px}
.bar i{display:block;height:100%;width:0;background:var(--accent);border-radius:7px;transition:width .2s}
.big{font-size:20px;font-weight:600}
.ok{color:var(--accent);font-weight:600}
.err{color:var(--danger)}
.modal{position:fixed;inset:0;background:rgba(5,15,14,.55);display:flex;align-items:center;justify-content:center;padding:16px;z-index:10}
.modal .card{width:100%;max-width:400px;padding:22px}
.name{font-size:17px;font-weight:600;word-break:break-all}
</style></head>
<body><div class="wrap">
<header><h1>LocalShare</h1><div class="muted" id="me">Starting…</div></header>

<section>
  <h2>Nearby devices</h2>
  <div id="peers"></div>
  <div class="row" style="margin-top:6px"><input type="text" id="ip" placeholder="Not listed? Add by IP, like 192.168.1.20"><button data-act="add">Add</button></div>
  <div class="err muted" id="adderr"></div>
</section>

<section>
  <h2>Files to send</h2>
  <div class="drop" id="drop">Drop files here<br><button data-act="pick" style="margin-top:10px">Choose files</button></div>
  <input type="file" id="picker" multiple hidden>
  <div id="files"></div>
  <div class="row end" style="margin-top:12px"><button class="primary" id="send" data-act="send" disabled>Send</button></div>
</section>

<section id="txsec" hidden><h2>Sending</h2><div class="card" id="tx"></div></section>
<section id="incsec" hidden><h2>Receiving</h2><div id="inc"></div></section>
</div>
<div id="overlay"></div>

<script>
const $=id=>document.getElementById(id);
const esc=s=>String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const U=['B','KB','MB','GB','TB'];
function fmt(b){let i=0;while(b>=1024&&i<4){b/=1024;i++}return +b.toFixed(i<2?0:1)+' '+U[i]}
function prog(done,total){let i=0,t=total;while(t>=1024&&i<4){t/=1024;i++}const f=x=>+x.toFixed(i<2?0:1);return f(done/1024**i)+' / '+f(t)+' '+U[i]}
const pct=(d,t)=>t?Math.min(100,Math.floor(d/t*100)):100;

let S={me:{},peers:[],incoming:[]},last='',selected=null,picked=[],manual=[],tx=null;
const dismissed=new Set();

function allPeers(){const m=new Map();S.peers.forEach(p=>m.set(p.id,p));manual.forEach(p=>{if(!m.has(p.id))m.set(p.id,p)});return[...m.values()]}

function renderPeers(){
  const ps=allPeers();
  if(selected&&!ps.some(p=>p.id===selected))selected=null;
  $('peers').innerHTML=ps.length?ps.map(p=>`<div class="peer ${p.id===selected?'sel':''}" data-act="peer" data-id="${esc(p.id)}"><span class="dot"></span><div><div class="pn">${esc(p.name)}</div><div class="muted">${esc(p.ip)}</div></div></div>`).join(''):`<div class="empty">Looking for devices… Open LocalShare on the other device and connect both to the same Wi-Fi.</div>`;
  updateSend();
}
function renderFiles(){
  $('files').innerHTML=picked.length?`<div class="card" style="margin-top:10px">${picked.map((f,i)=>`<div class="file"><span class="fn">${esc(f.name)}</span><span class="muted">${fmt(f.size)}</span><button class="x" data-act="rm" data-i="${i}" aria-label="Remove ${esc(f.name)}">×</button></div>`).join('')}</div>`:'';
  updateSend();
}
function updateSend(){
  const p=allPeers().find(p=>p.id===selected),busy=tx&&(tx.phase==='waiting'||tx.phase==='sending');
  const b=$('send');b.disabled=!(p&&picked.length)||!!busy;
  b.textContent=p?'Send to '+p.name:'Send';
}
function renderMe(){const m=S.me;$('me').textContent=m.name?`You are ${m.name} · ${m.ip} · saving to ${m.dir}`:'Starting…'}

function txHtml(){
  const t=tx;
  if(t.phase==='waiting')return`<div class="big">Waiting for ${esc(t.peer)}…</div><div class="muted">They need to accept the request.</div><div class="row end"><button data-act="cancel">Cancel</button></div>`;
  if(t.phase==='sending')return`<div class="muted">To ${esc(t.peer)}</div><div class="bar"><i id="txbar"></i></div><div class="row"><span class="big" id="txpct"></span><span class="grow"></span><span id="txnum"></span></div><div class="muted" id="txspd"></div><div class="row end"><button data-act="cancel">Cancel</button></div>`;
  if(t.phase==='done')return`<div class="ok big">✅ File transferred successfully</div><div class="muted">${esc(prog(t.total,t.total))} sent to ${esc(t.peer)}</div><div class="row end"><button data-act="txdone">Done</button></div>`;
  if(t.phase==='rejected')return`<div class="big">${esc(t.peer)} declined the files</div><div class="row end"><button data-act="txdone">OK</button></div>`;
  if(t.phase==='noreply')return`<div class="big">No response from ${esc(t.peer)}</div><div class="muted">The request timed out.</div><div class="row end"><button data-act="txdone">OK</button></div>`;
  return`<div class="err big">Transfer failed</div><div class="muted">${esc(t.msg||'')}</div><div class="row end"><button data-act="txdone">OK</button></div>`;
}
function renderTx(){
  $('txsec').hidden=!tx;
  if(!tx){$('tx').innerHTML='';updateSend();return}
  if(tx.shown!==tx.phase){tx.shown=tx.phase;$('tx').innerHTML=txHtml();updateSend()}
  if(tx.phase==='sending'){
    $('txbar').style.width=pct(tx.done,tx.total)+'%';
    $('txpct').textContent=pct(tx.done,tx.total)+'%';
    $('txnum').textContent=prog(tx.done,tx.total);
    $('txspd').textContent=fmt(tx.speed)+'/s';
  }
}

function incoming(){
  const pend=S.incoming.find(o=>o.status==='pending');
  if(pend){
    const tot=pend.files.reduce((a,f)=>a+f.size,0);
    const list=pend.files.slice(0,4).map(f=>`<div class="file"><span class="fn name">${esc(f.name)}</span><span class="muted">${fmt(f.size)}</span></div>`).join('')+(pend.files.length>4?`<div class="muted">+${pend.files.length-4} more · ${fmt(tot)} total</div>`:'');
    $('overlay').innerHTML=`<div class="modal"><div class="card"><h2>Incoming file</h2><div class="muted" style="margin-bottom:8px">From ${esc(pend.from)}</div>${list}<div class="row end" style="margin-top:16px"><button class="danger" data-act="reject" data-id="${pend.id}">Reject</button><button class="primary" data-act="accept" data-id="${pend.id}">Accept</button></div></div></div>`;
    document.title='Incoming file · LocalShare';
  }else{$('overlay').innerHTML='';document.title='LocalShare'}
  const shown=S.incoming.filter(o=>['accepted','done','failed'].includes(o.status)&&!dismissed.has(o.id)).reverse();
  $('incsec').hidden=!shown.length;
  $('inc').innerHTML=shown.map(o=>{
    const tot=o.files.reduce((a,f)=>a+f.size,0),got=o.files.reduce((a,f)=>a+f.received,0);
    const names=o.files.slice(0,3).map(f=>esc(f.name)).join(', ')+(o.files.length>3?` +${o.files.length-3} more`:'');
    let body=`<div class="bar"><i style="width:${pct(got,tot)}%"></i></div><div class="row"><span class="big">${pct(got,tot)}%</span><span class="grow"></span><span>${prog(got,tot)}</span></div>`;
    if(o.status==='done')body=`<div class="ok big" style="margin-top:8px">✅ File transferred successfully</div><div class="muted">Saved to ${esc(S.me.dir)}</div><div class="row end"><button data-act="dismiss" data-id="${o.id}">Dismiss</button></div>`;
    if(o.status==='failed')body=`<div class="err big" style="margin-top:8px">Transfer failed</div><div class="muted">The sender disconnected or the disk is full.</div><div class="row end"><button data-act="dismiss" data-id="${o.id}">Dismiss</button></div>`;
    return`<div class="card" style="margin-bottom:10px"><div class="pn">${names}</div><div class="muted">From ${esc(o.from)}</div>${body}</div>`;
  }).join('');
}

function renderAll(){renderMe();renderPeers();incoming()}
async function poll(){try{const t=await(await fetch('/api/state')).text();if(t!==last){last=t;S=JSON.parse(t);renderAll()}}catch(e){}}
setInterval(poll,500);poll();

function upload(url,file,onProg,reg){return new Promise((res,rej)=>{
  const x=new XMLHttpRequest();reg(x);x.open('POST',url);
  x.setRequestHeader('Content-Type','application/octet-stream');
  x.upload.onprogress=e=>onProg(e.loaded);
  x.onload=()=>x.status===200?res():rej(new Error('The other device refused the upload ('+x.status+')'));
  x.onerror=()=>rej(new Error('Connection lost'));
  x.onabort=()=>rej(new Error('Cancelled'));
  x.send(file);
})}

async function send(){
  const peer=allPeers().find(p=>p.id===selected);if(!peer||!picked.length)return;
  const files=picked.slice(),total=files.reduce((a,f)=>a+f.size,0);
  const t=tx={peer:peer.name,phase:'waiting',done:0,total,speed:0,xhr:null,offer:null};
  renderTx();
  const base=`http://${peer.ip}:${peer.port}`;
  try{
    const r=await fetch(base+'/api/offer',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({from:S.me.name,files:files.map(f=>({name:f.name,size:f.size}))})});
    if(!r.ok)throw new Error('That device is busy or refused the request');
    const{id}=await r.json();t.offer=id;
    let st='pending';
    while(st==='pending'&&tx===t){await sleep(500);st=(await(await fetch(`${base}/api/offer/${id}`)).json()).status}
    if(tx!==t)return;
    if(st==='rejected')t.phase='rejected';
    else if(st!=='accepted')t.phase='noreply';
    else{
      t.phase='sending';renderTx();
      let sent=0;const start=Date.now();
      for(let i=0;i<files.length;i++){
        await upload(`${base}/api/upload/${id}/${i}`,files[i],l=>{t.done=sent+l;t.speed=t.done/Math.max((Date.now()-start)/1000,.25);renderTx()},x=>t.xhr=x);
        sent+=files[i].size;t.done=sent;
      }
      t.phase='done';picked=[];renderFiles();
    }
  }catch(e){if(tx!==t)return;t.phase='error';t.msg=e.message==='Failed to fetch'?'Could not reach that device. Check it is still online.':e.message}
  renderTx();
}

async function addIp(){
  const v=$('ip').value.trim();if(!v)return;$('adderr').textContent='';
  const[ip,port]=v.split(':');
  try{
    const i=await(await fetch(`http://${ip}:${port||53317}/api/info`)).json();
    if(i.app!=='localshare')throw 0;
    manual.push({id:i.id,name:i.name,ip,port:+(port||53317)});$('ip').value='';renderPeers();
  }catch(e){$('adderr').textContent='No LocalShare found at '+v+'. Check the address and that it is running there.'}
}

function addFiles(list){picked=picked.concat([...list]);renderFiles()}
$('picker').onchange=e=>{addFiles(e.target.files);e.target.value=''};
const drop=$('drop');
['dragover','dragenter'].forEach(ev=>drop.addEventListener(ev,e=>{e.preventDefault();drop.classList.add('over')}));
['dragleave','drop'].forEach(ev=>drop.addEventListener(ev,e=>{e.preventDefault();drop.classList.remove('over')}));
drop.addEventListener('drop',e=>addFiles(e.dataTransfer.files));
$('ip').addEventListener('keydown',e=>{if(e.key==='Enter')addIp()});

async function respond(id,accept){
  const r=await fetch(`/api/offer/${id}/respond`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({accept})});
  if(!r.ok){const j=await r.json().catch(()=>({}));alert(j.error||'Could not answer this request')}
  last='';poll();
}

document.addEventListener('click',e=>{
  const el=e.target.closest('[data-act]');if(!el)return;
  const a=el.dataset.act;
  if(a==='pick')$('picker').click();
  else if(a==='rm'){picked.splice(+el.dataset.i,1);renderFiles()}
  else if(a==='peer'){selected=el.dataset.id;renderPeers()}
  else if(a==='send')send();
  else if(a==='add')addIp();
  else if(a==='accept')respond(el.dataset.id,true);
  else if(a==='reject')respond(el.dataset.id,false);
  else if(a==='dismiss'){dismissed.add(el.dataset.id);incoming()}
  else if(a==='txdone'){tx=null;renderTx()}
  else if(a==='cancel'&&tx){
    const t=tx;tx=null;
    if(t.xhr)t.xhr.abort();
    if(t.phase==='waiting'&&t.offer){const p=allPeers().find(p=>p.name===t.peer);if(p)fetch(`http://${p.ip}:${p.port}/api/offer/${t.offer}/cancel`,{method:'POST'}).catch(()=>{})}
    renderTx();
  }
});
renderFiles();
</script></body></html>
"""


# ----------------------------------------------------------------------------
def main():
    ap = argparse.ArgumentParser(description="LocalShare - send files to devices on your Wi-Fi.")
    ap.add_argument("--name", default=socket.gethostname(), help="name other devices see (default: computer name)")
    ap.add_argument("--port", type=int, default=53317, help="HTTP port (default 53317)")
    ap.add_argument("--dir", default=str(Path.home() / "Downloads" / "LocalShare"), help="where received files are saved")
    ap.add_argument("--no-browser", action="store_true", help="do not open the browser automatically")
    args = ap.parse_args()

    CFG.name, CFG.port, CFG.dir = args.name[:40], args.port, Path(args.dir).expanduser()
    CFG.dir.mkdir(parents=True, exist_ok=True)

    try:
        httpd = ThreadingHTTPServer(("0.0.0.0", CFG.port), Handler)
    except OSError as e:
        sys.exit(f"Port {CFG.port} is already in use ({e}). Is LocalShare already running? Or try --port {CFG.port + 1}")

    threading.Thread(target=listener, daemon=True).start()
    threading.Thread(target=announcer, daemon=True).start()

    url = f"http://localhost:{CFG.port}"
    print(f"LocalShare is running as '{CFG.name}'")
    print(f"  Open      : {url}")
    print(f"  Your IP   : {local_ip()}:{CFG.port}   (other devices can add you by this address)")
    print(f"  Saving to : {CFG.dir}")
    print("  Press Ctrl+C to stop.")
    if not args.no_browser:
        threading.Timer(0.8, lambda: webbrowser.open(url)).start()
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\nStopped.")


if __name__ == "__main__":
    main()
