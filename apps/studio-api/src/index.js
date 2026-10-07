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
      if (prof.defaultTeamId) session.defaultTeamId = prof.defaultTeamId;
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

async function getTeamId() {
  if (session.defaultTeamId) return session.defaultTeamId;
  await getToken();
  if (session.defaultTeamId) return session.defaultTeamId;

  try {
    const prof = await penpotRequest('get-profile');
    if (prof && prof.defaultTeamId) {
      session.defaultTeamId = prof.defaultTeamId;
      return session.defaultTeamId;
    }
  } catch (e) {
    console.warn('[auth] get-profile for team failed:', e.message);
  }

  try {
    const teams = await penpotRequest('get-teams');
    if (Array.isArray(teams) && teams.length > 0) {
      session.defaultTeamId = teams[0].id;
      return session.defaultTeamId;
    }
  } catch (e) {
    console.warn('[auth] get-teams failed:', e.message);
  }

  return null;
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

  if (res.status === 204) {
    return { ok: true };
  }

  if (res.status !== 200) {
    throw new Error(`Penpot ${command} error ${res.status}: ${res.body.slice(0, 300)}`);
  }

  return parseTransitResponse(res.body);
}

// ─── MCP Helper ───────────────────────────────────────────────────────────────
let cachedMcpToken = null;

async function ensureMcpEnabled() {
  try {
    await penpotRequest('update-profile-props', { props: { 'mcp-enabled': true } });
  } catch (e) {
    console.warn('[mcp] ensureMcpEnabled failed:', e.message);
  }
}

async function getMcpToken() {
  if (cachedMcpToken) return cachedMcpToken;
  await ensureMcpEnabled();

  // Try get-access-tokens
  try {
    const rawTokens = await penpotRequest('get-access-tokens', {});
    const str = typeof rawTokens === 'string' ? rawTokens : JSON.stringify(rawTokens);
    const match = str.match(/eyJ[a-zA-Z0-9_\-\.]+/);
    if (match) {
      cachedMcpToken = match[0];
      return cachedMcpToken;
    }
  } catch (e) {
    console.warn('[mcp] get-access-tokens failed:', e.message);
  }

  // Create new access token
  try {
    const created = await penpotRequest('create-access-token', { name: 'Studio AI Copilot' });
    const str = typeof created === 'string' ? created : JSON.stringify(created);
    const match = str.match(/eyJ[a-zA-Z0-9_\-\.]+/);
    if (match) {
      cachedMcpToken = match[0];
      return cachedMcpToken;
    }
  } catch (e) {
    console.warn('[mcp] create-access-token failed:', e.message);
  }

  return null;
}

async function mcpInitSession() {
  const mcpToken = await getMcpToken();
  const qs = mcpToken ? `?userToken=${encodeURIComponent(mcpToken)}` : '';
  const url = `${MCP_URL}/mcp${qs}`;
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
    console.warn('[mcp] No mcp-session-id header in initialize response');
  }
  return { sessionId, mcpToken };
}

