# System Architecture (MVP)

```mermaid
flowchart TB
    U[Mobile User<br/>PWA React App] -->|HTTPS REST| API[Node Orchestrator API]
    U -->|WebSocket| WS[Realtime Stream Service]
    U -->|Service Worker| SW[Offline Cache + Push Handler]

    API --> DB[(SQLite Task Store)]
    API --> HYD[Context Hydrator]
    API --> PLUG[Plugin Registry]

    HYD --> CTX1[Static Docs<br/>PDF/Markdown]
    HYD --> CTX2[Dynamic Specs<br/>Swagger/JSON]
    HYD --> CTX3[Live MCP Endpoints]

    API --> GCLI[Goose CLI Bridge]
    GCLI -->|goose run --text| AGENT[Goose Agent Runtime]
    PLUG -->|goose configure| AGENT

    WS --> U
    AGENT -->|terminal logs + status| WS
```

## Runtime Flow

1. User drags task to `In Progress`.
2. Frontend calls `PATCH /tasks/:id/status`.
3. Backend hydrates prompt from attached context.
4. Goose bridge starts execution (mocked now), emits logs/status via WebSocket.
5. Frontend task card updates in real-time; mini-terminal shows stream.
6. On completion, browser push notification is shown (local notification fallback).
