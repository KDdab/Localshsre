#!/usr/bin/env python3
"""
LocalShare Modern Web Application Backend
High-performance, cross-platform local and cloud file sharing server.
Supports WebRTC P2P transfers, HTTP chunk streaming fallback,
Server-Sent Events (SSE) real-time signaling, room/subnet auto-discovery,
and backward-compatible UDP LAN broadcasts.
"""

import argparse
import base64
import hashlib
import json
import os
import queue
import re
import shutil
import socket
import sys
import tempfile
import threading
import time
import uuid
import webbrowser
from pathlib import Path
from typing import Dict, Any, Optional

from flask import Flask, request, jsonify, Response, send_file, render_template
from flask_cors import CORS

# -----------------------------------------------------------------------------
# Configuration & Constants
# -----------------------------------------------------------------------------
DEFAULT_PORT = 53317
DISCOVERY_PORT = 53317
ANNOUNCE_INTERVAL = 2.5
PEER_TIMEOUT = 12.0
OFFER_TTL = 120.0
CHUNK_SIZE = 512 * 1024  # 512 KB per chunk
MAX_PENDING_OFFERS = 20

app = Flask(__name__, static_folder="static", template_folder="templates")
CORS(app)

class Config:
    def __init__(self):
        self.server_id = uuid.uuid4().hex[:12]
        self.server_name = socket.gethostname()
        self.port = int(os.environ.get("PORT", DEFAULT_PORT))
        self.host = os.environ.get("HOST", "0.0.0.0")

        # Determine reliable storage directory with fallback
        custom_dir = os.environ.get("STORAGE_DIR")
        if custom_dir:
            self.storage_dir = Path(custom_dir)
            try:
                self.storage_dir.mkdir(parents=True, exist_ok=True)
            except (OSError, PermissionError):
                self.storage_dir = Path("./downloads")
                self.storage_dir.mkdir(parents=True, exist_ok=True)
        else:
            default_dir = Path.home() / "Downloads" / "LocalShare"
            try:
                default_dir.mkdir(parents=True, exist_ok=True)
                test_file = default_dir / ".write_test"
                test_file.touch()
                test_file.unlink()
                self.storage_dir = default_dir
            except (OSError, PermissionError):
                self.storage_dir = Path("./downloads")
                self.storage_dir.mkdir(parents=True, exist_ok=True)

        self.temp_dir = Path(tempfile.gettempdir()) / "localshare_transfers"
        try:
            self.temp_dir.mkdir(parents=True, exist_ok=True)
        except (OSError, PermissionError):
            self.temp_dir = Path("./temp_transfers")
            self.temp_dir.mkdir(parents=True, exist_ok=True)

        self.auto_open_browser = True
        self.enable_udp = True

CFG = Config()

# Global State (Thread-Safe)
state_lock = threading.RLock()
peers: Dict[str, Dict[str, Any]] = {}
event_queues: Dict[str, queue.Queue] = {}
offers: Dict[str, Dict[str, Any]] = {}
transfer_buffers: Dict[str, Dict[str, Any]] = {}  # offer_id -> transfer state / file paths

# -----------------------------------------------------------------------------
# Helper Utilities
# -----------------------------------------------------------------------------
def get_local_ip() -> str:
    """Detect primary local network IP address."""
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect(("10.255.255.255", 1))
        ip = s.getsockname()[0]
    except Exception:
        ip = "127.0.0.1"
    finally:
        s.close()
    return ip

def safe_filename(name: str) -> str:
    """Sanitize filename to prevent directory traversal and illegal characters."""
    name = os.path.basename(str(name).replace("\\", "/"))
    name = re.sub(r'[<>:"/\\|?*\x00-\x1f]', "_", name).strip(" .")
    return name[:200] or "file"