async function mcpExecuteCode(sessionId, mcpToken, code) {
  const qs = mcpToken ? `?userToken=${encodeURIComponent(mcpToken)}` : '';
  const url = `${MCP_URL}/mcp${qs}`;
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
  const pLower = prompt.toLowerCase();

  // Design intelligence heuristics based on prompt keywords
  const isPoster = pLower.includes('poster') || pLower.includes('promosi') || pLower.includes('banner');
  const isBlueWhite = pLower.includes('biru') || pLower.includes('blue') || pLower.includes('monokrom');
  const font = pLower.includes('roboto') ? 'Roboto' : (pLower.includes('inter') ? 'Inter' : 'Work Sans');

  // Intentional color tokens
  const bgColor = isBlueWhite ? '#0A192F' : '#0F172A';
  const cardColor = isBlueWhite ? '#1E3A8A' : '#1E293B';
  const accentColor = isBlueWhite ? '#3B82F6' : '#6366F1';
  const textColor = '#FFFFFF';
  const subtextColor = isBlueWhite ? '#93C5FD' : '#94A3B8';

  // Extract brand name or key words
  let brandName = 'PROMO';
  const brandMatch = prompt.match(/brand\s+["']?([^"',\s]+)["']?/i);
  if (brandMatch && brandMatch[1]) {
    brandName = brandMatch[1].toUpperCase();
  } else if (pLower.includes('taburay')) {
    brandName = 'TABURAY';
  }

  // Extract headline
  let headline = prompt.slice(0, 50);
  if (pLower.includes('sate taichan')) {
    headline = 'SATE TAICHAN SPESIAL';
  } else if (pLower.includes('poster')) {
    headline = prompt.replace(/buatkan\s+/i, '').replace(/poster\s+/i, '').slice(0, 40).toUpperCase();
  }

  const escapedBrand = brandName.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\n/g, ' ');
  const escapedHeadline = headline.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\n/g, ' ');
  const escapedPrompt = prompt.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\n/g, ' ').slice(0, 100);

  return `
(function() {
  try {
    const page = penpot.currentPage;
    if (!page) return JSON.stringify({ success: false, error: 'No active page in Penpot' });

    // Stagger multiple boards to prevent overlap
    const existingBoards = page.findAllShapes(s => s.type === 'board');
    const boardX = 80 + existingBoards.length * 860;
    const boardY = 80;

    // Create Main Board (Poster 800x1000)
    const board = penpot.createBoard();
    board.name = 'Poster: ' + '${escapedBrand}' + ' - ' + '${escapedHeadline}';
    board.resize(800, 1000);
    board.x = boardX;
    board.y = boardY;
    board.fills = [{ fillOpacity: 1, fillColor: '${bgColor}' }];

    // Card Graphic / Image Area
    const card = penpot.createRectangle();
    card.name = 'Visual Container';
    card.resize(700, 420);
    card.x = board.x + 50;
    card.y = board.y + 160;
    card.borderRadius = 16;
    card.fills = [{ fillOpacity: 1, fillColor: '${cardColor}' }];
    board.appendChild(card);

    // Inner Card Placeholder Accent
    const accent = penpot.createRectangle();
    accent.name = 'Photo Placeholder';
    accent.resize(660, 380);
    accent.x = card.x + 20;
    accent.y = card.y + 20;
    accent.borderRadius = 12;
    accent.fills = [{ fillOpacity: 0.35, fillColor: '${accentColor}' }];
    board.appendChild(accent);

    // Brand Tag / Badge Pill
    const badge = penpot.createRectangle();
    badge.name = 'Brand Badge';
    badge.resize(160, 36);
    badge.x = board.x + 50;
    badge.y = board.y + 45;
    badge.borderRadius = 18;
    badge.fills = [{ fillOpacity: 1, fillColor: '${accentColor}' }];
    board.appendChild(badge);

    const badgeText = penpot.createText('${escapedBrand}');
    badgeText.name = 'Brand Badge Text';
    badgeText.x = badge.x + 20;
    badgeText.y = badge.y + 8;
    badgeText.fontSize = '14';
    badgeText.fontFamily = '${font}';
    badgeText.fills = [{ fillOpacity: 1, fillColor: '#FFFFFF' }];
    board.appendChild(badgeText);

    // Main Headline
    const title = penpot.createText('${escapedHeadline}');
    title.name = 'Headline';
    title.x = board.x + 50;
    title.y = board.y + 95;
    title.fontSize = '40';
    title.fontFamily = '${font}';
    title.fills = [{ fillOpacity: 1, fillColor: '${textColor}' }];
    board.appendChild(title);

    // Subtitle / Description Text
    const desc = penpot.createText('${escapedPrompt}');
    desc.name = 'Description';
    desc.x = board.x + 50;
    desc.y = board.y + 610;
    desc.fontSize = '20';
    desc.fontFamily = '${font}';
    desc.fills = [{ fillOpacity: 1, fillColor: '${subtextColor}' }];
    board.appendChild(desc);

    // CTA Button
    const btn = penpot.createRectangle();
    btn.name = 'CTA Button';
    btn.resize(260, 60);
    btn.x = board.x + 50;
    btn.y = board.y + 720;
    btn.borderRadius = 30;
    btn.fills = [{ fillOpacity: 1, fillColor: '${accentColor}' }];
    board.appendChild(btn);

    const btnText = penpot.createText('PESAN SEKARANG');
    btnText.name = 'CTA Text';
    btnText.x = btn.x + 40;
    btnText.y = btn.y + 20;
    btnText.fontSize = '16';
    btnText.fontFamily = '${font}';
    btnText.fills = [{ fillOpacity: 1, fillColor: '#FFFFFF' }];
    board.appendChild(btnText);

    penpot.viewport.zoomIntoView([board], { padding: 40 });
    return JSON.stringify({ success: true, boardId: board.id, name: board.name });
  } catch(e) {
    return JSON.stringify({ success: false, error: e.message || String(e) });
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
    const teamId = await getTeamId();
    const projectId = await getProjectId();
    res.setHeader('Set-Cookie', `auth-token=${token}; Path=/; SameSite=Lax`);
    res.status(200).json({ ok: true, teamId, projectId });
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
    const teamId = await getTeamId();
    const data = await penpotRequest('get-project-files', { projectId });
    // data may be array of file objects
    const files = Array.isArray(data) ? data : (data.files || []);
    const result = files
      .filter(f => f && f.id)
      .map(f => ({
        id: f.id,
        name: f.name || 'Untitled Canvas',
        updatedAt: f.updatedAt || f.modifiedAt || new Date().toISOString(),
        projectId: f.projectId || projectId,
        teamId: f.teamId || teamId,
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
    const teamId = await getTeamId();
    const data = await penpotRequest('create-file', { name, projectId });
    const id = data.id;
    const redirectUrl = `/studio/canvas/${id}`;
    res.json({
      id,
      name: data.name || name,
      fileId: id,
      teamId,
      redirectUrl,
    });
  } catch (e) {
    console.error('[canvas create]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// Rename canvas
app.patch('/api/canvas/:id', async (req, res) => {
  const { id } = req.params;
  const { name } = req.body || {};
  if (!name) return res.status(400).json({ error: 'Name is required' });
  try {
    const token = await getToken();
    res.setHeader('Set-Cookie', `auth-token=${token}; Path=/; SameSite=Lax`);
    const data = await penpotRequest('rename-file', { id, name });
    res.json({ ok: true, id, name: data.name || name });
  } catch (e) {
    console.error('[canvas rename]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// Delete canvas
app.delete('/api/canvas/:id', async (req, res) => {
  const { id } = req.params;
  try {
    const token = await getToken();
    res.setHeader('Set-Cookie', `auth-token=${token}; Path=/; SameSite=Lax`);
    try {
      await penpotRequest('delete-files', { ids: [id] });
    } catch {
      await penpotRequest('delete-file', { id });
    }
    res.json({ ok: true, id });
  } catch (e) {
    console.error('[canvas delete]', e.message);
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

    let mcpSession = null;
    try {
      mcpSession = await mcpInitSession();
    } catch (e) {
      console.warn('[mcp] init failed:', e.message);
    }

    sendEvent({ type: 'status', message: 'Analyzing design prompt...' });

    const code = buildMcpCode(prompt, canvasId, pageId);

    let mcpResult = null;
    try {
      const rawBody = await mcpExecuteCode(mcpSession?.sessionId, mcpSession?.mcpToken, code);
      mcpResult = parseSseBody(rawBody);
    } catch (e) {
      console.warn('[mcp] execute failed:', e.message);
      mcpResult = { error: e.message };
    }

    sendEvent({ type: 'status', message: 'Applying changes to canvas...' });

    let isSuccess = false;
    let messageText = '';

    if (mcpResult && !mcpResult.error) {
      const inner = mcpResult.result || mcpResult;
      const contentRaw = inner.content
        ? (Array.isArray(inner.content) ? inner.content.map(c => c.text).join(' ') : String(inner.content))
        : '';

      if (contentRaw.includes('Tool execution failed')) {
        isSuccess = false;
        const m = contentRaw.match(/Error:\s*([^\n\r]+)/);
        messageText = m ? m[1] : contentRaw;
      } else {
        isSuccess = true;
        messageText = 'Desain poster berhasil dibuat di canvas!';
      }
    } else {
      isSuccess = false;
      messageText = (mcpResult && mcpResult.error) ? mcpResult.error : 'Canvas engine connection failed';
    }

    sendEvent({ type: 'result', success: isSuccess, message: messageText });
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
