# AgentGuard
### Concurrency-Safe, Shared-Memory Incident Response for Kubernetes
*CockroachDB × AWS Hackathon — Build with Agentic Memory*

> **Tagline:** Siloed agents guess in parallel. AgentGuard's agents remember together.

---

## What Is AgentGuard?

AgentGuard is a Kubernetes incident response system where multiple AI agents investigate pod failures and execute remediations **concurrently**, all sharing one transactional memory backed by CockroachDB.

The core problem it solves: when multiple agents monitor the same Kubernetes cluster independently, they duplicate work, produce contradictory diagnoses, and race to apply the same fix twice. AgentGuard prevents this by giving every agent access to the same consistent shared memory — so agents reconcile instead of collide.

**Two real concurrency mechanics, both demonstrated:**

1. **Diagnosis reconciliation** — N agents investigate the same pod failure at once. The second and third agent see what the first already found. Only one root cause is ever `CONFIRMED`; the rest are written as `SUPERSEDED`.
2. **Remediation race** — N agents race to claim and execute a fix. CockroachDB's serializable transactions ensure only one commits; the rest are `REJECTED` with real `SQLSTATE 40001` retries logged.

---

## Architecture

```
React Frontend (Vite)
  ↕  Supabase Auth        — login/session
  ↕  Supabase Realtime    — live dashboard events
  ↕  Backend REST API     — trigger incidents, fetch state

Backend (LangGraph + Express + TypeScript)
  ↕  CockroachDB MCP Server   — agents' audited memory-access path
  ↕  CockroachDB direct       — migrations, admin queries
  ↕  Gemini API               — embeddings + LLM reasoning
  ↕  Supabase JS client       — emit realtime events to dashboard

CockroachDB (Shared Agent Memory)
     incidents           — pod failure events
     diagnoses           — agent conclusions (PROPOSED / CONFIRMED / SUPERSEDED)
     remediation_budget  — per-namespace budget for Phase 3 write-skew demo
     agent_actions       — full audit log of every agent operation
     incident_memory     — VECTOR(3072) index of past incidents for similarity search
```

---

## Tech Stack

| Layer | Technology |
|---|---|
| Frontend | React 18, Vite, TypeScript |
| Backend | Node.js, Express, LangGraph (TypeScript) |
| Agents | LangGraph, `@langchain/google-genai` |
| Database | CockroachDB Cloud (AWS ap-south-1) |
| Embeddings | `gemini-embedding-001` via `@google/generative-ai` (3072-dim) |
| LLM | Gemini 2.0 Flash via `@langchain/google-genai` |
| Auth + Realtime | Supabase |
| Shared DB package | `@agentguard/db` (npm workspace) |

---

## Project Structure

```
agentguard/
├── packages/
│   └── db/                  # @agentguard/db — typed CockroachDB client + migrations
│       ├── src/
│       │   ├── client.ts    # connection pool, withTransaction
│       │   ├── retry.ts     # SQLSTATE 40001 retry wrapper
│       │   ├── queries.ts   # all named query functions
│       │   ├── types.ts     # TypeScript interfaces for all tables
│       │   └── migrations/
│       │       └── run.ts   # migration runner
│       └── migrations/
│           ├── 001_init.sql           # creates all 5 tables + vector index
│           └── 002_fix_vector_dim.sql # updates vector column to 3072 dims
├── apps/
│   ├── backend/             # LangGraph + Express API
│   │   └── src/
│   │       ├── index.ts
│   │       ├── api/routes.ts
│   │       ├── agents/      # LangGraph agent nodes (Phase 2+)
│   │       └── embeddings/
│   │           ├── pipeline.ts  # Gemini embedding wrapper
│   │           └── seed.ts      # seeds 15 past incidents + budgets
│   ├── frontend/            # React + Vite dashboard
│   │   └── src/
│   │       ├── App.tsx
│   │       └── lib/supabase.ts
│   └── simulator/           # Pod failure event generator
│       └── src/index.ts
├── .env.example             # all required env vars documented
└── .env                     # your actual values (gitignored)
```

---

## Prerequisites

