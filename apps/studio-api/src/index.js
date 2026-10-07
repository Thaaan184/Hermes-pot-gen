'use strict';

const express = require('express');
const http = require('http');
const https = require('https');

const app = express();
app.use(express.json());

// ─── Config ───────────────────────────────────────────────────────────────────
const PORT                     = process.env.PORT || 4000;
const PENPOT_BACKEND_URL       = (process.env.PENPOT_BACKEND_URL || 'http://penpot-backend:6060').replace(/\/$/, '');
const PENPOT_SERVICE_USER      = process.env.PENPOT_SERVICE_USER || 'studio-service@nct.internal';
const PENPOT_SERVICE_PASS      = process.env.PENPOT_SERVICE_PASS || 'StudioSecretPassword123!';
const PENPOT_DEFAULT_PROJECT_ID = process.env.PENPOT_DEFAULT_PROJECT_ID || '5e8f6953-f7b8-8027-8008-c0ab390df7ef';
const MCP_URL                  = (process.env.MCP_URL || 'http://penpot-mcp:4401').replace(/\/$/, '');

// ─── Transit+JSON Decoder ─────────────────────────────────────────────────────
// Penpot backend returns Transit+JSON: ['^ ', '~:key', value, ...]
// Map arrays start with '^ '. Keys prefixed '~:' or '~$' become camelCase.
// UUIDs: '~u...' -> plain string. Timestamps: '~m...' -> ISO string.

function transitKeyToJs(k) {
  // strip leading ~: or ~$
  const raw = k.replace(/^~[$:]/, '');
  // kebab-case -> camelCase
  return raw.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
}

function decodeTransit(val) {
  if (val === null || val === undefined) return val;

  // String transformations
  if (typeof val === 'string') {
    if (val.startsWith('~u')) return val.slice(2); // UUID
    if (val.startsWith('~m')) {
      const ms = parseInt(val.slice(2), 10);
      return isNaN(ms) ? val : new Date(ms).toISOString();
    }
    if (val === '~_') return null;
    if (val === '~?t') return true;
    if (val === '~?f') return false;
    return val;
  }

  if (!Array.isArray(val)) return val;

  // Transit map: ['^ ', key, val, key, val, ...]
  if (val[0] === '^ ') {
    const obj = {};
    for (let i = 1; i < val.length; i += 2) {
      const rawKey = val[i];
      const rawVal = val[i + 1];
      if (typeof rawKey === 'string' && (rawKey.startsWith('~:') || rawKey.startsWith('~$'))) {
        obj[transitKeyToJs(rawKey)] = decodeTransit(rawVal);
      } else {
        obj[String(rawKey)] = decodeTransit(rawVal);
      }
    }
    return obj;
  }

  // Regular array
  return val.map(decodeTransit);
}

function parseTransitResponse(text) {
  try {
    const raw = JSON.parse(text);
    return decodeTransit(raw);
  } catch (e) {
    return { _raw: text };
  }
}

// ─── Session Manager ──────────────────────────────────────────────────────────
let session = { token: null, expires: 0, defaultProjectId: null, defaultTeamId: null };

async function rawFetch(url, options = {}) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const lib = parsed.protocol === 'https:' ? https : http;
    const reqOptions = {
      hostname: parsed.hostname,
      port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
      path: parsed.pathname + parsed.search,
      method: options.method || 'GET',
      headers: options.headers || {},
    };

    const req = lib.request(reqOptions, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        resolve({ status: res.statusCode, headers: res.headers, body: data });
      });
    });
    req.on('error', reject);
    if (options.body) req.write(options.body);
    req.end();
  });
}

