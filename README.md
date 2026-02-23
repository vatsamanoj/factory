# Goose Command & Control Dashboard

Mobile-first React PWA + Node WebSocket backend for orchestrating Goose-style autonomous task execution.

## Quick Start

Requirements:
- Node.js 22+ (for `node:sqlite`)

Install and run:

```bash
npm install
npm run dev
```

Apps:
- Web PWA: `http://localhost:5173`
- API/WebSocket server: `http://localhost:8799`

## What Is Included

- Mobile-first Kanban board: Backlog, Triage, In Progress, Review, Done
- Task cards assignable to Human or Goose Minion
- Real-time status + pulse animation while running
- Mini-terminal drawer streaming mock Goose logs over WebSockets
- Context hydration pipeline (docs, API specs, MCP endpoints)
- Plugin registry UI + backend endpoints
- PWA base setup: `manifest.json`, service worker, offline shell, push notification handler

## Goose + MCP (Real Mode)

By default, Goose real execution is enabled. Set `GOOSE_REAL=0` to force mock mode.

The runtime now supports plugin-driven extension loading:
- `type: "mcp"` or `type: "mcp_stdio"`: `url` is a full stdio command (for `--with-extension`)
- `type: "mcp_http"`: `url` is a streamable MCP URL (for `--with-streamable-http-extension`)
- `type: "builtin"`: `url` is a Goose builtin extension name
- `type: "agent"`: `url` format `provider:model` (for example `openai:gpt-5-codex`)

Important:
- Goose needs writable runtime dirs. This project sets isolated paths under workspace (`.goose-home`, `.cache`, `.config`).

## Database Path Rule

- Canonical dashboard DB (use this for all reads/writes): `/home/infosys/factory/server/data/dashboard.db`
- Legacy DB copy (do not use for operations unless explicitly migrating): `/home/infosys/factory/server/server/data/dashboard.db`
- Server override (optional): set `DASHBOARD_DB_PATH` to force a different SQLite file.
- You still need provider credentials (for example `OPENAI_API_KEY`) for real inference runs.

### Plugin Utilities

- `POST /api/plugins/install-recommended`
  - Installs internally-tested plugin entries:
    - Filesystem MCP
    - Memory MCP
    - Everything MCP
    - GitHub MCP
    - Codex Agent (`openai:gpt-5-codex`)
- `GET /api/plugins/diagnostics`
  - Returns install/runnable checks and tool capability lists for installed MCP packages.
- `GET /api/plugins/catalog`
  - Returns plugin templates and JSON config schemas (`configSchema`) used to render/validate required params.
- `POST /api/plugins/validate`
  - Runs schema validation + live connectivity/auth validation without saving.
  - Supports optional custom schema override via `configSchema` in payload for third-party integrations.
- `POST /api/plugins`
  - Saves plugin only after schema + connectivity checks pass; otherwise returns actionable errors to recheck config.

### Schema Template Admin

Schema templates are versioned JSON files stored in:
- `server/schemas/plugins/<template_id>/vN.json`

Admin API:
- `GET /api/schema-templates`
  - Lists templates, current version, and available versions.
- `POST /api/schema-templates`
  - Creates a new template (`v1`).
- `PUT /api/schema-templates/:id`
  - Publishes a new version for an existing template (`vN+1`).

Each template includes:
- `id`, `label`, `type`, `defaultName`, `defaultUrl`, `configSchema`

## Architecture

See `docs/architecture.md`.
