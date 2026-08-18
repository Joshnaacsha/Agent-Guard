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

Plus a real AWS chaos demo: a genuine Lambda function stands in for a pod's container process. Crashing it for real (OOM kill, timeout) creates a real incident, and remediation calls the real AWS API to fix it — then re-invokes the function to prove the fix actually holds.

---

## Architecture

```
React Frontend (Vite) — login, incident console, live agent-race visualizer
  ↕  Supabase Auth        — login/session
  ↕  Backend REST API     — trigger incidents, fetch state

Backend (LangGraph + Express + TypeScript)
  ↕  CockroachDB direct (@agentguard/db)  — all agent reads/writes
  ↕  Gemini API                           — embeddings + LLM reasoning
  ↕  ccloud CLI (opsAgent.ts)             — capacity check, shelled out for real
  ↕  AWS Lambda SDK                       — invoke + reconfigure the real pod-worker function

CockroachDB (Shared Agent Memory)
     incidents           — pod failure events
     diagnoses           — agent conclusions (PROPOSED / CONFIRMED / SUPERSEDED)
     remediation_budget  — per-namespace budget, drawn under real write-skew contention
     agent_actions       — full audit log of every agent operation
     incident_memory     — VECTOR(3072) index of past incidents for similarity search

AWS Lambda (infra/lambda/pod-worker) — a real function that crashes for real (crash-loop / OOM / timeout);
remediation issues a real UpdateFunctionConfiguration call and re-invokes it to verify the fix
```

The CockroachDB Managed MCP Server is documented in `.env.example` but not wired into any running code — the two CockroachDB tools actually in use are **Distributed Vector Indexing** (`incident_memory`) and the **ccloud CLI** (`opsAgent.ts`), which clears the hackathon's "at least two" requirement without it.

---

## Tech Stack

| Layer | Technology |
|---|---|
| Frontend | React 18, Vite, TypeScript |
| Backend | Node.js, Express, LangGraph (TypeScript) |
| Agents | LangGraph, `@langchain/google-genai` — package `@agentguard/agents` (npm workspace) |
| Database | CockroachDB Cloud |
| Embeddings | `gemini-embedding-001` via `@google/generative-ai` (3072-dim) |
| LLM | `gemini-flash-latest` via `@langchain/google-genai` (pinned to the `-latest` alias — see gotchas below) |
| Cloud infra | AWS Lambda (`infra/lambda/`) via `@aws-sdk/client-lambda`; CockroachDB `ccloud` CLI shelled out from the Ops agent |
| Auth | Supabase |
| Shared DB package | `@agentguard/db` (npm workspace) |

---

## Project Structure

```
agentguard/
├── packages/
│   ├── db/                  # @agentguard/db — typed CockroachDB client + migrations
│   │   ├── src/
│   │   │   ├── client.ts    # connection pool, withTransaction
│   │   │   ├── retry.ts     # SQLSTATE 40001 retry wrapper
│   │   │   ├── queries.ts   # all named query functions, incl. both concurrency transactions
│   │   │   ├── types.ts     # TypeScript interfaces for all tables
│   │   │   └── migrations/run.ts  # migration runner
│   │   └── migrations/
│   │       ├── 001_init.sql           # creates all 5 tables + vector index
│   │       └── 002_fix_vector_dim.sql # updates vector column to 3072 dims
│   └── agents/               # @agentguard/agents — every LangGraph agent
│       └── src/
│           ├── tools.ts               # search_similar_incidents LangChain tool
│           ├── diagnosisAgent.ts      # single diagnosis agent
│           ├── diagnosisGraph.ts      # concurrent diagnosis subgraph (Phase 2)
│           ├── policy.ts              # Cost/Policy agent
│           ├── opsAgent.ts            # Ops/Capacity agent — real ccloud CLI call
│           ├── remediationAgent.ts    # single remediation agent
│           ├── remediationGraph.ts    # concurrent remediation subgraph (Phase 3)
│           ├── awsRemediator.ts       # applies + verifies a real fix on the pod-worker Lambda
│           ├── consistencyChecker.ts  # independent post-hoc audit of DB invariants
│           ├── benchmark.ts           # diagnosis benchmark (npm run benchmark:diagnosis)
│           ├── remediationBenchmark.ts # remediation benchmark (npm run benchmark:remediation)
│           └── embeddings/pipeline.ts # Gemini embedding wrapper
├── apps/
│   ├── backend/             # Express API — thin HTTP layer over @agentguard/agents + @agentguard/db
│   │   └── src/
│   │       ├── index.ts
│   │       ├── api/routes.ts
│   │       ├── aws/lambdaInvoker.ts   # invokes the real pod-worker Lambda for the chaos demo
│   │       └── embeddings/seed.ts     # seeds 15 past incidents + budgets
│   ├── frontend/            # React + Vite dashboard (needs its own .env — see Setup)
│   │   └── src/
│   │       ├── App.tsx      # landing page + incident console + live agent-race visualizer
│   │       ├── Auth.tsx     # Supabase email/password sign in / sign up
│   │       └── supabase.ts
│   └── simulator/           # Pod failure event generator
│       └── src/index.ts
├── infra/
│   └── lambda/
│       ├── deploy.sh            # creates/updates the agentguard-pod-worker Lambda (npm run lambda:deploy)
│       └── pod-worker/handler.js # the real Lambda function that crashes on demand
├── .env.example             # all required root env vars documented
└── .env                     # your actual values (gitignored) — used by backend, agents, db, simulator
```

