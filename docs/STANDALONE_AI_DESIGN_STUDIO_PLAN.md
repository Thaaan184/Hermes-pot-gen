# Standalone AI Design Studio — Technical Implementation Specification
**Document Version:** 1.0.0  
**Target Architecture:** Single-Origin White-Label Studio Engine  
**Core Components:** Penpot Engine (Stock 2.18) + Studio Edge (Nginx) + Studio API + Hermes AI Control Layer  
**Repository:** `Hermes-pot-gen`

---

## 1. Executive Summary & Core Principle

Membangun aplikasi web studio desain AI mandiri (*AI-native Design Studio*) dengan tampilan 100% white-label:
* **User Experience:** Buka URL → langsung muncul Dashboard → Create/Load Canvas → masuk Editor Studio dengan AI Chat terintegrasi di sidebar/floating panel.
* **Zero Visible Penpot:** Tanpa registrasi/login form Penpot, tanpa logo/branding Penpot, tanpa menu cloud, tanpa navigasi eksternal.
* **Zero Tab Switching:** User tidak perlu buka tab Discord/Hermes atau copy-paste prompt. Chat dan canvas berada di 1 tab browser aktif.
* **Engine vs Product:** Penpot diposisikan murni sebagai *headless/embedded design engine*, bukan produk akhir bagi user.
* **Data-First, Bukan Screenshot-First:** AI beroperasi langsung pada struktur layer (Structured Canvas AST: `id`, `x`, `y`, `width`, `height`, `fills`, `typography`), bukan menebak koordinat dari screenshot visual.

---

## 2. High-Level Architecture & Single-Origin Topology

Seluruh service dibungkus di belakang satu **Nginx Edge Reverse Proxy** dalam jaringan Docker internal. Browser hanya berkomunikasi dengan satu origin port (misal `:80` atau `:9001`).

```text
                               ┌─────────────────────────────┐
                               │     User Browser Client     │
                               │ (Zero Auth / Studio Cookie) │
                               └──────────────┬──────────────┘
                                              │ HTTP / WebSocket (Single Origin)
                                              ▼
┌─────────────────────────────────────────────────────────────────────────────────────────────┐
│ NGINX EDGE REVERSE PROXY (:80)                                                              │
│                                                                                             │
│  ├─ /studio/*       ──► studio-web (Static Dashboard, Whitelabel CSS, Inject JS, Plugin)   │
│  ├─ /studio-api/*   ──► studio-api (Server-side Auth, Penpot RPC Bridge, Hermes Chat Relay) │
│  └─ /* (Editor)     ──► penpot-frontend (:8080)                                             │
│                           ├── auth_request /_auth (Auto-inject internal session cookie)     │
│                           └── sub_filter (Inject whitelabel.css + inject.js ke HTML head)  │
└──────────────────────────────────────┬──────────────────────────────────────────────────────┘
                                       │
            ┌──────────────────────────┴──────────────────────────┐
            ▼                                                     ▼
┌───────────────────────────┐                         ┌───────────────────────────┐
│ STUDIO API DAEMON         │                         │ PENPOT BACKEND & ENGINE   │
│ - Auto-Login Service Acct │                         │ - penpot-backend (:6001)  │
│ - Manage Session Lifetime │                         │ - penpot-frontend (:8080) │
│ - Penpot RPC Bridge       │                         │ - postgres (penpot db)    │
│ - Chat SSE Relay          │                         │ - valkey (redis cache)    │
└───────────┬───────────────┘                         │ - penpot-exporter         │
            │                                         └─────────────▲─────────────┘
            ▼                                                       │
┌───────────────────────────┐                                       │ WebSocket
│ HERMES AGENT GATEWAY      │                                       │
│ - Intent Parser           ├───────────────────────────────────────┘
│ - Structured AST Engine   │            Penpot MCP Stream (:4401 / :9001/mcp)
│ - Canvas Tool Abstraction │
└───────────────────────────┘
```

---

## 3. Komponen & Pembagian Tanggung Jawab