def get_unique_path(directory: Path, filename: str) -> Path:
    """Generate non-colliding file path in target directory."""
    try:
        directory.mkdir(parents=True, exist_ok=True)
    except (OSError, PermissionError):
        directory = Path("./downloads")
        directory.mkdir(parents=True, exist_ok=True)
    p = directory / filename
    if not p.exists():
        return p
    stem = Path(filename).stem
    suffix = Path(filename).suffix
    i = 1
    while p.exists():
        p = directory / f"{stem} ({i}){suffix}"
        i += 1
    return p

def detect_device_type(user_agent: str) -> str:
    """Identify client device type from User-Agent string."""
    ua = (user_agent or "").lower()
    if "iphone" in ua or "ipod" in ua:
        return "iphone"
    if "ipad" in ua:
        return "ipad"
    if "android" in ua:
        return "tablet" if "tablet" in ua else "mobile"
    if "macintosh" in ua or "mac os" in ua:
        return "mac"
    if "windows" in ua:
        return "windows"
    if "linux" in ua or "cros" in ua:
        return "linux"
    return "desktop"

def default_room_for_client(client_ip: str) -> str:
    """Hash client IP/subnet into a default room ID."""
    if client_ip in ("127.0.0.1", "::1", "localhost"):
        return "local"
    # Group by first 3 octets if IPv4 for local subnet auto-pairing
    parts = client_ip.split(".")
    if len(parts) == 4:
        subnet = ".".join(parts[:3])
        return hashlib.sha256(subnet.encode()).hexdigest()[:8]
    return hashlib.sha256(client_ip.encode()).hexdigest()[:8]

def emit_event(peer_id: str, event_type: str, data: Any):
    """Deliver an event to a specific connected peer via their SSE queue."""
    with state_lock:
        q = event_queues.get(peer_id)
        if q:
            try:
                q.put_nowait({"type": event_type, "data": data})
            except queue.Full:
                pass

def broadcast_room(room: str, event_type: str, data: Any, exclude_id: Optional[str] = None):
    """Deliver an event to all peers in a specific room."""
    with state_lock:
        target_peers = [
            pid for pid, p in peers.items()
            if p.get("room") == room and pid != exclude_id
        ]
    for pid in target_peers:
        emit_event(pid, event_type, data)

# -----------------------------------------------------------------------------
# Background Tasks (Peer Sweeper & UDP Discovery)
# -----------------------------------------------------------------------------
def cleanup_stale_data_loop():
    """Periodically remove expired peers, offers, and orphaned temporary files."""
    while True:
        try:
            time.sleep(3.0)
            now = time.time()
            stale_peers = []
            with state_lock:
                for pid, p in list(peers.items()):
                    if now - p.get("last_seen", 0) > PEER_TIMEOUT:
                        stale_peers.append((pid, p.get("room")))
                        del peers[pid]
                        event_queues.pop(pid, None)

                for oid, o in list(offers.items()):
                    if o["status"] == "pending" and now - o["created_at"] > OFFER_TTL:
                        o["status"] = "expired"
                    if o["status"] in ("expired", "rejected", "failed", "cancelled", "done") and now - o["created_at"] > 300:
                        del offers[oid]
                        # Clean up transfer files if any
                        t_info = transfer_buffers.pop(oid, None)
                        if t_info and "temp_files" in t_info:
                            for f_path in t_info["temp_files"].values():
                                try:
                                    if os.path.exists(f_path):
                                        os.remove(f_path)
                                except OSError:
                                    pass

            for pid, room in stale_peers:
                if room:
                    broadcast_room(room, "peer_left", {"id": pid})

        except Exception as e:
            print(f"[Cleanup Error]: {e}", file=sys.stderr)

