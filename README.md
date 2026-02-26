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
- API/WebSocket server: `http://localhost:8787`

## What Is Included

- Mobile-first Kanban board: Backlog, Triage, In Progress, Review, Done
- Task cards assignable to Human or Goose Minion
- Real-time status + pulse animation while running
- Mini-terminal drawer streaming mock Goose logs over WebSockets
- Context hydration pipeline (docs, API specs, MCP endpoints)
- Plugin registry UI + backend endpoints
- PWA base setup: `manifest.json`, service worker, offline shell, push notification handler

## Custom Agent Runtime

The dashboard now runs the built-in Custom Agent (`server/src/customAgent.js`) for every task. There is no longer a Goose CLI dependency or runtime toggle—every work item flows through the same hydration/prompt/log pipeline that the dashboard already uses.

### Companion Tool Loop

The agent includes an internal companion runner (`server/src/customAgentCompanion.js`) inspired by `zeroclaw-tools`. It provides `shell` and `file_read` tools and enforces the LangGraph-style loop where the model emits `TOOL_CALL: {"name":"<tool>","args":{...}}`, the companion executes that helper, and then feeds the tool output back into the conversation before polling the model again. This keeps tool use consistent across providers such as GLM-5/Zhipu even when their native tool-calling is flaky.

## Custom Agent API Key

To enable LLM access, POST `{ "apiKey": "sk-..." }` to `/api/custom-agent/key`; the key is stored in `agent_settings` (database column `value`) and survives restarts. Retrieve the masked key via `GET /api/custom-agent/key` for confirmation, and the agent logs whether a key is present before each run. Use the same endpoint from CI scripts or an admin UI to rotate keys.

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
