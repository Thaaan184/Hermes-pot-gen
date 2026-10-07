# Implementation Audit — AI Design Studio on Penpot

## 1. What Was Inspected

### Infrastructure
- `docker-compose.yaml` — existing service topology, networks, ports, healthchecks
- `penpot-frontend` nginx config — gzip, proxy pass, sub_filter capability
- `penpot-backend` API — Transit+JSON response format, cookie-based auth
- `penpot-mcp` — JSON-RPC 2.0 over HTTP, SSE response, session header protocol
- `penpot-postgres` — service account pre-seeded, project/team IDs confirmed

### API Endpoints Verified Working

| Command | Method | URL | Notes |
|---|---|---|---|
| login-with-password | POST | `/api/main/methods/login-with-password` | Returns `Set-Cookie: auth-token=...` |
| get-projects | POST | `/api/main/methods/get-projects` | Requires `auth-token` cookie |
| get-project-files | POST | `/api/main/methods/get-project-files` | Body: `{projectId}` |
| create-file | POST | `/api/main/methods/create-file` | Body: `{name, projectId}` |

### MCP Protocol Verified
- `POST /mcp` with `method: 'initialize'` → `mcp-session-id` header in response
- `POST /mcp` with `mcp-session-id` + `method: 'tools/call'` + `name: 'execute_code'` → SSE `data: {...}` body
- MCP runs Plugin API code in the browser tab with Penpot editor open and MCP connected
- Response is SSE: `event: message\ndata: {result:{content:[{type:'text',text:'...'}]}}\n\n`

## 2. What Was Found Working

- Penpot backend at `http://penpot-backend:6060` — all listed commands respond
- Penpot MCP at `http://penpot-mcp:4401` — initialize + execute_code work
- Service account `studio-service@nct.internal` authenticated successfully
- `penpot-frontend` nginx: gzip enabled globally — **must** set `proxy_set_header Accept-Encoding ""` per location before using `sub_filter`
- Transit+JSON format confirmed: `['^ ', '~:key', value, ...]` maps, `~u` UUID prefix, `~m` millisecond timestamps

## 3. What Was Added

### New Services
| Service | Port | Purpose |
|---|---|---|
| `studio-api` | 4000 (internal) | Node.js Express: Transit decoder, session pool, canvas CRUD, MCP relay |
| `studio-web` | 3000 (internal) | Static server: dashboard HTML, inject.js, whitelabel.css |
| `studio-edge` | 80 (external) | Nginx reverse proxy: single-origin routing, sub_filter injection |

### New Files
```
apps/studio-api/
  Dockerfile
  package.json
  src/index.js          — Express app (Transit decode, session mgr, API routes, SSE chat)

apps/studio-web/
  Dockerfile
  package.json
  server.js             — serve-static HTTP server
  public/studio/
    index.html          — Full dashboard SPA (dark theme, canvas grid, modal)
    inject.js           — Runtime injected into every Penpot HTML page
    whitelabel.css      — Hides Penpot branding selectors

infrastructure/nginx/
  studio.conf           — Upstream blocks, location routing, sub_filter injection

.env.example            — Template for all required env vars
```

## 4. Transit+JSON Decode Strategy

Penpot backend responds with `Content-Type: application/transit+json`.  
Format is a recursive array encoding:

```
['^ ', '~:key-one', value, '~:key-two', value, ...]  → JS object
['~u550e8400-e29b-41d4-a716-446655440000']           → UUID string
'~m1696665600000'                                     → ISO date string
'~_'                                                 → null
```

Implemented in `decodeTransit()` in `src/index.js`:
1. Detects `val[0] === '^ '` → decode as map
2. String prefixes: `~u` → UUID, `~m` → timestamp, `~_` → null
3. Keys: `~:key-name` or `~$key-name` → strip prefix, kebab→camelCase
4. Recurses into all array values and object values

No external `transit-js` dependency needed for read-only decode of the subset Penpot actually returns.

## 5. Auth Strategy

**Server-side session pool** (not per-request master cookie):

1. `studio-api` logs in once with `studio-service@nct.internal` credentials on startup
2. Stores `{token, expires}` in memory
3. Every `penpotRequest()` call uses this token via `Cookie: auth-token=<token>`
4. Token refreshed proactively 60s before expiry, and reactively on any 401
5. `/internal/auth` endpoint echoes the current valid token as a `Set-Cookie` header for nginx `auth_request` use

**Why not pass master cookie to browser clients:**
- Service account credentials must not be exposed to browser sessions
- Penpot's `auth-token` is HttpOnly — browser cannot read it anyway
- Studio users authenticate through Penpot's normal login flow for their own editor sessions
- Studio API calls (canvas CRUD, chat) go through nginx `/studio-api/` which proxies to studio-api, which uses its own session — no credential sharing

## 6. Known Limitations

1. **MCP requires open browser tab** — `execute_code` only works when a Penpot editor tab with MCP connected is open. In production, a headless browser (Playwright) should keep a dedicated tab warm.
2. **Transit decode is partial** — handles the observed subset (maps, UUIDs, timestamps, null, bool). Full transit-js library needed for edge cases (sets `~#set`, tagged values, caching).
3. **Session is single-node in-memory** — restarts lose the token (auto re-login on next request). For HA, use Redis-backed session.
4. **Nginx `sub_filter` string replacement** — multi-string `sub_filter` requires `nginx-module-sub` with newer syntax. The current config uses two separate `sub_filter` directives; if nginx version doesn't support multiple `sub_filter` per location, they must be combined into one or use `ngx_http_sub_module` with `sub_filter_once off`.
5. **Canvas create redirect** — uses `/#/workspace?file-id=...` hash URL. Penpot may also require `project-id` and `page-id` in the hash for correct routing. Users may need to navigate inside the editor to the correct page.
6. **No rate limiting** — `/api/chat` SSE endpoint has no per-client rate limiting; add nginx `limit_req_zone` for production.

## 7. Service Account Details

```
email:              studio-service@nct.internal
password:           StudioSecretPassword123!
profile_id:         5e8f6953-f7b8-8027-8008-c0ab390d5c26
default-team-id:    5e8f6953-f7b8-8027-8008-c0ab390db421
default-project-id: 5e8f6953-f7b8-8027-8008-c0ab390df7ef
```
Account pre-seeded in `penpot-postgres` via migration scripts (not in this repo).
