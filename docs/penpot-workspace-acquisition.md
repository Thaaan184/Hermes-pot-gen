# Penpot Workspace Acquisition Architecture

**Status:** Approved Architecture (Zero-Based Rebuild)  
**Target Baseline:** Penpot 2.18.3 (`penpotapp/frontend:2.18`, `penpotapp/backend:2.18`)  
**Scope:** Studio-Owned Application Flow over Native Penpot Workspace Engine  

---

## 1. Executive Summary & Core Paradigm

The previous Studio prototype failed because it attempted to embed Penpot as a foreign website (using nested iframes, custom URL monkey-patching, and fragile CSS DOM masking). This resulted in routing collisions with ClojureScript's internal router, 404 `:not_found` exceptions, broken history state, and blank screens.

Under the **Zero-Based Acquisition Plan**, Studio does NOT embed Penpot as an iframe, nor does it hide Penpot's website behind CSS hacks. Instead:
1. **Studio owns the entire application flow and user routing** (`/studio/` for Dashboard, `/studio/canvas/:fileId` for Editor).
2. **The Acquisition Layer boots the native Penpot Workspace Core directly** into the Studio Editor viewport.
3. **The user never navigates through the Penpot Dashboard**. Clicking "← Back" returns cleanly to `/studio/`. Direct URLs `/studio/canvas/:fileId` resolve session, team, and file context deterministically.

---

## 2. Penpot Workspace Architecture & Entrypoint

### 2.1 Frontend Bundle Structure
Penpot's frontend (`/var/www/app`) is compiled using Shadow-CLJS / ClojureScript into ES module chunks:
- `/js/libs.js`: Closure Library, React 18 / Rum runtime, Reitit router, Potok state machine, Beicon Rx observables.
- `/js/main.js`: Main bundle, configuration definitions, authentication flow, global store, and route dispatcher.
- `/js/main-workspace.js`: Dynamically imported chunk containing the complete workspace component tree (`$app$main$ui$workspace$workspace_page_STAR_$$`).
- `/js/translation.en.js`: Localization dictionaries.
- `/render-wasm.wasm`: High-performance vector canvas rasterizer and path computation engine.

### 2.2 Routing & Dispatch Mechanism
In `main.js`, Penpot initializes its Reitit router:
```javascript
// Route definitions inside main.js:
[
  ["/auth", auth_route],
  ["/dashboard", dashboard_route],
  ["/dashboard/team/:team-id", dashboard_team_route],
  ["/workspace", workspace_route],
  ["/workspace/:project-id/:file-id", workspace_legacy_route]
]
```

When navigating, `main.js`'s `on_navigate` evaluates:
```javascript
$valid_location = (document.location.origin + document.location.pathname) === $APP.$app$config$public_uri$$;
```
If `$valid_location` is valid, Reitit matches the fragment against registered routes and dispatches `$app$main$router$nav` to the Potok store.

When the route matches `/workspace`, the store updates `current_team_id` and `current_file_id`, loading `main-workspace.js` and rendering `$APP.$app$main$ui$workspace$workspace_page_STAR_$$` with `{ fileId, pageId }`.

### 2.3 Workspace Component Hierarchy
Inside `main-workspace.js`:
- `$APP.$app$main$ui$workspace$workspace_STAR_$$`:
  - `workspace_header_STAR_`: Context breadcrumb and quick action bar.
  - `workspace_inner_STAR_`:
    - Left Tool Rail: Selector, Frame, Shapes (Rectangle, Ellipse, Path, Text, Curve).
    - Left Drawer: Layers Tree (hierarchical DOM tree, visibility, locks) & Assets Library.
    - Viewport View: Native SVG + WebAssembly rendered canvas, pan/zoom controller, bounding box transform controls.
    - Right Inspector: Properties panel (Position, Dimensions, Rotation, Fill, Stroke, Effects/Shadows, Typography, Flex/Grid Layout, Export settings).
  - WebSockets & Sync Stream: Real-time conflict-free collaboration stream to Penpot backend (`/ws/notifications`).

---

## 3. Workspace Dependency Graph

```text
Studio Application
   │
   ├── Studio Shell (Studio Owned)
   │     ├── Brand Navigation (Logo, Back to /studio/)
   │     ├── Canvas Title & Inline Rename
   │     ├── Cloud Save State Indicator
   │     ├── AI Copilot Panel (Connected to Penpot MCP :4401)
   │     └── Export Menu Trigger
   │
   ├── Acquisition Layer (Adapter Owned)
   │     ├── Session Resolver (Checks /api/main/methods/get-profile)
   │     ├── Team Resolver (Discovers active team UUID)
   │     ├── File Resolver (Resolves target canvas fileId & pageId)
   │     ├── Router Synchronizer (Aligns path /studio/canvas/:id with Penpot workspace)
   │     └── Error Boundary (Captures SESSION, TEAM, FILE, MOUNT failures)
   │
   └── Real Penpot Workspace (Penpot Engine Owned)
         ├── Rum/React Viewport Host (Mounted in #penpot-workspace-mount)
         ├── WebAssembly Engine (/render-wasm.wasm)
         ├── WebSocket Notifications (/ws/notifications)
         ├── Left Tool Rail & Layers Tree
         └── Right Properties Inspector
```