def udp_announcer_loop():
    """Announces local node on LAN via UDP broadcasts on port 53317."""
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    sock.setsockopt(socket.SOL_SOCKET, socket.SO_BROADCAST, 1)
    while True:
        try:
            targets = {"255.255.255.255"}
            ip = get_local_ip()
            if not ip.startswith("127."):
                parts = ip.rsplit(".", 1)
                if len(parts) == 2:
                    targets.add(parts[0] + ".255")

            msg = json.dumps({
                "app": "localshare",
                "id": CFG.server_id,
                "name": CFG.server_name,
                "port": CFG.port
            }).encode()

            for target in targets:
                try:
                    sock.sendto(msg, (target, DISCOVERY_PORT))
                except OSError:
                    pass
        except Exception:
            pass
        time.sleep(ANNOUNCE_INTERVAL)

def udp_listener_loop():
    """Listens for legacy and other LocalShare UDP discovery announcements."""
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
        print(f"! UDP Discovery port {DISCOVERY_PORT} not available ({e}). Web-based discovery active.")
        return

    while True:
        try:
            data, (remote_ip, _) = sock.recvfrom(2048)
            msg = json.loads(data.decode("utf-8", errors="ignore"))
            if msg.get("app") != "localshare" or msg.get("id") == CFG.server_id:
                continue

            remote_id = f"udp_{msg['id']}"
            remote_name = str(msg.get("name", "LocalShare Device"))[:40]
            remote_port = int(msg.get("port", DEFAULT_PORT))

            with state_lock:
                peers[remote_id] = {
                    "id": remote_id,
                    "name": remote_name,
                    "room": "local",
                    "ip": remote_ip,
                    "port": remote_port,
                    "user_agent": "LocalShare CLI / Native",
                    "device_type": "desktop",
                    "is_udp_peer": True,
                    "last_seen": time.time()
                }
            broadcast_room("local", "peer_joined", peers[remote_id])
        except Exception:
            continue

# -----------------------------------------------------------------------------
# REST & SSE API Routes
# -----------------------------------------------------------------------------
@app.route("/")
def index():
    """Serves the main single-page web interface."""
    return render_template("index.html", server_name=CFG.server_name, port=CFG.port)

@app.route("/api/info", methods=["GET"])
def api_info():
    """Returns basic server information and host details."""
    return jsonify({
        "app": "localshare",
        "version": "2.0.0",
        "id": CFG.server_id,
        "name": CFG.server_name,
        "local_ip": get_local_ip(),
        "port": CFG.port,
        "storage_dir": str(CFG.storage_dir)
    })

@app.route("/api/events")
def api_events():
    """Server-Sent Events (SSE) stream for real-time signaling, presence, and offers."""
    peer_id = request.args.get("peer_id")
    if not peer_id:
        return jsonify({"error": "Missing peer_id parameter"}), 400

    q = queue.Queue(maxsize=100)
    with state_lock:
        event_queues[peer_id] = q
        if peer_id in peers:
            peers[peer_id]["last_seen"] = time.time()

    def event_stream():
        # Immediate handshake packet
        yield f"event: connected\ndata: {json.dumps({'status': 'connected', 'peer_id': peer_id})}\n\n"
        while True:
            try:
                # Wait for next event or send ping keepalive every 15s
                item = q.get(timeout=15.0)
                event_type = item.get("type", "message")
                data_json = json.dumps(item.get("data", {}))
                yield f"event: {event_type}\ndata: {data_json}\n\n"
            except queue.Empty:
                yield "event: ping\ndata: {}\n\n"
            except GeneratorExit:
                break
            except Exception as e:
                break

    return Response(event_stream(), mimetype="text/event-stream", headers={
        "Cache-Control": "no-cache",
        "X-Accel-Buffering": "no",
        "Connection": "keep-alive"
    })