| Komponen | Stack / Image | Tanggung Jawab Utama |
|---|---|---|
| **Nginx Edge** | `nginx:alpine` | Single-origin gateway. Mencegah issue CORS/iframe. Injeksi asset CSS/JS white-label via `sub_filter`. Verifikasi sesi via `auth_request`. |
| **Studio Web** | Static HTML / Vite / React | Melayani UI Dashboard (`/studio`), stylesheet `whitelabel.css`, bundle runtime `inject.js`, dan manifest plugin canvas. |
| **Studio API** | Node.js (Express / Fastify) | Mengelola service account Penpot secara server-side (login otomatis & simpan cookie/token internal). Proxy komunikasi chat SSE ke Hermes Gateway. |
| **Penpot Engine** | Official Docker Stack 2.18 | Engine canvas, kalkulasi SVG/flexbox, state persistence Postgres, rendering WebSocket, export engine. Tetap stock tanpa fork ClojureScript di awal. |
| **Hermes Gateway** | Hermes Agent Core | Menerima prompt user, menganalisis state canvas terstruktur, mengeksekusi manipulasi layer melalui tool MCP Penpot. |

---

## 4. Keamanan & Server-Side Auto-Authentication

### Masalah pada Pendekatan Naif:
* *Menyuntikkan master cookie mentah langsung ke browser user sangat berbahaya.* Jika cookie bocor, kredensial admin dan akses server terekspos penuh.
* *Cookie sesi Penpot memiliki waktu kedaluwarsa (expire).* Jika sesi statis mati, canvas tiba-tiba redirect ke halaman login.

### Solusi Server-Side Managed Session:
1. Browser user hanya menerima cookie acak ringan: `studio_session=anon_<uuid>`.
2. Saat browser mengakses path editor `/*`, Nginx mengeksekusi sub-request internal:
   ```nginx
   location = /_auth {
     internal;
     proxy_pass http://studio-api:4000/internal/auth;
     proxy_pass_request_body off;
     proxy_set_header Content-Length "";
     proxy_set_header Cookie $http_cookie;
   }
   ```
3. `studio-api`:
   * Memeriksa apakah service account Penpot internal masih memiliki sesi aktif.
   * Jika belum/expired, `studio-api` melakukan login RPC ke `penpot-backend` menggunakan environment variable `PENPOT_SERVICE_USER` & `PENPOT_SERVICE_PASS`.
   * Mengembalikan header `Set-Cookie: auth-token=<token>; Path=/; HttpOnly` ke Nginx.
4. Nginx menyematkan cookie valid tersebut ke request backend Penpot secara transparan. User tidak pernah melihat form login.

---

## 5. Strategi White-Labeling (Zero ClojureScript Fork Risk)

Injeksi dilakukan pada level Nginx reverse proxy menggunakan modul bawaan `ngx_http_sub_module`:

```nginx
location / {
  auth_request /_auth;
  auth_request_set $auth_cookie $upstream_http_set_cookie;
  add_header Set-Cookie $auth_cookie always;

  proxy_pass http://penpot-frontend:8080;
  proxy_http_version 1.1;
  proxy_set_header Upgrade $http_upgrade;
  proxy_set_header Connection "upgrade";
  proxy_set_header Accept-Encoding ""; # Wajib agar response berupa plain text HTML untuk sub_filter

  sub_filter '</head>' '<link rel="stylesheet" href="/studio/whitelabel.css"><script src="/studio/inject.js" defer></script></head>';
  sub_filter_once on;
}
```

### Manifest `whitelabel.css` (Target Eliminasi UI):
* Sembunyikan header navigasi brand Penpot, logo, dan switch workspace cloud.
* Sembunyikan tombol user feedback, release notes, link Discord/Github Penpot, serta account billing.
* Sembunyikan halaman auth/register fallback.
* Pertahankan 100%: canvas viewport, toolbars atas/kiri, layer tree panel, design properties panel (kanan), context menus, ruler, dan zoom control.

### Manifest `inject.js` (Runtime Enhancer):
* Mengubah `document.title` menjadi **"AI Design Studio"** dan mengganti favicon.
* Memasang mount container `#ai-studio-chat-panel` di pojok kanan editor.
* Meng-autoload plugin canvas Penpot di background tanpa intervensi manual user.
* Mencegah browser tab sleep/freeze dengan memelihara event interaksi ringan.

---

## 6. Protokol Canvas Terstruktur (Bukan Guessing Screenshot)

AI dilarang menebak elemen visual dari screenshot raster untuk keperluan manipulasi posisi atau styling dasar. AI beroperasi menggunakan **Structured Canvas AST**:

### 1. Read State (`canvas.get_state`)
Mengembalikan struktur pohon JSON node saat ini:
```json
{
  "canvasId": "canvas_01J...",
  "pageId": "page_01",
  "selectedIds": ["rect_4a61"],
  "viewport": { "x": 0, "y": 0, "zoom": 1 },
  "nodes": [
    {
      "id": "board_hero",
      "type": "board",
      "name": "Hero Section",
      "x": 0,
      "y": 0,
      "width": 1080,
      "height": 1080,
      "fills": [{ "color": "#080C14", "opacity": 1 }],
      "children": ["rect_waterfall_01", "text_title"]
    }
  ]
}
```