| Component | Classification | Ownership | Responsibility |
| :--- | :--- | :--- | :--- |
| `/studio/` Dashboard | STUDIO OWNED | Studio | Canvas gallery, new canvas, search, card actions |
| `/studio/canvas/:id` Route | STUDIO OWNED | Studio | URL routing, browser history, state synchronization |
| Studio Topbar & Branding | STUDIO OWNED | Studio | "← Back" button, canvas title, save status, AI toggle |
| AI Design Copilot | STUDIO OWNED | Studio | MCP bridge connection, AI design prompt execution |
| Acquisition Bootstrap | ADAPTER | Studio / Penpot | Session validation, team/file resolution, runtime boot |
| Canvas Viewport | DIRECT REUSE | Penpot Engine | Native WebAssembly rendering, zoom, pan, select |
| Drawing Tools | DIRECT REUSE | Penpot Engine | Rectangles, text, frames, paths, pen tool, booleans |
| Layers & Assets Panel | DIRECT REUSE | Penpot Engine | Object ordering, grouping, hierarchy, symbols |
| Properties Inspector | DIRECT REUSE | Penpot Engine | Fill, stroke, shadows, typography, layout, constraints |
| Persistence & Sync | DIRECT REUSE | Penpot Backend | PostgreSQL storage, Redis notifications, RPC methods |
| Penpot `/dashboard` Shell | EXCLUDED | None | Completely excluded from user experience |

---

## 4. Required State & Backend RPC APIs

### 4.1 State Entities
1. **Session State:**
   - Active profile (`profile.id`, `profile.email`, `profile.default_team_id`).
   - Authentication token (`auth-token` session cookie / header).
2. **Team Context:**
   - Active team UUID (`team.id`, `team.name`).
3. **File & Canvas Context:**
   - File entity (`file.id`, `file.name`, `file.project_id`, `file.rev`).
   - Document tree (pages list, current `page_id`, object registry, shape map).
4. **Studio App State:**
   - Current active view (`dashboard` vs `editor`).
   - Active canvas ID.
   - AI Copilot drawer state (open/closed, prompt history, generation status).

### 4.2 Required Backend APIs
All RPC communication routes to Penpot backend (`/api/main/methods/*`):
- `login-with-password`: Authenticate user and issue session credentials.
- `get-profile`: Validate active session and retrieve default workspace context.
- `get-teams`: List teams available to the current user.
- `get-projects`: Retrieve project collections inside team.
- `get-project-files`: Fetch canvas file metadata for Studio Dashboard.
- `get-file`: Retrieve complete document scene graph, shapes, and pages.
- `create-file`: Provision a new canvas with standard artboard templates.
- `rename-file`: Update canvas title from Studio header.
- `delete-file`: Remove canvas from Studio Dashboard.
- `export-file`: Generate raster/vector exports via Penpot Exporter service.
- `POST /mcp` (Port 4401): Fast AI parametric commands via Penpot MCP server.

---

## 5. Application Flow

### 5.1 Dashboard Flow (`/studio/`)
1. User requests `http://<host>/studio/`.
2. Studio Dashboard boots, invokes `/api/main/methods/get-profile`.
3. If unauthenticated, displays Studio login view.
4. If authenticated, requests `/api/main/methods/get-projects` and `/api/main/methods/get-project-files`.
5. Renders canvas grid with real thumbnails, creation dates, and action menus.
6. User clicks "Open" on canvas card -> navigates to `/studio/canvas/<file-id>`.

### 5.2 Editor Acquisition Flow (`/studio/canvas/<file-id>`)
1. User enters `/studio/canvas/<file-id>` (via click or direct link).
2. Acquisition Layer initializes:
   - Stage 1: Validate session with `/api/main/methods/get-profile`.
   - Stage 2: Query `/api/main/methods/get-file` with `{ id: file-id }` to verify file existence and retrieve `project-id` and `team-id`.
   - Stage 3: Synchronize URL state for Penpot engine (`#/workspace?team-id=<team-id>&file-id=<file-id>`).
   - Stage 4: Bootstrap Penpot runtime into `#penpot-workspace-mount`.
   - Stage 5: Mount Studio Shell overlay (Studio top bar, AI panel, navigation controls).
3. Workspace boots directly into canvas editing mode. Real Penpot WebAssembly canvas is interactive.

### 5.3 Return Flow ("← Back")
1. User clicks "← Back" in Studio Shell.
2. Studio router intercepts event, flushes pending edits, and navigates browser to `/studio/`.
3. Under no circumstances is the user redirected to Penpot's internal `/#/dashboard`.

### 5.4 Error Boundary Matrix
Every phase has explicit error recovery:
- `SESSION_ERROR`: Redirects to Studio sign-in with return URL.
- `TEAM_ERROR`: Displays team resolution error with retry button.
- `FILE_ERROR`: Displays "Canvas not found or access denied" with "Back to Studio" CTA.
- `WORKSPACE_INIT_ERROR`: Displays error stack details and a clean "Reload Canvas" button.

---

## 6. Implementation Strategy

To satisfy all requirements without iframes:
1. **Studio Edge Gateway (`studio-edge`)**:
   - Single Nginx entrypoint on port `8888`.
   - Directs `/api/` to `penpot-backend:6001`.
   - Directs `/ws/` to `penpot-backend:6001` (WebSocket upgrade).
   - Directs `/mcp` to `mcp-penpot:4401`.
   - Serves static Penpot runtime assets (`/js/*`, `/css/*`, `/images/*`, `/fonts/*`, `render-wasm.wasm`).
   - Serves Studio application on `/studio/*` with SPA fallback.
2. **Studio Single Page Application (`studio-web`)**:
   - Unified clean client architecture:
     - `/studio/index.html`: Entrypoint with Studio routing logic.
     - Studio Dashboard view: Pure Studio design system.
     - Studio Editor view: Hosts Studio Shell around native `#penpot-workspace-mount`.
     - Studio Acquisition Layer (`studio-penpot-adapter.js`): Programmatically prepares the document and mounts the native Penpot workspace without iframes.
