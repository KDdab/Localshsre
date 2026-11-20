# 🚀 LocalShare — Modern Local & Cloud File Sharing

> Instant, secure, and private peer-to-peer file & text sharing between phones, tablets, laptops, and desktops. No cloud storage needed, no account registration, and zero third-party tracking.

---

## 🌟 Overview & Key Enhancements Over Original Script

The original `localshare.py` was a monolithic Python CLI script using UDP broadcasts and standard library HTTP servers. While a great concept, it had significant practical limitations when used across real-world devices:

| Feature / Problem | Original `localshare.py` | New Modern LocalShare Web |
| :--- | :--- | :--- |
| **Mobile Access (iOS / Android)** | ❌ Blocked (`403 local only`). Required Python running on the phone. | ✅ **Works on any mobile/desktop browser** (Safari, Chrome, Edge, Firefox) by opening the URL or scanning a QR code. |
| **Transfer Architecture** | ⚠️ HTTP streaming to raw IP:port. Failed with browser **Mixed Content** on HTTPS and **Private Network Access (PNA)** blocks. | ✅ **Dual Engine**: High-speed **WebRTC DataChannel P2P** transfer + automatic **HTTP Chunked Relay** fallback. |
| **Network Partitioning / Cloud** | ❌ UDP broadcast fails across VLANs, corporate/university Wi-Fi isolation, and cloud hosting. | ✅ **Subnet Auto-Discovery** + **Custom Room Codes / QR Codes** so devices connect across any network or cloud deployment. |
| **Real-Time Signaling** | ⚠️ Constant 500ms CPU-polling loop (`/api/state`). | ✅ **Server-Sent Events (SSE)** with push notifications (< 5ms latency, zero polling lag). |
| **File Storage on Mobile** | ❌ Files were saved only on the PC running the Python process. | ✅ **Native in-browser download** triggers automatically on phones and laptops when files arrive. |
| **Clipboard / Text Sharing** | ❌ Not supported (files only). | ✅ **Instant text & link sharing** with one-click clipboard copying. |
| **Audio & Visual Feedback** | ❌ Barebones UI without notifications. | ✅ **Glassmorphic responsive UI**, radar waves, Web Audio synthesized chimes, and dark/light themes. |
| **Deployment Readiness** | ❌ Single-process localhost script. | ✅ **Docker**, **Docker Compose**, **Render**, **Railway**, and **Fly.io** ready with production WSGI support. |

---

## 🚀 Quick Start (Local Run)

### 1. Requirements
- Python 3.8+ (tested on Python 3.8 – 3.14)

### 2. Install Dependencies
```bash
pip install -r requirements.txt
```

### 3. Start the Server
```bash
python app.py
```

The app will start on port `53317` and automatically launch your browser at:
- **Local Web UI**: `http://localhost:53317`
- **Network URL**: `http://<YOUR_LOCAL_IP>:53317`

To connect a phone or another laptop, just scan the **QR Code** on the screen or open the Network URL on your phone's browser!

---

## 🐳 Docker Deployment

Run with Docker in seconds:

```bash
# Build and run with Docker
docker build -t localshare .
docker run -d -p 53317:53317 -v $(pwd)/downloads:/root/Downloads/LocalShare localshare
```

Or using **Docker Compose**:
```bash
docker-compose up -d
```

---

## ☁️ Cloud Deployment (Render / Railway / Fly.io / VPS)

LocalShare is cloud-ready out of the box and respects standard environment variables (`$PORT`, `$HOST`):

### Deploy to Render
1. Create a **New Web Service** pointing to your repository.
2. Select **Python 3** environment.
3. Build Command: `pip install -r requirements.txt`
4. Start Command: `python app.py --no-browser --no-udp`

### Deploy to Railway
1. Click **New Project** -> Deploy from GitHub repo.
2. Railway will automatically detect the `Dockerfile` or `Procfile` and deploy it.

### Deploy to a Linux VPS (Ubuntu / Debian)
```bash
git clone <repo-url>
cd localshare
pip install -r requirements.txt
# Run as a background service with Waitress or Gunicorn:
python app.py --host 0.0.0.0 --port 53317 --no-browser
```

---

## 🛠️ CLI Options & Environment Variables

| Argument | Environment Variable | Default | Description |
| :--- | :--- | :--- | :--- |
| `--port` | `PORT` | `53317` | Port for the HTTP & WebSocket/SSE server |
| `--host` | `HOST` | `0.0.0.0` | Bind IP address (`0.0.0.0` binds to all interfaces) |
| `--name` | - | Computer Name | Custom friendly name visible to nearby peers |
| `--dir` | `STORAGE_DIR` | `~/Downloads/LocalShare` | Target folder for saving received files |
| `--no-browser` | `HEADLESS` | `False` | Disables automatic browser launch |
| `--no-udp` | `DISABLE_UDP` | `False` | Disables UDP LAN broadcasting (recommended for cloud) |

---

## 📡 How It Works (Protocol Architecture)

```
[ Sender Browser ]                                           [ Receiver Browser ]
       |                                                              |
       |--- 1. POST /api/offer (File list, sizes, type) ------------->|
       |                                                              |
       |               (Receiver hears chime & sees modal)            |
       |<-- 2. POST /api/offer/respond (Accept: true) ----------------|
       |                                                              |
       |=== 3. WebRTC DataChannel (Direct P2P LAN Transfer) =========>|
       |       [Chunk 1..N with Backpressure & Speed Meter]           |
       |       * Falls back to HTTP chunk relay if WebRTC blocked *    |
       |                                                              |
       |                               (Automatic browser download)    |
       |<== 4. Transfer Completed Notification =======================|
```

1. **Discovery**: Web clients subscribe to the SSE stream (`/api/events`). Devices on the same network or with the same Room Code discover each other immediately.
2. **Offer Handshake**: Sender proposes files. Recipient gets an audio chime and an incoming modal detailing file names, types, and sizes.
3. **Data Channel Streaming**: Once accepted, files stream directly between browsers over encrypted WebRTC DataChannels at maximum LAN speeds.
4. **Relay Fallback**: If strict corporate firewalls block WebRTC, the server seamlessly relays chunks via `/api/transfer/<id>/<idx>/chunk`.
5. **Auto-Download**: Received files automatically download in the recipient's browser.

---

## 🔒 Security & Privacy

- **No Remote Cloud Storage**: Files stream in real-time between devices. Data does not live on third-party servers.
- **Path Traversal Protection**: All file names are sanitized to prevent directory traversal (`../`).
- **Encrypted In Flight**: WebRTC DataChannels are encrypted by default via DTLS/SCTP.
- **Room Code Isolation**: Devices can create isolated rooms to prevent unauthorized requests on public Wi-Fi networks.