### 2. Whitelist Operasi Manipulasi (Typed DSL / MCP Tools)
Hermes menerjemahkan perintah user menjadi sekumpulan operasi atomic:
* `canvas.create_board({ name, x, y, width, height, fills, layout })`
* `canvas.create_shape({ type, parent, x, y, width, height, fills, strokes, radius })`
* `canvas.create_text({ parent, x, y, text, fontSize, color, align, width })`
* `canvas.update_props({ id, props: { fills, x, y, width, height, radius } })`
* `canvas.delete_node({ id })`
* `canvas.create_component_instance({ parent, componentId, overrides })`

### 3. Peran Opsional Multimodal Vision (Visual Critique Loop Saja)
Screenshot canvas hanya digunakan di akhir pipeline sebagai **auditor visual** (Quality Gate):
* Memeriksa overlap teks yang tidak terduga akibat font metric rendering.
* Memeriksa kontras rasio WCAG AA (< 4.5:1).
* Memberikan rekomendasi koreksi sebelum user menyatakan selesai.

---

## 7. Chatbot Panel & Siklus Hidup Editor (Tab Co-Location)

Salah satu kelemahan fatal arsitektur terpisah adalah: **MCP Penpot akan error `tab appears to be suspended` jika tab browser Penpot tidak aktif/berada di background.**

### Mitigasi:
* Chatbot UI di-render **di dalam tab yang sama dengan canvas** melalui `inject.js`.
* User mengetik prompt, melihat streaming respons AI, dan melihat perubahan layer di canvas pada satu jendela aktif.
* Tab selalu dalam status `active foreground`, sehingga event loop dan WebSocket heartbeat MCP tidak pernah di-throttle oleh browser (Chrome/Edge battery-saver).

```text
┌────────────────────────────────────────────────────────────────────────┐
│  AI DESIGN STUDIO — Editor View                                        │
├───────────┬──────────────────────────────────────────┬─────────────────┤
│ LAYERS    │ CANVAS (Interactive Penpot Engine)       │ AI COPILOT      │
│           │                                          │                 │
│ ├─ Hero   │   ┌──────────────────────────────────┐   │ Prompt:         │
│ ├─ Cards  │   │                                  │   │ [Buat landing..]│
│ └─ Footer │   │  [ Live Generated Vector Arts ]  │   │                 │
│           │   │                                  │   │ [ Generate ]    │
│           │   └──────────────────────────────────┘   │                 │
│           │                                          │ Status:         │
│           │                                          │ ✓ Board created │
│           │                                          │ ● Adding styles │
└───────────┴──────────────────────────────────────────┴─────────────────┘
```

---

## 8. Alur Pengguna (User Journey)

### 1. Halaman Dashboard (`/studio`)
* User membuka `http://<domain>/studio`.
* User melihat daftar file kanvas yang tersimpan (di-fetch via endpoint `studio-api` → Penpot internal API).
* Terdapat tombol **[ + Create New Canvas ]**.

### 2. Pembuatan Kanvas Baru (`POST /studio-api/canvas`)
* User klik *Create New Canvas*.
* `studio-api` membuat file baru di project default melalui internal RPC Penpot.
* Browser langsung redirect ke `/editor/<file-id>`.

### 3. Editor & AI Interaction (`/editor/<file-id>`)
* Halaman memuat kanvas tanpa branding Penpot.
* Panel AI Copilot siap di samping kanan.
* User mengetik prompt → dikirim ke `/studio-api/chat` (SSE streaming).
* Hermes menerima prompt + context ID layer yang sedang dipilih user → mengeksekusi code ke Penpot MCP → layer muncul real-time di layar.

---

## 9. Rencana Eksekusi Bertahap (Phased Roadmap)

### Fase 0 — Fondasi & Verifikasi MCP Engine (STATUS: SELESAI)
* [x] Deploy Penpot 2.18 Docker stack di VM `100.106.40.93`.
* [x] Aktifkan flag `enable-mcp` dan `enable-feature-plugins`.
* [x] Uji koneksi MCP Hermes: berhasil write objek dan export SVG/PNG.

