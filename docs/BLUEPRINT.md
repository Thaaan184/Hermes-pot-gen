# Blueprint: Hermes × Penpot AI Studio Engine (V3 Plan)

## 1. Filosofi & Arsitektur Utama

1. **Decoupled First:** Mulai dari Penpot stock + Docker resmi + Plugin API. Hindari fork ClojureScript di awal untuk eliminasi beban maintenance.
2. **Typed Design DSL (Bukan Raw JS Eval):** Hermes dilarang kirim raw code bebas. Hanya kirim operasi JSON terstruktur & tervalidasi.
3. **Visual Critique Loop (Standard Figma AI / v0):** LLM teks buta spasial. Canvas diekspor jadi gambar → Vision LLM audit hierarki/spacing → auto-patch sebelum user review.
4. **Human-in-the-Loop & Atomic Undo:** Perubahan tampil di ghost board samping canvas. User klik *Apply* → 1 checkpoint undo native Penpot.

```text
┌────────────────────────────────────────────────────────┐
│ Penpot Canvas (Stock Engine)                           │
│ ┌──────────────────────┐    ┌────────────────────────┐ │
│ │ Hermes Copilot UI    │    │ Penpot MCP Plugin      │ │
│ │ (React Iframe)       │    │ (Canvas Executor)      │ │
│ └──────────┬───────────┘    └───────────▲────────────┘ │
└────────────┼────────────────────────────┼──────────────┘
      HTTP/SSE (Chat)                     │ WebSocket
             ▼                            │
┌─────────────────────────┐      ┌────────┴──────────────┐
│ Hermes Agent Gateway    │─────►│ Penpot MCP Server     │
│ - Design System Ruleset │ MCP  │ (Local Node Server)   │
│ - Vision Critique Loop  │      └───────────────────────┘
│ - Typed DSL Generator   │
└─────────────────────────┘
```

---

## 2. Typed Design DSL (Protokol Operasi)

Hermes hanya kirim schema JSON ter-versi:

```json
{
  "version": 1,
  "requestId": "req_01J...",
  "target": {"mode": "new_board", "pageId": "current"},
  "operations": [
    {
      "op": "create_board",
      "id": "$hero",
      "name": "Hero Section",
      "layout": {
        "dir": "column",
        "align": "center",
        "justify": "start",
        "gap": 32,
        "padding": [64, 48, 64, 48]
      },
      "fill": "color.background.base"
    },
    {
      "op": "create_text",
      "parent": "$hero",
      "text": "Automate Telemarketing with Voice AI",
      "typography": "heading.hero",
      "fill": "color.text.primary"
    },
    {
      "op": "create_component_instance",
      "parent": "$hero",
      "componentId": "comp.button.primary",
      "overrides": {"label": "Coba Demo"}
    }
  ]
}
```

### Whitelist Operasi (MVP)
- `create_board` (Flex column / row, CSS Grid)
- `create_text` (Binding ke token tipografi)
- `create_shape` (Rect, ellipse, path SVG)
- `bind_token` (Warna, border, radius)
- `update_props` (Spacing, padding, alignment)
- `delete_node` (Hapus layer)

Semua operasi di luar whitelist otomatis ditolak oleh validator client.

---

## 3. Visual Critique Loop (Kunci Kualitas Desain)

Alur perbaikan visual otomatis sebelum user inspect:

```text
Prompt User
     │
     ▼
[Pass 1: Generate Initial DSL]
     │
     ▼
[Render Draft ke Temporary Scratchboard]
     │
     ▼
[Export Scratchboard ke PNG via Penpot API]
     │
     ▼
[Hermes Multimodal Vision Audit]
 - Cek teks overlap / clipping
 - Cek kontras warna (WCAG AA < 4.5:1)
 - Cek ritme 8pt spacing
     │
     ▼
[Pass 2: Patch DSL (Koreksi Delta)]
     │
     ▼
[Render Final ke Ghost Board Preview]
     │
     ▼
User Review: [Apply] atau [Reject]
```

---

## 4. Tahapan Implementasi (Phased Roadmap)

### Fase 0 — Fondasi & Pipeline Verifikasi (Estimasi: 3-5 Hari)
- Jalankan Penpot via Docker Compose resmi di server lokal.
- Verifikasi flag plugin aktif (`PENPOT_FLAGS="enable-plugins enable-feature-plugins enable-mcp"`).
- Deploy Penpot MCP server lokal (`@penpot/mcp` / `penpotapp/mcp`).
- Konfigurasi Hermes `~/.hermes/config.yaml` connect ke Penpot MCP.
- **Gate Check:** Perintah teks dari Hermes sukses spawn 1 rectangle merah di canvas Penpot.

### Fase 1 — Design System Engine & Hermes Skill (Estimasi: 1 Minggu)
- Bangun Hermes Skill khusus Penpot Design (`skills/penpot-designer`):
  - Aturan 8pt grid system mutlak (`8`, `16`, `24`, `32`, `48`, `64`).
  - Rumus palet 60-30-10 terikat variabel token.
  - Hierarki tipografi modular scale (`12`, `14`, `16`, `24`, `32`, `48`).
- Bangun JSON Schema Validator di executor client.
- **Gate Check:** Hermes generate 1 Hero Section berbasis flexbox dengan nama layer semantik, tanpa overlap.

### Fase 2 — UI Copilot Plugin (Estimasi: 1-2 Minggu)
- Buat Penpot Plugin (React + Tailwind v4 + Vite).
- UI Iframe:
  - Chat history dengan streaming response.
  - Context chip: deteksi active page & selection layer ID.
  - Command Diff Preview: Tampilkan daftar layer yang akan dibuat/diubah.
  - Action buttons: `Apply Changes` dan `Discard`.
- Pasang tombol quick-actions: `Fix Spacing (8px)`, `Audit Kontras`, `Rename Layers`.
- **Gate Check:** User bisa prompt dari dalam UI Penpot dan klik Apply untuk commit perubahan ke canvas.

### Fase 3 — Visual Critique Engine (Estimasi: 1 Minggu)
- Sambungkan Penpot `export_shape` (render board ke image base64/PNG).
- Kirim payload image ke Hermes multimodal loop.
- Implementasi auto-critique prompt: deteksi visual bugs dan perbaiki kode DSL sebelum ditampilkan ke user.
- **Gate Check:** Desain hasil generate lolos uji kontras AA dan konsistensi margin secara otomatis tanpa intervensi manual.

### Fase 4 — Native Docking / ClojureScript Fork (Opsional / Finishing)
- Setelah engine dan plugin 100% stabil:
- Clone `penpot/frontend`.
- Modifikasi layout sidebar kanan (`workspace.cljs`), tambahkan tab ketiga: `✦ AI`.
- Mount iframe / micro-frontend Copilot langsung ke dalam tab native tersebut.
- Build custom Docker image frontend.

---

## 5. Keputusan Kunci & Mitigasi Risiko

| Area | Keputusan | Alasan Teknis |
|---|---|---|
| **Eksekusi Canvas** | Whitelist DSL JSON | Cegah injection arbitrary code (`eval`) ke browser session |
| **Undo Engine** | 1 Transaksi = 1 Batch Penpot Action | Tekan Ctrl+Z sekali langsung revert seluruh perubahan AI |
| **Konteks File** | Ringkasan node terpilih (bukan full doc) | Mencegah context window overflow dan hemat token LLM |
| **Kualitas Visual** | Vision Critique Loop wajib jalan | Menghilangkan kelemahan LLM teks dalam presisi spasial |