@app.route("/api/peers/register", methods=["POST"])
def api_register_peer():
    """Registers or updates a connected web client."""
    data = request.get_json(force=True, silent=True) or {}
    peer_id = data.get("id") or uuid.uuid4().hex[:8]
    client_ip = request.remote_addr or "127.0.0.1"
    room = data.get("room") or default_room_for_client(client_ip)
    name = str(data.get("name") or "").strip()[:40]
    user_agent = request.headers.get("User-Agent", "")
    device_type = data.get("device_type") or detect_device_type(user_agent)

    if not name:
        name = f"{device_type.capitalize()} {peer_id[-4:]}"

    with state_lock:
        is_new = peer_id not in peers or peers[peer_id].get("room") != room
        peers[peer_id] = {
            "id": peer_id,
            "name": name,
            "room": room,
            "ip": client_ip,
            "port": CFG.port,
            "user_agent": user_agent,
            "device_type": device_type,
            "is_udp_peer": False,
            "last_seen": time.time()
        }
        peer_data = dict(peers[peer_id])

    if is_new:
        broadcast_room(room, "peer_joined", peer_data, exclude_id=peer_id)

    return jsonify({
        "ok": True,
        "peer": peer_data,
        "server_ip": get_local_ip(),
        "server_port": CFG.port,
        "room": room
    })

@app.route("/api/peers/rename", methods=["POST"])
def api_rename_peer():
    """Renames an existing peer."""
    data = request.get_json(force=True, silent=True) or {}
    peer_id = data.get("id")
    new_name = str(data.get("name") or "").strip()[:40]
    if not peer_id or not new_name:
        return jsonify({"error": "Invalid id or name"}), 400

    with state_lock:
        if peer_id in peers:
            peers[peer_id]["name"] = new_name
            peers[peer_id]["last_seen"] = time.time()
            room = peers[peer_id].get("room")
            peer_data = dict(peers[peer_id])
        else:
            return jsonify({"error": "Peer not found"}), 404

    broadcast_room(room, "peer_updated", peer_data)
    return jsonify({"ok": True, "peer": peer_data})

@app.route("/api/state", methods=["GET"])
def api_state():
    """Returns current active peers in the requested room."""
    room = request.args.get("room")
    my_id = request.args.get("peer_id")
    client_ip = request.remote_addr or "127.0.0.1"
    if not room:
        room = default_room_for_client(client_ip)

    now = time.time()
    with state_lock:
        if my_id and my_id in peers:
            peers[my_id]["last_seen"] = now

        room_peers = [
            dict(p) for pid, p in peers.items()
            if p.get("room") == room and pid != my_id and now - p.get("last_seen", 0) <= PEER_TIMEOUT
        ]

    return jsonify({
        "server": {
            "name": CFG.server_name,
            "ip": get_local_ip(),
            "port": CFG.port,
            "storage_dir": str(CFG.storage_dir)
        },
        "room": room,
        "peers": room_peers
    })

# -----------------------------------------------------------------------------
# Offer & Transfer Negotiation
# -----------------------------------------------------------------------------
@app.route("/api/offer", methods=["POST"])
def api_create_offer():
    """Sender initiates a file transfer or text offer."""
    data = request.get_json(force=True, silent=True) or {}
    from_peer = data.get("from_peer")
    target_peer = data.get("target_peer")
    offer_type = data.get("type", "file")  # "file" or "text"
    text_content = data.get("text", "")
    raw_files = data.get("files", [])

    if not from_peer or not target_peer:
        return jsonify({"error": "Missing from_peer or target_peer"}), 400

    sanitized_files = []
    if offer_type == "file":
        for f in raw_files[:500]:
            try:
                size = int(f.get("size", 0))
                if size < 0:
                    continue
                name = safe_filename(f.get("name", "file"))
                mime = str(f.get("type", "application/octet-stream"))
                sanitized_files.append({
                    "name": name,
                    "size": size,
                    "type": mime,
                    "received": 0,
                    "state": "waiting"
                })
            except (ValueError, TypeError):
                continue
        if not sanitized_files:
            return jsonify({"error": "No valid files specified"}), 400

    offer_id = uuid.uuid4().hex

    with state_lock:
        pending_count = sum(1 for o in offers.values() if o["target_peer"] == target_peer and o["status"] == "pending")
        if pending_count >= MAX_PENDING_OFFERS:
            return jsonify({"error": "Target peer is currently busy with other offers"}), 429

        offer = {
            "id": offer_id,
            "from_peer": from_peer,
            "from_name": peers.get(from_peer, {}).get("name", "Unknown Device"),
            "target_peer": target_peer,
            "type": offer_type,
            "text": text_content[:50000] if offer_type == "text" else "",
            "files": sanitized_files,
            "status": "pending",
            "created_at": time.time(),
            "use_relay": False
        }
        offers[offer_id] = offer

    # Notify recipient via SSE
    emit_event(target_peer, "offer_received", offer)

    return jsonify({"ok": True, "offer": offer})