### Fase 1 — Service Gateway, Auto-Auth, & White-Label Proxy (Estimasi: 1 Hari)
* [ ] Setup struktur folder repo: `apps/studio-api`, `apps/studio-web`, `infrastructure/nginx`.
* [ ] Buat container `studio-api` (Express.js) untuk handle auto-login service account dan generate session token internal.
* [ ] Buat konfigurasi Nginx reverse proxy dengan `auth_request` dan `sub_filter`.
* [ ] Buat file `whitelabel.css` untuk membersihkan elemen visual Penpot.
* [ ] **Exit Criteria:** Buka `http://100.106.40.93:9001/` langsung masuk ke canvas kosong tanpa halaman login dan tanpa logo Penpot.

### Fase 2 — Injeksi Chat Copilot UI & Hermes Relay (Estimasi: 1.5 Hari)
* [ ] Buat bundle `inject.js` (React / Tailwind floating widget) yang disuntikkan ke halaman canvas.
* [ ] Buat endpoint streaming `/studio-api/chat` yang menjembatani input chat browser ke Hermes Gateway.
* [ ] Setup auto-load internal canvas controller script.
* [ ] **Exit Criteria:** User bisa mengetik prompt di kotak chat dalam canvas, menekan *Enter*, dan melihat layer baru langsung tercipta di canvas di depannya.

### Fase 3 — Standalone Dashboard (`/studio`) (Estimasi: 1 Hari)
* [ ] Buat UI Dashboard sederhana & modern di `studio-web`:
  * Header judul: *AI Design Studio*.
  * Tombol *Create Canvas*.
  * Grid kartu canvas terkini (*Recent Canvases*) beserta waktu update dan thumbnail preview.
* [ ] Implementasikan bridge RPC `create-file` dan `get-files` di `studio-api`.
* [ ] **Exit Criteria:** Alur penuh berjalan: Buka `/studio` → Klik Create Canvas → Redirect otomatis ke Editor + Chat AI.

### Fase 4 — Production Hardening & Safety (Estimasi: 0.5 Hari)
* [ ] Isolasi port Postgres, Valkey, Penpot backend, dan Hermes agar hanya terbuka di internal Docker network.
* [ ] Setup healthcheck container dan auto-restart.
* [ ] Masukkan seluruh konfigurasi secret ke `.env`.
* [ ] Commit dan sync repository GitHub `Hermes-pot-gen`.

---

## 10. Struktur Direktori Target di Repo `Hermes-pot-gen`

```text
Hermes-pot-gen/
├── apps/
│   ├── studio-web/             # Dashboard UI, whitelabel.css, inject.js
│   │   ├── src/
│   │   │   ├── dashboard/      # UI Dashboard (/studio)
│   │   │   ├── chat-panel/     # UI Chat Copilot (inject.js)
│   │   │   └── styles/         # whitelabel.css
│   │   ├── Dockerfile
│   │   └── package.json
│   └── studio-api/             # Server-side auth, RPC bridge, SSE relay
│       ├── src/
│       │   ├── auth/           # Auto-login daemon & token pool
│       │   ├── penpot/         # RPC client (create-file, list-files)
│       │   ├── chat/           # Hermes SSE proxy
│       │   └── index.js
│       ├── Dockerfile
│       └── package.json
├── infrastructure/
│   └── nginx/
│       ├── nginx.conf
│       └── studio.conf         # Config sub_filter & auth_request
├── scripts/
│   └── generate_waterfall_canvas.js
├── docs/
│   ├── BLUEPRINT.md
│   └── STANDALONE_AI_DESIGN_STUDIO_PLAN.md  # File spesifikasi ini
├── docker-compose.yaml         # Compose orchestrating Penpot + Edge + Studio
├── .env.example
└── README.md
```

---

## 11. Security Checklist Sebelum Go-Live

1. **Network Boundary:** Port 5432 (Postgres), 6379 (Valkey), 6001 (Penpot backend), 4401 (MCP mentah) wajib tertutup dari akses internet publik; hanya port 80/443 (Nginx Edge) yang terekspos.
2. **Credential Sanitization:** Master email/password Penpot disimpan strictly di file `.env` server backend dan tidak pernah dikirim ke browser client.
3. **Session Integrity:** Komunikasi antar container diatur via DNS internal Docker (`http://studio-api:4000`, `http://penpot-backend:6001`).
4. **Git Discipline:** Tidak ada file kredensial, `.env`, atau session cookie yang di-commit ke Git remote. Selalu commit dan push perubahan arsitektur ke branch `main`.