async function bootstrapRegister() {
  console.log('[auth] Attempting bootstrap registration for service account...');
  const prepareUrl = `${PENPOT_BACKEND_URL}/api/main/methods/prepare-register-profile`;
  const prepareRes = await rawFetch(prepareUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Accept': 'application/transit+json, application/json' },
    body: JSON.stringify({
      fullname: 'Studio Service Account',
      email: PENPOT_SERVICE_USER,
      password: PENPOT_SERVICE_PASS,
      acceptNewsletterUpdates: false,
    }),
  });

  if (prepareRes.status !== 200) {
    throw new Error(`Bootstrap prepare-register failed: ${prepareRes.status} ${prepareRes.body.slice(0, 200)}`);
  }

  // Token is in transit array: ['^ ', '~:token', 'eyJ...'] or decoded
  const prepareDecoded = parseTransitResponse(prepareRes.body);
  let regToken = prepareDecoded && prepareDecoded.token;
  if (!regToken && Array.isArray(prepareDecoded)) {
    // Look for token string
    for (let i = 0; i < prepareDecoded.length; i++) {
      if (typeof prepareDecoded[i] === 'string' && prepareDecoded[i].startsWith('eyJ')) {
        regToken = prepareDecoded[i];
        break;
      }
    }
  }
  if (!regToken) {
    // Try raw regex match
    const match = prepareRes.body.match(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/);
    if (match) regToken = match[0];
  }
  if (!regToken) throw new Error('Could not extract registration token from prepare response');

  const regUrl = `${PENPOT_BACKEND_URL}/api/main/methods/register-profile`;
  const regRes = await rawFetch(regUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Accept': 'application/transit+json, application/json' },
    body: JSON.stringify({ token: regToken, acceptNewsletterUpdates: false }),
  });

  if (regRes.status !== 200) {
    throw new Error(`Bootstrap register-profile failed: ${regRes.status} ${regRes.body.slice(0, 200)}`);
  }

  return processLoginResponse(regRes);
}

function processLoginResponse(res) {
  const setCookie = res.headers['set-cookie'];
  if (!setCookie) throw new Error('No Set-Cookie in login/register response');

  let token = null;
  let expires = Date.now() + 7 * 24 * 3600 * 1000; // default 7d

  const cookies = Array.isArray(setCookie) ? setCookie : [setCookie];
  for (const c of cookies) {
    const match = c.match(/auth-token=([^;]+)/);
    if (match) {
      token = match[1];
      const expMatch = c.match(/[Ee]xpires=([^;]+)/);
      if (expMatch) {
        const d = new Date(expMatch[1]);
        if (!isNaN(d)) expires = d.getTime();
      }
      break;
    }
  }

  if (!token) throw new Error('auth-token not found in Set-Cookie');

  const profile = parseTransitResponse(res.body) || {};
  const defaultProjectId = profile.defaultProjectId || (profile.props && profile.props.defaultProjectId);
  const defaultTeamId = profile.defaultTeamId;

  session = {
    token,
    expires,
    defaultProjectId: defaultProjectId || session.defaultProjectId,
    defaultTeamId: defaultTeamId || session.defaultTeamId,
  };

  console.log(`[auth] Authenticated. Token expires ${new Date(expires).toISOString()}, defaultProject=${session.defaultProjectId}`);
  return token;
}

async function loginPenpot() {
  const url = `${PENPOT_BACKEND_URL}/api/main/methods/login-with-password`;
  const body = JSON.stringify({ email: PENPOT_SERVICE_USER, password: PENPOT_SERVICE_PASS });
  const res = await rawFetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Accept': 'application/transit+json, application/json' },
    body,
  });

  if (res.status === 400 && res.body.includes('wrong-credentials')) {
    // Profile might not exist yet in fresh database - bootstrap registration
    return bootstrapRegister();
  }

  if (res.status !== 200) {
    throw new Error(`Penpot login failed: ${res.status} ${res.body.slice(0, 200)}`);
  }

  return processLoginResponse(res);
}

async function getToken() {
  if (session.token && Date.now() < session.expires - 60000) return session.token;
  return loginPenpot();
}

