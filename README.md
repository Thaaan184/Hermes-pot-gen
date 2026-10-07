# Hermes-pot-gen

> Self-Hosted AI Design Studio Engine powered by **Penpot** and **Hermes Agent**.

![Status](https://img.shields.io/badge/status-active-brightgreen)
![Architecture](https://img.shields.io/badge/architecture-V3%20Plan-blue)
![License](https://img.shields.io/badge/license-MIT-purple)

---

## 1. Overview

**Hermes-pot-gen** connects [Hermes Agent](https://github.com/NousResearch/hermes-agent) to [Penpot](https://penpot.app) via Penpot's official MCP (Model Context Protocol) and Plugin APIs, providing an open-source, self-hosted alternative to Figma AI / Figma First Draft.

### Key Highlights
- **Decoupled Architecture:** Runs on official stock Penpot containers without fragile forks.
- **Typed Design DSL:** Generates strictly validated JSON operations (Auto-Layout Flexbox/Grid, Design Tokens, 8pt spatial grid).
- **Visual Critique Loop:** Evaluates canvas rendering via multimodal vision reflection before user review.
- **Human-in-the-Loop & Atomic Undo:** Single-action batch commit with native Ctrl+Z rollback.

---

## 2. Architecture

```text
┌────────────────────────────────────────────────────────┐
│ Penpot Canvas (Stock Engine :9001)                     │
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

## 3. Quick Start (Phase 0)

### Start Penpot Stack
```bash
sg docker -c "docker compose up -d"
```
Access Penpot at: [http://localhost:9001](http://localhost:9001)

### Connect Hermes Agent via MCP
Add to `~/.hermes/config.yaml`:
```yaml
mcp_servers:
  penpot:
    url: "http://localhost:9001/mcp/stream?userToken=YOUR_MCP_KEY"
```
Or connect directly to local MCP port `4401`.

---

## 4. Phased Roadmap

- [x] **Phase 0:** Docker Compose Stack with MCP & Plugin flags enabled.
- [ ] **Phase 1:** Hermes Design Skill (`skills/penpot-designer`) with 8pt grid & 60-30-10 color rules.
- [ ] **Phase 2:** React Copilot Plugin UI with Command Diff Preview & Apply/Discard actions.
- [ ] **Phase 3:** Multimodal Visual Critique Loop via Penpot `export_shape`.
- [ ] **Phase 4:** (Optional) Native sidebar docking via ClojureScript fork.

---

## 5. Documentation

See [docs/BLUEPRINT.md](docs/BLUEPRINT.md) for full architecture and engineering specifications.