---

## Prerequisites

- **Node.js 20+** — `node --version`
- **CockroachDB Cloud account** — [cockroachlabs.cloud](https://cockroachlabs.cloud) (free tier works)
- **Google AI Studio account** — [aistudio.google.com](https://aistudio.google.com) for Gemini API key
- **Supabase account** — [supabase.com](https://supabase.com) (free tier works)
- **AWS account with the CLI configured** (`aws configure` or SSO) — only needed for the Lambda chaos demo (`npm run lambda:deploy`, the "Invoke →" buttons). Everything else runs without it.
- **`ccloud` CLI, installed and authenticated** (optional) — the Ops agent's capacity check degrades gracefully to "available" if it's missing, so this is not required to run the app.

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

Fill in the root `.env` with your actual values:

| Variable | Where to get it |
|---|---|
| `COCKROACHDB_CONNECTION_STRING` | CockroachDB Cloud → Cluster → Connect → Connection string |
| `COCKROACHDB_MCP_URL`, `COCKROACHDB_MCP_API_KEY`, `COCKROACHDB_CLUSTER_ID` | Documented for future use — not currently required, MCP isn't wired into any code path yet |
| `GOOGLE_API_KEY` | aistudio.google.com → API keys |
| `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` | Supabase project → Settings → API (service role is backend-only, never exposed to the frontend) |
| `AWS_REGION` | e.g. `us-east-1` — only used by the Lambda chaos demo |
| `POD_WORKER_LAMBDA_NAME` | Defaults to `agentguard-pod-worker` — only change if you deployed under a different name |
| `PORT` | Backend port, defaults to `3001` |

**The frontend needs its own separate `.env`**, at `apps/frontend/.env` (Vite does not read the root `.env` — see `apps/frontend/.env.local.example`):

| Variable | Where to get it |
|---|---|
| `VITE_SUPABASE_URL` | Same as `SUPABASE_URL` above |
| `VITE_SUPABASE_ANON_KEY` | Supabase project → Settings → API → anon public key |

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

Needs its own `apps/frontend/.env` first — see Setup above.

```bash
npm run dev:frontend
# → http://localhost:5173  (Vite proxies /api to the backend on :3001)
```

### (Optional) Deploy the real AWS Lambda chaos demo

Requires AWS credentials configured locally (`aws configure`). Only needed for the "Invoke →" buttons in the dashboard's sidebar — everything else works without this.

```bash
npm run lambda:deploy
```

---

## API Endpoints

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/health` | Health check |
| `GET` | `/api/incidents` | List latest 50 incidents |
| `POST` | `/api/incidents/simulate` | Create a single simulated incident |
| `POST` | `/api/incidents/lambda-invoke` | Invoke the real `agentguard-pod-worker` Lambda with a failure mode (`crash-loop` / `oom` / `timeout`). A real crash becomes a real incident with the actual AWS error as its symptom. Body: `{ pod_name?, namespace?, failure_mode? }` |
| `POST` | `/api/incidents/:id/diagnose` | Fire N concurrent diagnosis agents at an incident, reconcile to one CONFIRMED root cause, run the policy agent against it. Body: `{ agent_count?, reconcile?, symptom? }` |
| `GET` | `/api/incidents/:id/diagnoses` | List every diagnosis written for an incident (PROPOSED / CONFIRMED / SUPERSEDED) |
| `POST` | `/api/incidents/:id/remediate` | Fire N concurrent remediation agents at a DIAGNOSED incident — exactly one claims + commits the fix. Body: `{ agent_count? }` |
| `GET` | `/api/incidents/:id/actions` | Full audit log of every agent action against one incident |
| `GET` | `/api/incidents/:id/consistency` | Independent audit of one incident's final state (no duplicate CONFIRMED diagnoses, no duplicate committed remediations) |
| `GET` | `/api/consistency` | Fleet-wide consistency check — all recent incidents + every namespace budget (none ever negative) |

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
| Phase 3 | Ashley | ✅ Complete | Concurrent remediation race + consistency checker + dashboard + real AWS Lambda chaos demo |

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
- **`@agentguard/agents`** (`packages/agents/`):
  - **`src/tools.ts`**: `search_similar_incidents` as a real LangChain `DynamicStructuredTool`, wrapping `generateEmbedding` + `searchSimilarIncidents` against `incident_memory`.
  - **`src/diagnosisAgent.ts`**: a single diagnosis agent — pulls similar past incidents via the tool, asks Gemini for a structured `{root_cause, confidence}`, then writes through either the reconciliation path or the naive `proposeDiagnosis()` (siloed mode, for contrast).
  - **`src/diagnosisGraph.ts`**: the LangGraph subgraph. A `Send`-based fan-out dispatches N `diagnosis_agent` branches concurrently against the same incident; an `aggregate` node tallies CONFIRMED/SUPERSEDED/PROPOSED and flips the incident to `DIAGNOSED` once a root cause is confirmed.
  - **`src/benchmark.ts`** (`npm run benchmark:diagnosis`): runs the same incident twice — once with reconciliation disabled (siloed: N independently-"true" root causes all sit in the table), once with it enabled (exactly 1 confirmed, rest superseded) — this is the "siloed vs. shared memory" proof point.
  - **`src/policy.ts`**: the Cost/Policy agent's approval logic — reads the current `remediation_budget` for a namespace, estimates the cost of the confirmed fix, and returns an approve/reject decision. Read-only and advisory; Phase 3's atomic claim + write-skew transaction on `remediation_budget` is what actually commits spend.
- **`POST /api/incidents/:id/diagnose`** and **`GET /api/incidents/:id/diagnoses`** wired in `apps/backend/src/api/routes.ts`.

## What Phase 3 Built

- **`@agentguard/db`** (`packages/db/src/queries.ts`):
  - `claimIncidentForRemediation()` — the atomic claim transaction: a single conditional `UPDATE incidents SET status='REMEDIATING' WHERE status='DIAGNOSED'`. Under concurrent load, CockroachDB serializes the statements so at most one `UPDATE` matches and returns a row — every other agent's statement just updates 0 rows, no error, no retry needed.
  - `claimRemediationBudget()` — the write-skew transaction: reads the namespace budget, decides if the draw fits, writes the deduction, all in one transaction. Concurrent draws against the same namespace produce real `SQLSTATE 40001` conflicts, caught and retried by `withRetry`, so the budget can never go negative and no draw is silently double-committed.
- **`@agentguard/agents`**:
  - **`src/remediationAgent.ts`**: one agent's full attempt — race the claim, losers stop (REJECTED, no budget touched); the winner checks capacity, estimates cost from the confirmed root cause, races the budget draw, then executes the fix (and the real AWS fix, if applicable) and resolves the incident.
  - **`src/remediationGraph.ts`**: the concurrent remediation subgraph — same `Send`-based fan-out pattern as `diagnosisGraph.ts`, N `remediation_agent` branches racing the same incident.
  - **`src/opsAgent.ts`**: the Ops/Capacity agent — shells out to the real `ccloud` CLI (`ccloud cluster describe`) as an advisory pre-remediation check; degrades to "available" if `ccloud` isn't installed/authenticated rather than blocking the demo.
  - **`src/consistencyChecker.ts`**: an independent post-hoc audit — never trusts an agent's own return value, only what's actually in the tables. Flags multiple `CONFIRMED` diagnoses, multiple `COMMITTED` remediations, negative budgets, and incidents stuck mid-flow.
  - **`src/remediationBenchmark.ts`** (`npm run benchmark:remediation`): runs the claim race and the budget-contention race at fleet sizes of 10/50/100, with a consistency check after each run.
- **`POST /api/incidents/:id/remediate`**, **`GET /api/incidents/:id/actions`**, **`GET /api/incidents/:id/consistency`**, **`GET /api/consistency`** wired in `apps/backend/src/api/routes.ts`.
- **The dashboard** (`apps/frontend/src/App.tsx`, `Auth.tsx`): Supabase auth, an incident console, a live "agent race" panel that reveals each of the 8 agents' verdicts as they land, a workflow stepper, the confirmed-root-cause and committed-action callouts, and the consistency-audit panel.

## The AWS Lambda Chaos Demo

This is what makes AWS load-bearing rather than decorative:

- **`infra/lambda/pod-worker/handler.js`** — a real Lambda function (128MB memory, 5s timeout) standing in for a pod's container process. Invoking it with `failureMode: 'crash-loop' | 'oom' | 'timeout'` causes a **genuine** AWS failure (a real container OOM kill, a real `Sandbox.Timedout`), not a simulated string.
- **`infra/lambda/deploy.sh`** (`npm run lambda:deploy`) — creates/updates the function and resets it to baseline config each deploy, so the demo is repeatable.
- **`apps/backend/src/aws/lambdaInvoker.ts`** — invokes the real function from the `POST /api/incidents/lambda-invoke` route; a real crash becomes a real incident, with the actual Lambda `requestId` and error as its symptom text.
- **`packages/agents/src/awsRemediator.ts`** — when remediation commits for a Lambda-originated incident, it makes a **real `UpdateFunctionConfiguration` call** (raises memory, raises timeout, or sets a hotfix env var) based on the confirmed root cause, waits for AWS to finish applying it, then **re-invokes the same function with the same failure mode to prove the fix actually holds** — not a DB status flip, an inspectable AWS API call plus verified proof.

## Known Gotchas

- `incident_memory.embedding` is `VECTOR(3072)` — `gemini-embedding-001` outputs 3072 dimensions; vector similarity search uses L2 distance (`<->` operator).
- All three namespace budgets are seeded: `production: $10,000`, `staging: $5,000`, `development: $2,000`.
- An incident is only `DIAGNOSED` once `runConcurrentDiagnosis()` confirms a root cause, and only `RESOLVED` once remediation commits — the frontend's workflow stepper reflects this directly from `incidents.status`.
- **Chat model is pinned to `gemini-flash-latest`** in `packages/agents/src/diagnosisAgent.ts`. Google deprecates concrete Gemini model IDs on a rolling basis without much notice (`gemini-2.0-flash`, then `gemini-2.5-flash`, both returned hard 404s during development) — the `-latest` alias avoids re-breaking this. If you ever get a 404 from a `ChatGoogleGenerativeAI` call, check `GET https://generativelanguage.googleapis.com/v1beta/models?key=$GOOGLE_API_KEY` for what's currently live before assuming your code is broken.
- **If you add a new LangChain tool and `tsc` fails with `TS2589: Type instantiation is excessively deep`**: this project's TS/zod/`@langchain/core` combination chokes on `DynamicStructuredTool`'s generic inference from a `ZodObject`. Do **not** "fix" it by pinning zod below 3.25 in `package.json` `overrides` — that resolves the type error but breaks at runtime (`@langchain/google-genai` does `require('zod/v3')`, a subpath export zod only added in 3.24+; this was tried and reverted). The actual fix, used in `packages/agents/src/tools.ts`: give your `func` an explicit param type and cast `schema: yourSchema as any` in the `DynamicStructuredTool` constructor — no runtime change, zod still validates normally, it just stops TS from trying to unify the schema's inferred type with `func`'s signature.
- The frontend needs its **own** `.env` at `apps/frontend/.env` (Vite doesn't read the root one) — see Setup above.
