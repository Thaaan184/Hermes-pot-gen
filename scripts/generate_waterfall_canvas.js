const B_WIDTH = 1080;
const B_HEIGHT = 1080;

// Remove old board if exists to keep canvas clean
const existing = penpot.root.children.find(c => c.name && c.name.includes("NCT Voice AI"));
if (existing) {
  existing.remove();
}

// 1. Create Parent Board
const board = penpot.createBoard();
board.name = "NCT Voice AI - Latency Waterfall";
board.x = 0;
board.y = 0;
board.resize(B_WIDTH, B_HEIGHT);
board.fills = [{ fillColor: "#080C14", fillOpacity: 1 }];

// Helper functions
function createRect(parent, x, y, w, h, fill, radius = 0, stroke = null, strokeWidth = 1) {
  const r = penpot.createRectangle();
  r.x = x;
  r.y = y;
  r.resize(w, h);
  r.fills = fill ? [{ fillColor: fill, fillOpacity: 1 }] : [];
  if (radius > 0) r.borderRadius = radius;
  if (stroke) {
    r.strokes = [{ strokeColor: stroke, strokeWidth: strokeWidth, strokeStyle: "solid" }];
  }
  parent.appendChild(r);
  return r;
}

function createText(parent, x, y, text, size, color, align = "left", width = null) {
  const t = penpot.createText(text);
  if (!t) return null;
  t.x = x;
  t.y = y;
  t.fontSize = String(size);
  t.fills = [{ fillColor: color, fillOpacity: 1 }];
  t.align = align;
  if (width) {
    t.growType = "auto-height";
    t.resize(width, size * 1.4);
  }
  parent.appendChild(t);
  return t;
}

// 2. Subtle background engineering grid lines
for (let i = 0; i < 4; i++) {
  const lineY = 270 + i * 130;
  createRect(board, 60, lineY, 960, 1, "#151F30");
}

// 3. Top Header Section
// Pill Tag
createRect(board, 60, 52, 290, 26, "#0E1A2D", 13, "#0284C7", 1);
createText(board, 74, 57, "NCT TELEPHONY ARCHITECTURE // DEEP-DIVE", 11, "#38BDF8");

// Sub-tag right
createRect(board, 840, 52, 180, 26, "#111C2E", 6, "#334155", 1);
createText(board, 858, 57, "TIER-4 JAKARTA DC", 11, "#94A3B8");

// Main Headline & Subtitle
createText(board, 60, 94, "The 1-Second Silence Barrier", 36, "#F8FAFC");
createText(board, 60, 142, "Kecerdasan LLM sia-sia jika audio round-trip melebihi batas hening alami manusia (<1.0s).", 15, "#94A3B8");
createText(board, 60, 166, "Fondasi suara responsif bertumpu pada SIP Trunk domestik & neural VAD barge-in lokal.", 14, "#64748B");

// 4. Waterfall Chart Area
// Chart Container Background
createRect(board, 60, 210, 960, 590, "#0D1424", 12, "#1E293B", 1);

// Chart Headers
createText(board, 84, 226, "AUDIO PIPELINE STAGES", 12, "#64748B");
createText(board, 540, 226, "LATENCY BUDGET (CUMULATIVE STACK)", 12, "#64748B");

// Scale: 1200ms = 360px => 0.3 px/ms
const chartOriginX = 560;
const scale = 360 / 1200;

// 1000ms Human Limit Vertical Reference Line (drawn clearly above chart)
const limitX = chartOriginX + (1000 * scale);
createRect(board, limitX, 252, 2, 475, "#EF4444");
createRect(board, limitX - 95, 224, 180, 22, "#2A1215", 4, "#EF4444", 1);
createText(board, limitX - 86, 229, "1,000ms HUMAN SILENCE LIMIT", 9, "#FCA5A5");

