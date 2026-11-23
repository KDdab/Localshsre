# 📦 ShareLocal — Temporary Code & QR-Based File Sharing

> Instant, secure, and disposable file sharing between devices using **6-digit share codes, direct links, and QR codes**. No user accounts, no permanent storage, and automatic expiration.

---

## 🌟 Core Flow

```
[ Sender ]                                                 [ Receiver ]
   │                                                           │
   ├─ 1. Uploads files (drag & drop / picker)                  │
   ├─ 2. Backend stores files temporarily                      │
   ├─ 3. Generates 6-character code (e.g. X7K92P) & QR        │
   │                                                           │
   │            (Share code, QR, or direct URL)                │
   │──────────────────────────────────────────────────────────>│
   │                                                           ├─ 4. Scans QR camera / enters code
   │                                                           ├─ 5. Views files & live countdown timer
   │                                                           └─ 6. Downloads files or "Download All" (ZIP)
   │
   ▼
[ Automatic Expiration ] ──── 30 minutes ────> Files & metadata permanently deleted
```

---

## 🏗️ Architecture & Project Structure

The backend is built with **Node.js + Express.js** following a clean, decoupled service architecture:

```text
server/
├── config/
│   └── index.js             # Environment variables & runtime defaults
├── controllers/
│   └── shareController.js   # HTTP request & response handlers
├── routes/
│   └── shareRoutes.js        # Express REST API endpoints
├── services/
│   ├── storageService.js    # Storage abstraction (swappable with S3/R2)
│   ├── fileService.js       # Filename sanitization & streaming ZIP archiver
│   └── shareService.js      # In-memory share lifecycle & metadata manager
├── middleware/
│   └── uploadMiddleware.js  # Multer streaming disk upload with size limits
├── utils/
│   ├── idGenerator.js       # Cryptographically secure unambiguous alphanumeric codes
│   └── cleanupWorker.js     # Background cron worker to purge expired shares
├── uploads/                 # Temporary storage directory (auto-purged)
└── server.js                # Express app configuration & server entrypoint

public/
├── index.html               # Semantic, accessible single-page application
├── favicon.svg              # Vector logo icon
├── css/
│   └── style.css            # Responsive design system (Dark & Light themes)
└── js/
    ├── qr-generator.js      # Pure JS HTML5 Canvas QR code renderer (zero CDN dependencies)
    ├── qr-scanner.js        # Camera QR scanner with BarcodeDetector & fallback
    └── app.js               # Client controller (SPA routing, drag & drop, XHR progress)
```

---

## 🚀 Quick Start (Local Run)

### 1. Requirements
- Node.js 18+ (tested on Node.js 20 & 24)
- npm 9+

### 2. Install Dependencies
```bash
npm install
```

### 3. Run Development Server
```bash
npm start
```
The application will launch on **http://localhost:5000** (or your configured `PORT`).

---

## 🐳 Docker Deployment

Run with Docker in seconds:

```bash
docker compose up -d
```

Or using standard Docker CLI:
```bash
docker build -t sharelocal .
docker run -d -p 5000:5000 -v $(pwd)/server/uploads:/app/server/uploads sharelocal
```

---

## 📡 REST API Reference

| Method | Endpoint | Description |
| :--- | :--- | :--- |
| `POST` | `/api/share` | Upload files and create a temporary share (`multipart/form-data`) |
| `GET` | `/api/share/:shareId` | Retrieve share details, file list, and remaining countdown |
| `GET` | `/api/share/:shareId/file/:fileId` | Stream and download an individual file |
| `GET` | `/api/share/:shareId/download-all` | Stream and download all files packaged as a `.zip` archive |
| `DELETE` | `/api/share/:shareId` | Manually cancel and invalidate a share |
| `GET` | `/api/health` | Health check endpoint |

---

## 🛡️ Security Features

- **Cryptographic Share IDs**: Uses unambiguous uppercase alphanumeric characters (`23456789ABCDEFGHJKLMNPQRSTUVWXYZ`, excluding 0, O, 1, I, L) generated via `crypto.randomBytes`.
- **Path Traversal Protection**: All user-supplied filenames are sanitized to prevent directory traversal (`../`) and illegal character injection.
- **Streaming Large Files**: Uploads and downloads are streamed through pipes, preventing high memory usage or server crashes.
- **Automatic Purging**: Background worker executes every 1–2 minutes to guarantee expired files and metadata are deleted promptly from memory and disk.