async function getProjectId() {
  if (session.defaultProjectId) return session.defaultProjectId;
  await getToken();
  if (session.defaultProjectId) return session.defaultProjectId;

  try {
    const prof = await penpotRequest('get-profile');
    if (prof && prof.defaultProjectId) {
      session.defaultProjectId = prof.defaultProjectId;
      return session.defaultProjectId;
    }
  } catch (e) {
    console.warn('[auth] get-profile failed:', e.message);
  }

  try {
    const projects = await penpotRequest('get-projects');
    if (Array.isArray(projects) && projects.length > 0) {
      session.defaultProjectId = projects[0].id;
      return session.defaultProjectId;
    }
  } catch (e) {
    console.warn('[auth] get-projects failed:', e.message);
  }

  return PENPOT_DEFAULT_PROJECT_ID;
}

// ─── Penpot API Helper ────────────────────────────────────────────────────────
async function penpotRequest(command, body = {}, retry = true) {
  const token = await getToken();
  const url = `${PENPOT_BACKEND_URL}/api/main/methods/${command}`;
  const res = await rawFetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'application/transit+json, application/json',
      'Cookie': `auth-token=${token}`,
    },
    body: JSON.stringify(body),
  });

  if (res.status === 401 && retry) {
    session.token = null;
    return penpotRequest(command, body, false);
  }

  if (res.status !== 200) {
    throw new Error(`Penpot ${command} error ${res.status}: ${res.body.slice(0, 300)}`);
  }

  return parseTransitResponse(res.body);
}

// ─── MCP Helper ───────────────────────────────────────────────────────────────
async function mcpInitSession() {
  const url = `${MCP_URL}/mcp`;
  const body = JSON.stringify({
    jsonrpc: '2.0',
    method: 'initialize',
    params: {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'studio-api', version: '1.0' },
    },
    id: 1,
  });

  const res = await rawFetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Accept': 'text/event-stream, application/json' },
    body,
  });

  const sessionId = res.headers['mcp-session-id'];
  if (!sessionId) {
    // Some MCP servers return session id in body or don't require it
    console.warn('[mcp] No mcp-session-id header in initialize response');
    return null;
  }
  return sessionId;
}

async function mcpExecuteCode(sessionId, code) {
  const url = `${MCP_URL}/mcp`;
  const headers = {
    'Content-Type': 'application/json',
    'Accept': 'text/event-stream, application/json',
  };
  if (sessionId) headers['mcp-session-id'] = sessionId;

  const body = JSON.stringify({
    jsonrpc: '2.0',
    method: 'tools/call',
    params: { name: 'execute_code', arguments: { code } },
    id: 2,
  });

  const res = await rawFetch(url, { method: 'POST', headers, body });
  return res.body;
}

function parseSseBody(body) {
  // Parse SSE: look for data: lines
  const lines = body.split('\n');
  for (const line of lines) {
    if (line.startsWith('data:')) {
      const text = line.slice(5).trim();
      try {
        return JSON.parse(text);
      } catch {
        return { _raw: text };
      }
    }
  }
  return { _raw: body };
}

// ─── Build MCP Code Snippet ───────────────────────────────────────────────────
function buildMcpCode(prompt, canvasId, pageId) {
  // Escape prompt for embedding in JS string
  const escaped = prompt.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\n/g, '\\n');
  return `
(async function() {
  try {
    const page = penpot.currentPage;
    if (!page) throw new Error('No active page');

    // Create a board (frame)
    const board = penpot.createFrame();
    board.name = 'AI: ' + '${escaped}'.slice(0, 50);
    board.x = Math.floor(Math.random() * 800);
    board.y = Math.floor(Math.random() * 600);
    board.width = 480;
    board.height = 320;
    board.fills = [{ fillOpacity: 1, fillColor: '#0F172A' }];

    // Create headline text
    const headline = penpot.createText('${escaped}'.slice(0, 120));
    headline.name = 'Headline';
    headline.x = board.x + 24;
    headline.y = board.y + 24;
    headline.width = 432;
    headline.characters = '${escaped}'.slice(0, 120);
    if (headline.applyTextStyle) {
      headline.applyTextStyle({ fontSize: 24, fontFamily: 'Inter', fontWeight: '600', fillColor: '#F8FAFC' });
    }

    penpot.viewport.zoomIntoView([board], { padding: 80 });
    return JSON.stringify({ success: true, boardId: board.id });
  } catch(e) {
    return JSON.stringify({ success: false, error: e.message });
  }
})();
`;
}

