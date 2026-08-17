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
| `POST` | `/api/incidents/:id/diagnose` | Fire N concurrent diagnosis agents at an incident, reconcile to one CONFIRMED root cause, run the policy agent against it. Body: `{ agent_count?, reconcile?, symptom? }` |
| `GET` | `/api/incidents/:id/diagnoses` | List every diagnosis written for an incident (PROPOSED / CONFIRMED / SUPERSEDED) |
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
| Phase 2 | Suba | ✅ Complete | Concurrent diagnosis + reconciliation transaction |
| Phase 3 | Ashley | 🔜 | Concurrent remediation race + consistency checker + dashboard |

---

## Verify Phase 2 Is Working

```bash
# Fire 8 concurrent diagnosis agents at one incident, twice — once siloed, once reconciled —
# and print the proposed/confirmed/superseded contrast:
npm run benchmark:diagnosis
```

Or against a real incident via the API:

```bash
curl -X POST http://localhost:3001/api/incidents/simulate
# → note the incident_id, then:
curl -X POST http://localhost:3001/api/incidents/<incident_id>/diagnose \
  -H "Content-Type: application/json" \
  -d '{"agent_count": 8}'
curl http://localhost:3001/api/incidents/<incident_id>/diagnoses
```

In CockroachDB Cloud SQL Shell, confirm exactly one `CONFIRMED` diagnosis per incident:

```sql
SELECT incident_id, status, count(*) FROM diagnoses GROUP BY incident_id, status;
```

---

## What Phase 2 Built

- **`@agentguard/db`** (`packages/db/src/queries.ts`): `proposeDiagnosisWithReconciliation()` — the reconciliation transaction. Inside one transaction it reads whether a `CONFIRMED` diagnosis already exists for the incident, then writes the new proposal as `CONFIRMED` (none exists yet) or `SUPERSEDED` (one does). Under CockroachDB `SERIALIZABLE`, two agents racing this on the same incident can't both land `CONFIRMED` — one gets `SQLSTATE 40001` and retries via `withRetry`, and on retry correctly sees the winner and writes itself `SUPERSEDED`. `getConfirmedDiagnosis()` reads the winner back out.
- **`@agentguard/agents`** (`packages/agents/`) — a new workspace package, published the same way `@agentguard/db` was:
  - **`src/tools.ts`**: `search_similar_incidents` as a real LangChain `DynamicStructuredTool`, wrapping `generateEmbedding` + `searchSimilarIncidents` against `incident_memory`.
  - **`src/diagnosisAgent.ts`**: a single diagnosis agent — pulls similar past incidents via the tool, asks Gemini for a structured `{root_cause, confidence}`, then writes through either the reconciliation path or the naive `proposeDiagnosis()` (siloed mode, for contrast).
  - **`src/diagnosisGraph.ts`**: the LangGraph subgraph. A `Send`-based fan-out dispatches N `diagnosis_agent` branches concurrently against the same incident; an `aggregate` node tallies CONFIRMED/SUPERSEDED/PROPOSED and flips the incident to `DIAGNOSED` once a root cause is confirmed.
  - **`src/benchmark.ts`** (`npm run benchmark:diagnosis`): runs the same incident twice — once with reconciliation disabled (siloed: N independently-"true" root causes all sit in the table), once with it enabled (exactly 1 confirmed, rest superseded) — this is the "siloed vs. shared memory" proof point.
  - **`src/policy.ts`**: the Cost/Policy agent's approval logic — reads the current `remediation_budget` for a namespace, estimates the cost of the confirmed fix, and returns an approve/reject decision. Read-only and advisory; Phase 3's atomic claim + write-skew transaction on `remediation_budget` is what actually commits spend.
  - **`src/embeddings/pipeline.ts`**: the Gemini embedding wrapper (moved here from Phase 1's `apps/backend/src/embeddings/pipeline.ts` so both the seed script and the diagnosis tool share one implementation).
- **`POST /api/incidents/:id/diagnose`** and **`GET /api/incidents/:id/diagnoses`** wired in `apps/backend/src/api/routes.ts`.

## Key Notes for Phase 3 (Ashley)

- `incident_memory.embedding` is `VECTOR(3072)` — `gemini-embedding-001` outputs 3072 dimensions
- Vector similarity search uses L2 distance (`<->` operator)
- `searchSimilarIncidents(embedding, limit)` is exported from `@agentguard/db`
- MCP Server URL: `https://cockroachlabs.cloud/mcp` with `Authorization: Bearer <COCKROACHDB_MCP_API_KEY>`
- All three namespace budgets are seeded: `production: $10,000`, `staging: $5,000`, `development: $2,000`
- An incident is only `DIAGNOSED` once `runConcurrentDiagnosis()` confirms a root cause — poll/react to that status before starting the remediation race
- `evaluateRemediationPolicy(namespace, rootCause)` from `@agentguard/agents` gives you an advisory `{approved, action, estimatedCost, availableBudget}` — reuse `estimateRemediationCost()`'s action mapping (`restart` / `rollback` / `scale-up` / `config-fix`) as the seed for what each remediation agent actually tries to execute
- **Chat model is pinned to `gemini-2.5-flash`** in `packages/agents/src/diagnosisAgent.ts`. Google deprecates Gemini model IDs on a rolling basis (`gemini-2.0-flash` returned a hard 404 the day this was tested) — if you add your own `ChatGoogleGenerativeAI` calls in Phase 3 and get a 404, check `GET https://generativelanguage.googleapis.com/v1beta/models?key=$GOOGLE_API_KEY` for what's currently live before assuming your code is broken.
- **If you add a new LangChain tool and `tsc` fails with `TS2589: Type instantiation is excessively deep`**: this project's TS/zod/`@langchain/core` combination chokes on `DynamicStructuredTool`'s generic inference from a `ZodObject`. Do **not** "fix" it by pinning zod below 3.25 — that resolves the type error but breaks at runtime (`@langchain/google-genai` does `require('zod/v3')`, a subpath export zod only added in 3.24+). The actual fix, used in `packages/agents/src/tools.ts`: pass an explicit param type to your `func` and cast `schema: yourSchema as any` in the constructor — no runtime change, zod still validates normally, it just stops TS from trying to unify the schema's inferred type with `func`'s signature.
- An incident is only `DIAGNOSED` once `runConcurrentDiagnosis()` confirms a root cause — poll/react to that status before starting the remediation race
- `evaluateRemediationPolicy(namespace, rootCause)` from `@agentguard/agents` gives you an advisory `{approved, action, estimatedCost, availableBudget}` — reuse `estimateRemediationCost()`'s action mapping (`restart` / `rollback` / `scale-up` / `config-fix`) as the seed for what each remediation agent actually tries to execute
- **Root `package.json` pins `"overrides": { "zod": "3.23.8" }`.** Newer zod (3.25+) combined with this `@langchain/core` version makes any `DynamicStructuredTool`/`tool()` call fail TypeScript compilation with `TS2589: Type instantiation is excessively deep` — reproduced and confirmed in this repo. If you add new LangChain tools in Phase 3 and hit that error after touching dependencies, check this override is still in place before debugging your own schema.