@app.route("/api/offer/<oid>", methods=["GET"])
def api_get_offer(oid):
    """Checks the status of an offer."""
    with state_lock:
        offer = offers.get(oid)
        if not offer:
            return jsonify({"status": "unknown"}), 404
        if offer["status"] == "pending" and time.time() - offer["created_at"] > OFFER_TTL:
            offer["status"] = "expired"
        return jsonify(offer)

@app.route("/api/offer/<oid>/respond", methods=["POST"])
def api_respond_offer(oid):
    """Recipient accepts or rejects an offer."""
    data = request.get_json(force=True, silent=True) or {}
    accept = bool(data.get("accept"))
    use_relay = bool(data.get("use_relay", False))

    with state_lock:
        offer = offers.get(oid)
        if not offer:
            return jsonify({"error": "Offer not found"}), 404
        if offer["status"] != "pending":
            return jsonify({"error": f"Offer is already {offer['status']}"}), 409

        if accept and offer["type"] == "file":
            # Check available disk space
            try:
                total_bytes = sum(f["size"] for f in offer["files"])
                free_space = shutil.disk_usage(CFG.storage_dir).free
                if free_space < total_bytes:
                    offer["status"] = "failed"
                    emit_event(offer["from_peer"], "offer_response", {"id": oid, "status": "failed", "error": "Insufficient disk space"})
                    return jsonify({"error": "Not enough disk space"}), 507
            except Exception:
                pass

        offer["status"] = "accepted" if accept else "rejected"
        offer["use_relay"] = use_relay

        # Prepare buffer storage if relay is used
        if accept and offer["type"] == "file":
            CFG.temp_dir.mkdir(parents=True, exist_ok=True)
            transfer_buffers[oid] = {
                "temp_files": {},
                "completed": set(),
                "created_at": time.time()
            }

    # Notify sender of response
    emit_event(offer["from_peer"], "offer_response", {
        "id": oid,
        "status": offer["status"],
        "use_relay": use_relay
    })

    return jsonify({"ok": True, "status": offer["status"]})

@app.route("/api/offer/<oid>/cancel", methods=["POST"])
def api_cancel_offer(oid):
    """Cancels a pending offer."""
    with state_lock:
        offer = offers.get(oid)
        if offer and offer["status"] in ("pending", "accepted"):
            offer["status"] = "cancelled"
            emit_event(offer["target_peer"], "offer_cancelled", {"id": oid})
            emit_event(offer["from_peer"], "offer_cancelled", {"id": oid})

    return jsonify({"ok": True})

# -----------------------------------------------------------------------------
# WebRTC Signaling Relay
# -----------------------------------------------------------------------------
@app.route("/api/signal", methods=["POST"])
def api_signal():
    """Relays WebRTC SDP offers, answers, and ICE candidates between peers."""
    data = request.get_json(force=True, silent=True) or {}
    target_id = data.get("target_id")
    from_id = data.get("from_id")
    signal_type = data.get("type")  # "offer", "answer", "candidate"
    signal_data = data.get("data")

    if not target_id or not from_id or not signal_type:
        return jsonify({"error": "Invalid signaling payload"}), 400

    emit_event(target_id, "signal", {
        "from_id": from_id,
        "type": signal_type,
        "data": signal_data
    })
    return jsonify({"ok": True})