// ─── Routes ───────────────────────────────────────────────────────────────────

// Health
app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'studio-api' });
});

// Internal auth (nginx auth_request target)
app.all('/internal/auth', async (req, res) => {
  try {
    const token = await getToken();
    res.setHeader('Set-Cookie', `auth-token=${token}; Path=/; SameSite=Lax`);
    res.status(200).json({ ok: true });
  } catch (e) {
    console.error('[auth] Failed:', e.message);
    res.status(401).json({ error: e.message });
  }
});

// Auth session endpoint for frontend pre-warming
app.get('/api/auth-session', async (req, res) => {
  try {
    const token = await getToken();
    res.setHeader('Set-Cookie', `auth-token=${token}; Path=/; SameSite=Lax`);
    res.status(200).json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// List canvases (files in default project)
app.get('/api/canvas', async (req, res) => {
  try {
    const token = await getToken();
    res.setHeader('Set-Cookie', `auth-token=${token}; Path=/; SameSite=Lax`);

    const projectId = await getProjectId();
    const data = await penpotRequest('get-project-files', { projectId });
    // data may be array of file objects
    const files = Array.isArray(data) ? data : (data.files || []);
    const result = files
      .filter(f => f && f.id)
      .map(f => ({
        id: f.id,
        name: f.name || 'Untitled Canvas',
        updatedAt: f.updatedAt || f.modifiedAt || new Date().toISOString(),
        projectId: f.projectId,
      }));
    res.json(result);
  } catch (e) {
    console.error('[canvas list]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// Create canvas (file)
app.post('/api/canvas', async (req, res) => {
  const name = (req.body && req.body.name) ? req.body.name : 'Untitled Canvas';
  try {
    const token = await getToken();
    res.setHeader('Set-Cookie', `auth-token=${token}; Path=/; SameSite=Lax`);

    const projectId = await getProjectId();
    const data = await penpotRequest('create-file', { name, projectId });
    const id = data.id;
    res.json({
      id,
      name: data.name || name,
      fileId: id,
      redirectUrl: `/#/workspace?file-id=${id}`,
    });
  } catch (e) {
    console.error('[canvas create]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// Chat SSE endpoint
app.post('/api/chat', async (req, res) => {
  const { prompt = '', canvasId = '', pageId = '', selectedIds = [] } = req.body || {};

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  function sendEvent(data) {
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  }

  try {
    sendEvent({ type: 'status', message: 'Connecting to canvas engine...' });

    let sessionId = null;
    try {
      sessionId = await mcpInitSession();
    } catch (e) {
      console.warn('[mcp] init failed:', e.message);
    }

    sendEvent({ type: 'status', message: 'Analyzing prompt...' });

    const code = buildMcpCode(prompt, canvasId, pageId);

    let mcpResult = null;
    try {
      const rawBody = await mcpExecuteCode(sessionId, code);
      mcpResult = parseSseBody(rawBody);
    } catch (e) {
      console.warn('[mcp] execute failed:', e.message);
      mcpResult = { error: e.message };
    }

    sendEvent({ type: 'status', message: 'Applying changes to canvas...' });

    const success = mcpResult && !mcpResult.error;
    if (success) {
      const inner = mcpResult.result || mcpResult;
      const text = inner.content
        ? (Array.isArray(inner.content) ? inner.content.map(c => c.text).join(' ') : String(inner.content))
        : 'Canvas updated';
      sendEvent({ type: 'result', success: true, message: text });
    } else {
      const msg = (mcpResult && mcpResult.error) ? mcpResult.error : 'MCP unavailable — prompt received';
      sendEvent({ type: 'result', success: false, message: msg });
    }
  } catch (e) {
    console.error('[chat]', e.message);
    sendEvent({ type: 'error', message: e.message });
  } finally {
    res.end();
  }
});

// ─── Start ────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`[studio-api] listening on port ${PORT}`);
  // Warm up session
  getToken().catch(e => console.error('[auth] warm-up failed:', e.message));
});
