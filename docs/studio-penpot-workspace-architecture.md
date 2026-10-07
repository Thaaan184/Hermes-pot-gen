# Studio Design Editor — Penpot Workspace Core Architecture

## 1. Executive Summary

Studio Design Editor is a standalone, AI-powered design application that uses Penpot's professional vector workspace as its core editing engine while completely replacing Penpot's application shell, dashboard, and navigation with Studio-owned systems.

The end-user experience is:
```text
Studio Dashboard (/studio/)
      │
      ▼  (Click "Open Canvas")
Studio Editor Route (/studio/canvas/:fileId)
      │
      ▼
┌──────────────────────────────────────────────────────────────┐
│ STUDIO EDITOR SHELL                                          │
│ [Studio] [← Back]  [Canvas Title]  [● Saved]  [✨ AI] [⤓ Export]│
├──────────────────────────────────────────────────────────────┤
│ PENPOT WORKSPACE CORE (Engine)                               │
│ ├── Left Panel: Layers, Assets, Tokens                       │
│ ├── Center Viewport: Vector Canvas, Rulers, Floating Tools   │
│ └── Right Panel: Design Properties, Inspect                  │
└──────────────────────────────────────────────────────────────┘
```

### Architectural Tenets
1. **No iframes:** The workspace renders natively in the single-origin Studio DOM context.
2. **No fake canvas / mock engines:** Penpot's vector math, SVG/path editing, Flexbox/autolayout, snapping, undo/redo, persistence, and WebGL/WASM rendering engines remain intact.
3. **Studio owns the shell and navigation:** The Penpot application header, home button, DRAFTS breadcrumb, and account dashboard navigation are neutralised and replaced by the Studio header.
4. **Complete isolation from Penpot Dashboard:** Navigation to Penpot's native dashboard is blocked at both router and UI levels; back actions return strictly to `/studio/`.

---

## 2. Responsibility Boundaries

| Feature / Domain | Owner | Implementation |
|---|---|---|
| Dashboard & Project List | **Studio** | `apps/studio-web/public/studio/index.html` |
| Routing & URL Namespace | **Studio** | `/studio/` and `/studio/canvas/:fileId` via Nginx edge gateway |
| Editor Topbar & Shell | **Studio** | `apps/studio-web/public/studio/editor-shell.js` (Back, Title, Status, AI, Export) |
| AI Copilot Assistant | **Studio** | Hermes MCP bridge + SSE backend stream (`/studio-api/api/chat`) |
| Vector Canvas & Rulers | **Penpot Core** | `main-workspace.js` vector viewport engine |
| Layers & Assets Panel | **Penpot Core** | Penpot workspace aside container |
| Properties & Inspect Panel | **Penpot Core** | Penpot workspace inspector aside |
| Persistence & Synchronization | **Penpot Core** | Penpot Backend (`/api/main/methods`), Postgres, and Valkey |
| Auth & Service Session | **Studio API** | `apps/studio-api/src/index.js` session auto-login & cookie injector |

---

## 3. Routing & Gateway Pipeline

### Routes
* `/studio/`: Studio Canvases Dashboard.
* `/studio/canvas/:fileId`: Studio Canvas Editor.
* `/studio-api/*`: Studio REST & SSE endpoints (auth, canvas CRUD, MCP chat).

### Nginx Edge Configuration (`infrastructure/nginx/studio.conf`)
* Rewrites `/studio/canvas/:fileId` to serve the Studio Editor HTML container (`apps/studio-web/public/studio/editor.html`).
* Sub-filters inject the Studio Editor Shell runtime (`editor-shell.js`) and whitelabel styling.
* Routes `/studio-api/` to Express backend (port 4000).
* Routes WebSocket connections to Penpot backend for real-time collaboration and changes sync.

---

## 4. Bootstrap Sequence & Black Screen Prevention

To prevent the historical failure mode (blank `#app` / black screen):

```text
1. [StudioBootstrap] Check URL path params -> extract fileId
2. [StudioBootstrap] Query /studio-api/api/auth-session -> obtain token, teamId, projectId
3. [StudioBootstrap] Validate teamId and fileId presence (both UUIDs mandatory)
4. [StudioBootstrap] If invalid: Render Studio Error UI with [Retry] & [Back to Studio]
5. [StudioBootstrap] Inject session cookie & configure Penpot globals
6. [StudioBootstrap] Set router state: #/workspace?team-id=<teamId>&file-id=<fileId>
7. [StudioBootstrap] Call Penpot init({ defaultTranslations })
8. [StudioBootstrap] Mount Studio Editor Shell header above #app
9. [StudioBootstrap] Neutralize native left_header* navigation to Penpot dashboard
```

### Stage Logging
Console logs emit explicit stage markers:
* `[StudioEditor] auth`
* `[StudioEditor] team`
* `[StudioEditor] file`
* `[StudioEditor] workspace-state`
* `[StudioEditor] sync`
* `[StudioEditor] workspace-mounted`

---

## 5. Navigation Isolation & Neutralization

Penpot's native workspace bundles contain navigation triggers:
1. `go_back` in `left_header*`: Triggers `go_to_dashboard_recent()`.
2. `nav_to_project` in `left_header*`: Triggers `go_to_dashboard_files()`.
3. Clojure router `main.js`: Handles `:dashboard-*` routes.

### Neutralization Method
1. **DOM & Event Interception:** The top-left icon in `left_header*` is repurposed to navigate back to `/studio/` or hidden in favor of the dedicated Studio Topbar.
2. **Router Guard:** In `main.js` and `inject.js`, any transition to `#/dashboard` or `:dashboard-*` is intercepted and immediately redirected to `/studio/`.
3. **Top Bar Replacement:** The Studio Shell header sits at `top: 0` (height 48px), shifting the workspace viewport to `calc(100vh - 48px)` so that Studio branding and navigation are always top-level.

---

## 6. Testing & Validation Matrix

* **Dashboard:** Verify `/studio/` loads, lists canvases, opens canvas without spinner regression.
* **Route:** Verify `/studio/canvas/:fileId` resolves and mounts without black screen.
* **Canvas Tools:** Create rectangle, ellipse, text; modify fill, stroke, size, and rotation.
* **Pan / Zoom:** Test zoom in/out, pan with spacebar/hand tool.
* **Persistence:** Rename canvas, edit shapes, wait for `Saved` status, refresh browser, verify shapes persist.
* **Navigation:** Click `← Back to Studio` -> returns to `/studio/` cleanly.
* **AI Copilot:** Open AI drawer, prompt layout change, verify streamed response.