# -----------------------------------------------------------------------------
# HTTP Chunked Transfer (Fallback Engine)
# -----------------------------------------------------------------------------
@app.route("/api/transfer/<oid>/<int:file_idx>/chunk", methods=["POST"])
def api_upload_chunk(oid, file_idx):
    """Receives binary or base64 chunk for HTTP relay transfer."""
    with state_lock:
        offer = offers.get(oid)
        if not offer or offer["status"] != "accepted":
            return jsonify({"error": "Transfer not authorized or expired"}), 403
        if file_idx < 0 or file_idx >= len(offer["files"]):
            return jsonify({"error": "Invalid file index"}), 400
        file_meta = offer["files"][file_idx]

    t_info = transfer_buffers.get(oid)
    if not t_info:
        return jsonify({"error": "Transfer session expired"}), 410

    # Read binary stream or payload
    chunk_bytes = request.get_data()
    if not chunk_bytes:
        return jsonify({"error": "Empty chunk"}), 400

    chunk_offset = int(request.headers.get("X-Chunk-Offset", 0))
    is_last = request.headers.get("X-Chunk-Last", "false").lower() == "true"

    temp_path = t_info["temp_files"].get(file_idx)
    if not temp_path:
        CFG.temp_dir.mkdir(parents=True, exist_ok=True)
        temp_file = tempfile.NamedTemporaryFile(delete=False, dir=CFG.temp_dir, prefix=f"ls_{oid}_{file_idx}_")
        temp_path = temp_file.name
        temp_file.close()
        t_info["temp_files"][file_idx] = temp_path

    # Write chunk at offset
    with open(temp_path, "r+b" if os.path.exists(temp_path) and os.path.getsize(temp_path) > 0 else "wb") as f:
        f.seek(chunk_offset)
        f.write(chunk_bytes)

    with state_lock:
        file_meta["received"] = min(file_meta["size"], chunk_offset + len(chunk_bytes))
        file_meta["state"] = "receiving" if not is_last else "done"

    # Notify recipient of chunk progress
    emit_event(offer["target_peer"], "transfer_chunk", {
        "offer_id": oid,
        "file_idx": file_idx,
        "offset": chunk_offset,
        "chunk_len": len(chunk_bytes),
        "total_received": file_meta["received"],
        "total_size": file_meta["size"],
        "is_last": is_last
    })

    if is_last:
        t_info["completed"].add(file_idx)
        # Also save copy to server storage if local server directory exists
        try:
            dest_path = get_unique_path(CFG.storage_dir, file_meta["name"])
            shutil.copyfile(temp_path, dest_path)
            file_meta["saved_path"] = str(dest_path)
        except Exception:
            pass

        # Check if all files in offer are done
        with state_lock:
            if len(t_info["completed"]) >= len(offer["files"]):
                offer["status"] = "done"
                emit_event(offer["from_peer"], "transfer_completed", {"offer_id": oid})
                emit_event(offer["target_peer"], "transfer_completed", {"offer_id": oid})

    return jsonify({"ok": True, "received": file_meta["received"]})

@app.route("/api/transfer/<oid>/<int:file_idx>/download", methods=["GET"])
def api_download_file(oid, file_idx):
    """Allows recipient browser to download the relayed file."""
    with state_lock:
        offer = offers.get(oid)
        if not offer:
            return jsonify({"error": "Offer not found"}), 404
        if file_idx < 0 or file_idx >= len(offer["files"]):
            return jsonify({"error": "Invalid file index"}), 400
        file_meta = offer["files"][file_idx]

    t_info = transfer_buffers.get(oid)
    if not t_info or file_idx not in t_info["temp_files"]:
        # Fallback to local storage if available
        if "saved_path" in file_meta and os.path.exists(file_meta["saved_path"]):
            return send_file(
                file_meta["saved_path"],
                as_attachment=True,
                download_name=file_meta["name"],
                mimetype=file_meta.get("type", "application/octet-stream")
            )
        return jsonify({"error": "File data not found or expired"}), 404

    temp_path = t_info["temp_files"][file_idx]
    if not os.path.exists(temp_path):
        return jsonify({"error": "File expired"}), 404

    return send_file(
        temp_path,
        as_attachment=True,
        download_name=file_meta["name"],
        mimetype=file_meta.get("type", "application/octet-stream")
    )