- **Node.js 20+** — `node --version`
- **CockroachDB Cloud account** — [cockroachlabs.cloud](https://cockroachlabs.cloud) (free tier works)
- **Google AI Studio account** — [aistudio.google.com](https://aistudio.google.com) for Gemini API key
- **Supabase account** — [supabase.com](https://supabase.com) (free tier works)

---

## Setup

### 1. Clone and install

```bash
git clone <repo-url>
cd agentguard
npm install
```

### 2. Configure environment variables

```bash
cp .env.example .env
```

Fill in `.env` with your actual values:

| Variable | Where to get it |
|---|---|
| `COCKROACHDB_CONNECTION_STRING` | CockroachDB Cloud → Cluster → Connect → Connection string |
| `COCKROACHDB_MCP_URL` | Always `https://cockroachlabs.cloud/mcp` |
| `COCKROACHDB_MCP_API_KEY` | Cloud Console → Governance → Service Accounts → Create → copy secret key |
| `COCKROACHDB_CLUSTER_ID` | From cluster Overview URL: `/cluster/{id}/overview` |
| `GOOGLE_API_KEY` | aistudio.google.com → API keys |
| `SUPABASE_URL` | Supabase project → Settings → API → Project URL |
| `SUPABASE_SERVICE_ROLE_KEY` | Same page → service_role secret key |
| `VITE_SUPABASE_URL` | Same as `SUPABASE_URL` |
| `VITE_SUPABASE_ANON_KEY` | Same page → anon public key |

### 3. Run database migrations

Creates all 5 tables and the vector index in CockroachDB:

```bash
npm run db:migrate
```

### 4. Seed the database

Seeds 15 past pod incidents (with Gemini embeddings) into `incident_memory`, and seeds per-namespace remediation budgets:

```bash
npm run seed
```

This takes ~30 seconds (15 Gemini embedding API calls).

---

## Running the App

### Start the backend API

```bash
npm run dev:backend
# → http://localhost:3001
```

### Start the pod event simulator

Generates realistic Kubernetes pod failure events into the `incidents` table:

```bash
npm run dev:simulator
# default: one event every 5 seconds, runs until Ctrl+C
```

**Options via environment variables:**
```bash
$env:SIMULATOR_INTERVAL_MS=2000   # event every 2 seconds
$env:SIMULATOR_TOTAL_EVENTS=10    # stop after 10 events
npm run dev:simulator
```

### Start the frontend dashboard

```bash
npm run dev:frontend
# → http://localhost:3000
```

---

## API Endpoints

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/health` | Health check |
| `GET` | `/api/incidents` | List latest 50 incidents |
| `POST` | `/api/incidents/simulate` | Create a single simulated incident |
| `POST` | `/api/incidents/:id/diagnose` | Trigger concurrent diagnosis (Phase 2) |
| `POST` | `/api/incidents/:id/remediate` | Trigger concurrent remediation (Phase 3) |

---

## Verify Phase 1 Is Working

```bash
# 1. Check backend is up
curl http://localhost:3001/api/health

# 2. Run 5 simulator events
$env:SIMULATOR_TOTAL_EVENTS=5; npm run dev:simulator

# 3. Check incidents were created
curl http://localhost:3001/api/incidents
```

In the CockroachDB Cloud SQL Shell:

```sql
SELECT count(*) FROM incident_memory;       -- 15
SELECT namespace, budget FROM remediation_budget;
SELECT summary FROM incident_memory LIMIT 3;

-- Verify vector index is used (not full scan)
EXPLAIN SELECT summary FROM incident_memory
ORDER BY embedding <-> '[0.1, 0.2]'::vector(3072) LIMIT 3;
```

---

## Build Phases

| Phase | Owner | Status | What it builds |
|---|---|---|---|
| Phase 1 | Joshna | ✅ Complete | Shared memory foundation — DB, embeddings, simulator |
| Phase 2 | Suba | 🔜 | Concurrent diagnosis + reconciliation transaction |
| Phase 3 | Ashley | 🔜 | Concurrent remediation race + consistency checker + dashboard |

---

## Key Notes for Phase 2 (Suba)

- `incident_memory.embedding` is `VECTOR(3072)` — `gemini-embedding-001` outputs 3072 dimensions
- Vector similarity search uses L2 distance (`<->` operator)
- `searchSimilarIncidents(embedding, limit)` is exported from `@agentguard/db`
- `proposeDiagnosis()` in `@agentguard/db` is a basic insert — Phase 2 replaces it with the full reconciliation transaction
- MCP Server URL: `https://cockroachlabs.cloud/mcp` with `Authorization: Bearer <COCKROACHDB_MCP_API_KEY>`
- All three namespace budgets are seeded: `production: $10,000`, `staging: $5,000`, `development: $2,000`