// Waterfall Stages
const stages = [
  { name: "1. Mobile Carrier / RAN Ingest", ms: 120, start: 0, color: "#3B82F6", note: "Telco Radio Layer (4G/5G Jitter Buffer)" },
  { name: "2. SIP Trunk Ingest (FreeSWITCH)", ms: 40, start: 120, color: "#06B6D4", note: "Local Jakarta Direct Peering (NCT Core)" },
  { name: "3. Neural VAD & Barge-In Buffer", ms: 80, start: 160, color: "#10B981", note: "Frame chunking <20ms (Instant Interruption)" },
  { name: "4. Streaming STT (Audio-to-Text)", ms: 140, start: 240, color: "#6366F1", note: "WebSocket Stream Chunk (Bi-directional)" },
  { name: "5. LLM TTFT (First Token Stream)", ms: 210, start: 380, color: "#8B5CF6", note: "Sub-second Reasoning & Intent Match" },
  { name: "6. Neural TTS Synthesizer", ms: 100, start: 590, color: "#EC4899", note: "Streaming PCM Buffer Synthesizer" },
  { name: "7. RTP Egress & Audio Return", ms: 30, start: 690, color: "#06B6D4", note: "Direct SIP Egress back to Telco Gateway" }
];

stages.forEach((st, idx) => {
  const rowY = 276 + idx * 64;
  
  // Row label & subtext
  createText(board, 84, rowY, st.name, 13, "#F1F5F9");
  createText(board, 84, rowY + 18, st.note, 11, "#64748B");
  
  // Bar background track
  createRect(board, chartOriginX, rowY + 4, 360, 20, "#162032", 4);
  
  // Active latency block
  const blockX = chartOriginX + (st.start * scale);
  const blockW = Math.max(st.ms * scale, 10);
  createRect(board, blockX, rowY + 4, blockW, 20, st.color, 4);
  
  // Latency value badge
  createText(board, blockX + blockW + 8, rowY + 7, `+${st.ms}ms`, 11, "#F8FAFC");
});

// Final Success Marker at 720ms (stops cleanly above bottom banner)
const nctFinishX = chartOriginX + (720 * scale);
createRect(board, nctFinishX, 715, 2, 24, "#10B981");

// Bottom Summary Banner inside chart container
createRect(board, 84, 738, 912, 44, "#062820", 8, "#10B981", 1);
createText(board, 104, 751, "✓ NCT HAD ENGINE TOTAL ROUND-TRIP: 0.72s (720ms) — CONVERSATION FEELS INSTANT & NATURAL", 13, "#6EE7B7");

// 5. Bottom Architectural Highlights Cards (with wrapped multi-line text)
const bottomCards = [
  {
    tag: "LOW JITTER (<2ms)",
    title: "SIP TRUNK DOMESTIK",
    lines: [
      "Engine FreeSWITCH lokal di Datacenter",
      "Jakarta Tier-4 memangkas round-trip",
      "jaringan telekomunikasi di bawah 40ms."
    ]
  },
  {
    tag: "<20ms VAD",
    title: "NEURAL VAD BARGE-IN",
    lines: [
      "Deteksi interupsi instan tanpa tunggu",
      "cloud round-trip. Percakapan dua arah",
      "penuh (full-duplex) alami dan responsif."
    ]
  },
  {
    tag: "REAL-TIME PCM",
    title: "WEBSOCKET STREAMING",
    lines: [
      "Streaming chunk audio dua arah paralel",
      "tanpa disk buffering konvensional untuk",
      "minimasi total pipeline delay."
    ]
  }
];

bottomCards.forEach((c, idx) => {
  const cardX = 60 + idx * 326;
  createRect(board, cardX, 824, 308, 196, "#0D1424", 10, "#1E293B", 1);
  
  // Tag pill
  createRect(board, cardX + 16, 840, 115, 22, "#162032", 4);
  createText(board, cardX + 24, 845, c.tag, 10, "#38BDF8");
  
  // Title
  createText(board, cardX + 16, 874, c.title, 14, "#F8FAFC");
  
  // Multi-line descriptions (clean wrap)
  c.lines.forEach((line, lIdx) => {
    createText(board, cardX + 16, 904 + lIdx * 20, line, 12, "#94A3B8");
  });
});

return {
  success: true,
  boardId: board.id,
  name: board.name,
  width: B_WIDTH,
  height: B_HEIGHT
};
