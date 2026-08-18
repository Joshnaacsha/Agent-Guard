# AgentGuard

**Concurrency-safe, shared-memory incident response for Kubernetes — built on CockroachDB.**

Live demo: [agent-guard-frontend-six.vercel.app](https://agent-guard-frontend-six.vercel.app)

---

## Table of Contents

- [The Problem](#the-problem)
- [The Solution](#the-solution)
- [How It Works](#how-it-works)
- [Architecture](#architecture)
- [Tech Stack](#tech-stack)
- [Project Structure](#project-structure)
- [Prerequisites](#prerequisites)
- [Local Setup](#local-setup)
- [Running the App Locally](#running-the-app-locally)
- [Deploying to Production](#deploying-to-production)
- [API Reference](#api-reference)
- [Verifying It Works](#verifying-it-works)
- [Known Gotchas](#known-gotchas)

---

## The Problem

Production Kubernetes clusters are watched by more than one thing at once — multiple on-call engineers, multiple monitoring bots, increasingly multiple *AI agents* — all reacting to the same pod failures independently.

That independence is the problem. When several agents investigate and act on the same incident without a shared source of truth:

- **They duplicate work.** Three agents each spend an LLM call diagnosing the same crash loop from scratch, because none of them know the others are looking too.
- **They disagree with each other.** Agent A concludes "OOM — raise memory limit." Agent B concludes "bad deploy — roll back." Both get written down as fact. Nobody reconciles them, so the on-call human inherits the contradiction.
- **They race to fix the same thing twice.** Two agents both decide the fix is safe and both execute it — a double rollback, a double budget spend, a double API call to a cloud provider. In distributed systems this is a classic write-skew bug, and it's exactly as dangerous when the writer is an LLM agent instead of a human clicking a button twice.

Most "multi-agent" demos avoid this problem by construction — they run one agent at a time, or they let agents write to isolated, non-transactional stores (a Python dict, a JSON file, an in-memory cache) where races either can't happen or silently corrupt state without anyone noticing. That's not how real fleets of concurrent agents will actually run.

## The Solution

AgentGuard puts every agent's reads and writes through **one transactional shared memory in CockroachDB**, and uses CockroachDB's `SERIALIZABLE` isolation to make concurrency safety a property of the database, not a property of careful agent code.

Two concrete mechanics prove this, both live in the dashboard:

1. **Diagnosis reconciliation.** Fire N diagnosis agents at the same incident concurrently. Each one investigates independently (its own Gemini call, its own read of similar past incidents), but writes its conclusion through a single transaction that checks *"has anyone already confirmed a root cause for this incident?"* before deciding whether to write itself `CONFIRMED` or `SUPERSEDED`. Under `SERIALIZABLE`, two agents racing this can't both land `CONFIRMED` — the database forces one into a retry (`SQLSTATE 40001`), and on retry it correctly sees the winner and stands down. Exactly one root cause survives; the rest are recorded, not lost.
2. **Remediation race.** Fire N remediation agents at a diagnosed incident. They race to atomically claim it (`UPDATE incidents SET status='REMEDIATING' WHERE status='DIAGNOSED'` — at most one `UPDATE` can ever match) and then race again to draw from a shared per-namespace dollar budget (a write-skew transaction: read the budget, decide if the draw fits, write the deduction, all atomically). Every loser is rejected with zero side effects; the winner executes the real fix. The budget can never go negative, and the fix can never be applied twice.

On top of that, an **independent consistency checker** re-derives the truth from the tables after the fact — it never trusts what an agent claims it did, only what's actually committed. And a **real AWS Lambda chaos demo** makes the failures and fixes genuine rather than simulated: a Lambda function stands in for a pod's container process, gets crashed for real (OOM kill, timeout), and the winning remediation agent calls the real AWS API to fix it, then re-invokes the function to *prove* the fix holds — not just flip a status column.

## How It Works

```
1. A pod fails (simulated event, or a real AWS Lambda crash) → an `incidents` row is created.
2. N diagnosis agents fire concurrently, each reading similar past incidents via vector
   search, each calling Gemini for a root-cause hypothesis, each writing through the
   reconciliation transaction. One CONFIRMED diagnosis survives; the rest are SUPERSEDED.
3. The Cost/Policy agent checks the confirmed fix's estimated cost against the namespace budget.
4. N remediation agents fire concurrently, racing the atomic claim + the budget draw.
   The winner executes the fix (a real AWS API call for Lambda-originated incidents) and
   resolves the incident.
5. The consistency checker audits the final state: no duplicate CONFIRMED diagnoses, no
   duplicate committed remediations, no negative budgets.
```

Every step is visible in the dashboard's live "agent race" panel as it happens.

---

## Architecture

```
React Frontend (Vite, deployed on Vercel)
  ↕ Supabase Auth          — login/session
  ↕ Backend REST API       — trigger incidents, fetch state (VITE_API_URL)

Backend (LangGraph + Express + TypeScript, deployed on Render)
  ↕ CockroachDB direct (@agentguard/db)  — all agent reads/writes
  ↕ Gemini API                           — embeddings + LLM reasoning
  ↕ ccloud CLI (opsAgent.ts)             — capacity check, shelled out for real
  ↕ AWS Lambda SDK                       — invoke + reconfigure the real pod-worker function

CockroachDB (Shared Agent Memory)
     incidents           — pod failure events
     diagnoses           — agent conclusions (PROPOSED / CONFIRMED / SUPERSEDED)
     remediation_budget  — per-namespace budget, drawn under real write-skew contention
     agent_actions       — full audit log of every agent operation
     incident_memory     — VECTOR(3072) index of past incidents for similarity search

AWS Lambda (infra/lambda/pod-worker) — a real function that crashes for real
(crash-loop / OOM / timeout); remediation issues a real UpdateFunctionConfiguration
call and re-invokes it to verify the fix
```

The CockroachDB Managed MCP Server is documented in `.env.example` but not wired into any running code path — the two CockroachDB mechanisms actually in use are **Distributed Vector Indexing** (`incident_memory`) and the **`ccloud` CLI** (`opsAgent.ts`).

---

## Tech Stack

| Layer | Technology |
|---|---|
| Frontend | React 18, Vite, TypeScript — hosted on **Vercel** |
| Backend | Node.js, Express, LangGraph (TypeScript) — hosted on **Render** |
| Agents | LangGraph, `@langchain/google-genai` — package `@agentguard/agents` (npm workspace) |
| Database | CockroachDB Cloud |
| Embeddings | `gemini-embedding-001` via `@google/generative-ai` (3072-dim) |
| LLM | `gemini-flash-latest` via `@langchain/google-genai` (pinned to the `-latest` alias — see gotchas) |
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
│           ├── diagnosisGraph.ts      # concurrent diagnosis subgraph
│           ├── policy.ts              # Cost/Policy agent
│           ├── opsAgent.ts            # Ops/Capacity agent — real ccloud CLI call
│           ├── remediationAgent.ts    # single remediation agent
│           ├── remediationGraph.ts    # concurrent remediation subgraph
│           ├── awsRemediator.ts       # applies + verifies a real fix on the pod-worker Lambda
│           ├── consistencyChecker.ts  # independent post-hoc audit of DB invariants
│           ├── benchmark.ts           # diagnosis benchmark (npm run benchmark:diagnosis)
│           ├── remediationBenchmark.ts # remediation benchmark (npm run benchmark:remediation)
│           └── embeddings/pipeline.ts # Gemini embedding wrapper
├── apps/
│   ├── backend/             # Express API — thin HTTP layer over @agentguard/agents + @agentguard/db
│   │   └── src/
│   │       ├── index.ts               # CORS_ORIGIN-aware CORS setup
│   │       ├── api/routes.ts
│   │       ├── aws/lambdaInvoker.ts   # invokes the real pod-worker Lambda for the chaos demo
│   │       └── embeddings/seed.ts     # seeds 15 past incidents + budgets
│   ├── frontend/            # React + Vite dashboard (needs its own .env — see Setup)
│   │   └── src/
│   │       ├── App.tsx      # landing page + incident console + live agent-race visualizer
│   │       ├── Auth.tsx     # Supabase email/password sign in / sign up
│   │       ├── api.ts       # apiUrl() — prefixes fetches with VITE_API_URL in production
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
- **Google AI Studio account** — [aistudio.google.com](https://aistudio.google.com) for a Gemini API key
- **Supabase account** — [supabase.com](https://supabase.com) (free tier works)
- **AWS account with the CLI configured** (`aws configure` or SSO) — only needed for the Lambda chaos demo (`npm run lambda:deploy`, the "Invoke →" buttons). Everything else runs without it.
- **`ccloud` CLI, installed and authenticated** (optional) — the Ops agent's capacity check degrades gracefully to "available" if it's missing, so this is not required to run the app.

---

## Local Setup

### 1. Clone and install

```bash
git clone <repo-url>
cd agentguard
npm install
```

This is an **npm workspaces monorepo** (`packages/*` + `apps/*`) — a single `npm install` at the repo root links everything.

### 2. Configure the root environment variables

```bash
cp .env.example .env
```

Fill in `.env` at the repo root:

| Variable | Where to get it |
|---|---|
| `COCKROACHDB_CONNECTION_STRING` | CockroachDB Cloud → Cluster → Connect → Connection string |
| `COCKROACHDB_MCP_URL`, `COCKROACHDB_MCP_API_KEY`, `COCKROACHDB_CLUSTER_ID` | Documented for future use — not currently required, MCP isn't wired into any code path yet |
| `GOOGLE_API_KEY` | aistudio.google.com → API keys |
| `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` | Supabase project → Settings → API (service role is backend-only, never exposed to the frontend) |
| `AWS_REGION`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` | Only used by the Lambda chaos demo. Locally, `aws configure` also works and the SDK will pick up `~/.aws/credentials` instead |
| `POD_WORKER_LAMBDA_NAME` | Defaults to `agentguard-pod-worker` — only change if you deployed under a different name |
| `PORT` | Backend port, defaults to `3001` |
| `CORS_ORIGIN` | Comma-separated allowed frontend origin(s). Leave empty for local dev (all origins allowed); required once frontend and backend are deployed on different domains |

### 3. Configure the frontend environment variables

**The frontend needs its own separate `.env`**, at `apps/frontend/.env` — Vite does not read the root `.env`.

```bash
cd apps/frontend
cp .env.local.example .env
```

| Variable | Where to get it |
|---|---|
| `VITE_SUPABASE_URL` | Same as `SUPABASE_URL` above |
| `VITE_SUPABASE_ANON_KEY` | Supabase project → Settings → API → anon public key |
| `VITE_API_URL` | Leave **empty** for local dev — Vite proxies `/api` to `localhost:3001` (see `vite.config.ts`). Only set this for a production build against a separately-hosted backend (see [Deploying to Production](#deploying-to-production)) |

### 4. Run database migrations

Creates all 5 tables and the vector index in CockroachDB:

```bash
npm run db:migrate
```

### 5. Seed the database

Seeds 15 past pod incidents (with Gemini embeddings) into `incident_memory`, and seeds per-namespace remediation budgets:

```bash
npm run seed
```

This takes ~30 seconds (15 Gemini embedding API calls).

---

## Running the App Locally

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
```powershell
$env:SIMULATOR_INTERVAL_MS=2000   # event every 2 seconds
$env:SIMULATOR_TOTAL_EVENTS=10    # stop after 10 events
npm run dev:simulator
```

### Start the frontend dashboard

Needs its own `apps/frontend/.env` first — see [Local Setup](#local-setup) above.

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

## Deploying to Production

The live demo runs the frontend on **Vercel** and the backend on **Render**, as two independent services talking cross-origin. This is the setup to replicate:

### Backend → Render

1. Create a new **Web Service** on Render, pointed at this repo.
2. **Root Directory:** leave blank (repo root) — the backend depends on `packages/agents` and `packages/db` via npm workspaces, so it can't build in isolation from `apps/backend` alone.
3. **Build Command:**
   ```
   npm install && npm run build --workspace=apps/backend
   ```
4. **Start Command:**
   ```
   npm run start --workspace=apps/backend
   ```
5. **Environment variables:** everything from `.env.example` (`COCKROACHDB_CONNECTION_STRING`, `GOOGLE_API_KEY`, `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `AWS_*`, `PORT`), plus:
   ```
   CORS_ORIGIN=https://<your-frontend-domain>.vercel.app
   ```
6. Deploy. Verify with `curl https://<your-service>.onrender.com/api/health`.

### Frontend → Vercel

1. Import the repo as a new Vercel project.
2. **Root Directory:** `apps/frontend`
3. **Framework Preset:** Vite
4. **Build Command:** `npm run build`
5. **Output Directory:** `dist`
6. **Install Command:** `npm install`
7. **Environment variables** (Settings → Environment Variables):
   ```
   VITE_SUPABASE_URL=...
   VITE_SUPABASE_ANON_KEY=...
   VITE_API_URL=https://<your-backend-service>.onrender.com
   ```
8. Deploy. `VITE_*` variables are baked in at **build time** — if you add or change one after the first deploy, you must trigger a fresh deployment (redeploy, don't just save the env var) for it to take effect.

Both sides need to agree with each other: the Vercel domain must be in the Render service's `CORS_ORIGIN`, and the Render URL must be in the Vercel project's `VITE_API_URL`.

---

## API Reference

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

## Verifying It Works

```bash
# 1. Check backend is up
curl http://localhost:3001/api/health

# 2. Run 5 simulator events
$env:SIMULATOR_TOTAL_EVENTS=5; npm run dev:simulator

# 3. Check incidents were created
curl http://localhost:3001/api/incidents

# 4. Prove diagnosis reconciliation: fire 8 concurrent agents at one incident,
#    once siloed and once reconciled, and print the proposed/confirmed/superseded contrast
npm run benchmark:diagnosis

# 5. Prove the remediation race + budget contention at fleet sizes of 10/50/100
npm run benchmark:remediation
```

Or drive it through the real API:

```bash
curl -X POST http://localhost:3001/api/incidents/simulate
# → note the incident_id, then:
curl -X POST http://localhost:3001/api/incidents/<incident_id>/diagnose \
  -H "Content-Type: application/json" -d '{"agent_count": 8}'
curl http://localhost:3001/api/incidents/<incident_id>/diagnoses
```

In the CockroachDB Cloud SQL Shell:

```sql
-- Seed data present
SELECT count(*) FROM incident_memory;       -- 15
SELECT namespace, budget FROM remediation_budget;

-- Vector index is actually used, not a full scan
EXPLAIN SELECT summary FROM incident_memory
ORDER BY embedding <-> '[0.1, 0.2]'::vector(3072) LIMIT 3;

-- Exactly one CONFIRMED diagnosis per incident, never more
SELECT incident_id, status, count(*) FROM diagnoses GROUP BY incident_id, status;
```

---

## Known Gotchas

- `incident_memory.embedding` is `VECTOR(3072)` — `gemini-embedding-001` outputs 3072 dimensions; vector similarity search uses L2 distance (`<->` operator).
- All three namespace budgets are seeded: `production: $10,000`, `staging: $5,000`, `development: $2,000`.
- An incident is only `DIAGNOSED` once `runConcurrentDiagnosis()` confirms a root cause, and only `RESOLVED` once remediation commits — the frontend's workflow stepper reflects this directly from `incidents.status`.
- **Chat model is pinned to `gemini-flash-latest`** in `packages/agents/src/diagnosisAgent.ts`. Google deprecates concrete Gemini model IDs on a rolling basis without much notice (`gemini-2.0-flash`, then `gemini-2.5-flash`, both returned hard 404s during development) — the `-latest` alias avoids re-breaking this. If you ever get a 404 from a `ChatGoogleGenerativeAI` call, check `GET https://generativelanguage.googleapis.com/v1beta/models?key=$GOOGLE_API_KEY` for what's currently live before assuming your code is broken.
- **If you add a new LangChain tool and `tsc` fails with `TS2589: Type instantiation is excessively deep`**: this project's TS/zod/`@langchain/core` combination chokes on `DynamicStructuredTool`'s generic inference from a `ZodObject`. Do **not** "fix" it by pinning zod below 3.25 in `package.json` `overrides` — that resolves the type error but breaks at runtime (`@langchain/google-genai` does `require('zod/v3')`, a subpath export zod only added in 3.24+; this was tried and reverted). The actual fix, used in `packages/agents/src/tools.ts`: give your `func` an explicit param type and cast `schema: yourSchema as any` in the `DynamicStructuredTool` constructor — no runtime change, zod still validates normally, it just stops TS from trying to unify the schema's inferred type with `func`'s signature.
- The frontend needs its **own** `.env` at `apps/frontend/.env` (Vite doesn't read the root one).
- **`VITE_*` variables are baked in at build time, not read at runtime.** Changing `VITE_API_URL` (or any `VITE_*` var) in Vercel's dashboard does nothing until you trigger a new deployment — saving the env var alone does not affect an already-built bundle.
- **CORS must be configured on both ends before the deployed dashboard can reach the deployed API.** If the frontend origin isn't in the backend's `CORS_ORIGIN`, requests will fail in the browser even though `curl` against the same endpoint succeeds (curl doesn't enforce CORS).