# -----------------------------------------------------------------------------
# Instant Text / Message Sharing
# -----------------------------------------------------------------------------
@app.route("/api/message", methods=["POST"])
def api_send_message():
    """Direct instant text / clipboard message transfer."""
    data = request.get_json(force=True, silent=True) or {}
    from_peer = data.get("from_peer")
    target_peer = data.get("target_peer")
    content = str(data.get("text", "")).strip()

    if not from_peer or not target_peer or not content:
        return jsonify({"error": "Missing fields"}), 400

    sender_name = peers.get(from_peer, {}).get("name", "Nearby Device")
    emit_event(target_peer, "text_message", {
        "from_id": from_peer,
        "from_name": sender_name,
        "text": content[:50000],
        "timestamp": time.time()
    })
    return jsonify({"ok": True})

# -----------------------------------------------------------------------------
# Main Entry Point
# -----------------------------------------------------------------------------
def main():
    parser = argparse.ArgumentParser(description="LocalShare Web Application - Modern Local & Cloud File Sharing")
    parser.add_argument("--name", default=socket.gethostname(), help="Device name (default: hostname)")
    parser.add_argument("--port", type=int, default=int(os.environ.get("PORT", DEFAULT_PORT)), help="Port to listen on")
    parser.add_argument("--host", default=os.environ.get("HOST", "0.0.0.0"), help="Host to bind to (0.0.0.0 for LAN/Cloud)")
    parser.add_argument("--dir", default=str(Path.home() / "Downloads" / "LocalShare"), help="Download directory")
    parser.add_argument("--no-browser", action="store_true", help="Do not launch browser automatically")
    parser.add_argument("--no-udp", action="store_true", help="Disable UDP discovery broadcast (e.g. for cloud deployments)")

    args = parser.parse_args()

    CFG.server_name = args.name[:40]
    CFG.port = args.port
    CFG.host = args.host
    CFG.storage_dir = Path(args.dir).expanduser()
    CFG.storage_dir.mkdir(parents=True, exist_ok=True)
    CFG.temp_dir.mkdir(parents=True, exist_ok=True)
    CFG.auto_open_browser = not args.no_browser and not os.environ.get("HEADLESS")
    CFG.enable_udp = not args.no_udp and not os.environ.get("DISABLE_UDP")

    # Start background cleanup sweeper
    threading.Thread(target=cleanup_stale_data_loop, daemon=True, name="Sweeper").start()

    # Start UDP discovery if enabled
    if CFG.enable_udp:
        threading.Thread(target=udp_listener_loop, daemon=True, name="UDPListener").start()
        threading.Thread(target=udp_announcer_loop, daemon=True, name="UDPAnnouncer").start()

    local_url = f"http://localhost:{CFG.port}"
    network_url = f"http://{get_local_ip()}:{CFG.port}"

    print("=" * 65)
    print("  🚀 LocalShare Web Application is Running!")
    print(f"  • Device Name   : {CFG.server_name}")
    print(f"  • Local Web UI  : {local_url}")
    print(f"  • Network URL   : {network_url}")
    print(f"  • Storage Path  : {CFG.storage_dir}")
    print(f"  • Cloud / Docker: Set PORT={CFG.port} & HOST=0.0.0.0")
    print("=" * 65)

    if CFG.auto_open_browser:
        threading.Timer(1.0, lambda: webbrowser.open(local_url)).start()

    # Run the Flask app with multi-threaded WSGI server
    app.run(host=CFG.host, port=CFG.port, threaded=True, debug=False)

if __name__ == "__main__":
    main()
