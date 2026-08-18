import { getPool, withTransaction } from './client';
import { withRetry } from './retry';
import type {
  Incident, IncidentStatus, Diagnosis,
  AgentAction, RemediationBudget, ActionOutcome,
} from './types';

export async function createIncident(podName: string, namespace: string): Promise<Incident> {
  const { rows } = await getPool().query<Incident>(
    `INSERT INTO incidents (pod_name, namespace) VALUES ($1, $2) RETURNING *`,
    [podName, namespace]
  );
  return rows[0];
}

export async function getIncident(incidentId: string): Promise<Incident | null> {
  const { rows } = await getPool().query<Incident>(
    `SELECT * FROM incidents WHERE incident_id = $1`,
    [incidentId]
  );
  return rows[0] ?? null;
}

export async function listIncidents(limit = 50): Promise<Incident[]> {
  const { rows } = await getPool().query<Incident>(
    `SELECT * FROM incidents ORDER BY created_at DESC LIMIT $1`,
    [limit]
  );
  return rows;
}

export async function updateIncidentStatus(
  incidentId: string,
  status: IncidentStatus
): Promise<Incident> {
  const { rows } = await getPool().query<Incident>(
    `UPDATE incidents SET status = $1, version = version + 1
     WHERE incident_id = $2 RETURNING *`,
    [status, incidentId]
  );
  return rows[0];
}

// Basic insert — Phase 2 replaces this with the full reconciliation transaction
export async function proposeDiagnosis(
  incidentId: string,
  agentId: string,
  rootCause: string,
  confidence: number
): Promise<Diagnosis> {
  const { rows } = await getPool().query<Diagnosis>(
    `INSERT INTO diagnoses (incident_id, agent_id, root_cause, confidence, status)
     VALUES ($1, $2, $3, $4, 'PROPOSED') RETURNING *`,
    [incidentId, agentId, rootCause, confidence]
  );
  return rows[0];
}

export async function getDiagnoses(incidentId: string): Promise<Diagnosis[]> {
  const { rows } = await getPool().query<Diagnosis>(
    `SELECT * FROM diagnoses WHERE incident_id = $1 ORDER BY created_at ASC`,
    [incidentId]
  );
  return rows;
}

export interface ReconciliationResult {
  diagnosis: Diagnosis;
  /** true if an already-CONFIRMED diagnosis existed and this one was written as SUPERSEDED */
  reconciled: boolean;
  confirmedDiagnosisId: string;
}

/**
 * The reconciliation transaction: reads whether a CONFIRMED diagnosis already exists
 * for this incident, then writes this proposal as CONFIRMED (if none does) or SUPERSEDED
 * (if one does) — inside the same transaction. Under CockroachDB SERIALIZABLE isolation,
 * two agents racing this same read-then-write on the same incident_id cannot both land as
 * CONFIRMED: one commits, the other gets SQLSTATE 40001 and must retry — on retry it
 * observes the winner's CONFIRMED row and correctly writes itself as SUPERSEDED. This is
 * what turns "two agents disagree" into "one confirmed root cause", not a plain race.
 */
export async function proposeDiagnosisWithReconciliation(
  incidentId: string,
  agentId: string,
  rootCause: string,
  confidence: number
): Promise<ReconciliationResult> {
  return withRetry(() =>
    withTransaction(async (client) => {
      const { rows: confirmed } = await client.query<Diagnosis>(
        `SELECT * FROM diagnoses WHERE incident_id = $1 AND status = 'CONFIRMED' LIMIT 1`,
        [incidentId]
      );

      const status = confirmed.length > 0 ? 'SUPERSEDED' : 'CONFIRMED';

      const { rows } = await client.query<Diagnosis>(
        `INSERT INTO diagnoses (incident_id, agent_id, root_cause, confidence, status)
         VALUES ($1, $2, $3, $4, $5) RETURNING *`,
        [incidentId, agentId, rootCause, confidence, status]
      );

      return {
        diagnosis: rows[0],
        reconciled: status === 'SUPERSEDED',
        confirmedDiagnosisId: confirmed[0]?.diagnosis_id ?? rows[0].diagnosis_id,
      };
    })
  );
}

export async function getConfirmedDiagnosis(incidentId: string): Promise<Diagnosis | null> {
  const { rows } = await getPool().query<Diagnosis>(
    `SELECT * FROM diagnoses WHERE incident_id = $1 AND status = 'CONFIRMED' LIMIT 1`,
    [incidentId]
  );
  return rows[0] ?? null;
}

export async function logAgentAction(
  incidentId: string,
  agentId: string,
  action: string,
  outcome: ActionOutcome
): Promise<AgentAction> {
  const { rows } = await getPool().query<AgentAction>(
    `INSERT INTO agent_actions (incident_id, agent_id, action, outcome)
     VALUES ($1, $2, $3, $4) RETURNING *`,
    [incidentId, agentId, action, outcome]
  );
  return rows[0];
}

export async function seedRemediationBudget(namespace: string, budget: number): Promise<void> {
  await getPool().query(
    `UPSERT INTO remediation_budget (namespace, budget) VALUES ($1, $2)`,
    [namespace, budget]
  );
}

export async function getRemediationBudget(namespace: string): Promise<RemediationBudget | null> {
  const { rows } = await getPool().query<RemediationBudget>(
    `SELECT * FROM remediation_budget WHERE namespace = $1`,
    [namespace]
  );
  return rows[0] ?? null;
}

export async function insertIncidentMemory(
  summary: string,
  resolution: string,
  embedding: number[],
  incidentId?: string
): Promise<{ memory_id: string }> {
  const vectorStr = `[${embedding.join(',')}]`;
  const { rows } = await getPool().query<{ memory_id: string }>(
    `INSERT INTO incident_memory (incident_id, summary, resolution, embedding)
     VALUES ($1, $2, $3, $4::vector) RETURNING memory_id`,
    [incidentId ?? null, summary, resolution, vectorStr]
  );
  return rows[0];
}

export async function getAgentActions(incidentId: string): Promise<AgentAction[]> {
  const { rows } = await getPool().query<AgentAction>(
    `SELECT * FROM agent_actions WHERE incident_id = $1 ORDER BY created_at ASC`,
    [incidentId]
  );
  return rows;
}

export async function listRemediationBudgets(): Promise<RemediationBudget[]> {
  const { rows } = await getPool().query<RemediationBudget>(`SELECT * FROM remediation_budget`);
  return rows;
}

/**
 * The atomic claim transaction (Phase 3): a single conditional UPDATE that only succeeds if
 * the incident is still DIAGNOSED. Under concurrent load N agents can issue this against the
 * same incident_id; CockroachDB serializes them so at most one UPDATE's WHERE clause matches
 * and returns a row — every other agent's statement simply updates 0 rows (not an error, no
 * retry needed) because by the time it runs the status column has already moved off DIAGNOSED.
 * This is what prevents two remediation agents from both acting on the same incident.
 */
export async function claimIncidentForRemediation(incidentId: string): Promise<Incident | null> {
  return withRetry(async () => {
    const { rows } = await getPool().query<Incident>(
      `UPDATE incidents SET status = 'REMEDIATING', version = version + 1
       WHERE incident_id = $1 AND status = 'DIAGNOSED' RETURNING *`,
      [incidentId]
    );
    return rows[0] ?? null;
  });
}

export async function resolveIncident(incidentId: string): Promise<Incident> {
  const { rows } = await getPool().query<Incident>(
    `UPDATE incidents SET status = 'RESOLVED', version = version + 1
     WHERE incident_id = $1 RETURNING *`,
    [incidentId]
  );
  return rows[0];
}

export interface BudgetClaimResult {
  success: boolean;
  remainingBudget: number;
}

/**
 * The budget write-skew transaction (Phase 3): reads the current namespace budget, decides
 * whether the proposed spend fits, then writes the deduction — all inside one transaction.
 * When multiple agents concurrently draw against the same namespace's budget, CockroachDB
 * SERIALIZABLE isolation means only non-conflicting reads/writes commit cleanly; overlapping
 * draws produce a real SQLSTATE 40001 that `withRetry` catches and retries — on retry the
 * agent re-reads the (now lower) budget and re-decides, so no draw can ever push the budget
 * negative and no double-spend can be silently committed. `onRetry` lets callers log each
 * genuine 40001 conflict to `agent_actions` for the audit trail.
 */
export async function claimRemediationBudget(
  namespace: string,
  amount: number,
  onRetry?: (attempt: number) => void
): Promise<BudgetClaimResult> {
  return withRetry(
    () =>
      withTransaction(async (client) => {
        const { rows } = await client.query<RemediationBudget>(
          `SELECT * FROM remediation_budget WHERE namespace = $1`,
          [namespace]
        );
        const currentBudget = Number(rows[0]?.budget ?? 0);

        if (currentBudget < amount) {
          return { success: false, remainingBudget: currentBudget };
        }

        const { rows: updated } = await client.query<RemediationBudget>(
          `UPDATE remediation_budget SET budget = budget - $2
           WHERE namespace = $1 RETURNING *`,
          [namespace, amount]
        );

        return { success: true, remainingBudget: Number(updated[0].budget) };
      }),
    5,
    onRetry
  );
}

export async function searchSimilarIncidents(
  embedding: number[],
  limit = 5
): Promise<Array<{ memory_id: string; summary: string; resolution: string; distance: number }>> {
  const vectorStr = `[${embedding.join(',')}]`;
  const { rows } = await getPool().query(
    `SELECT memory_id, summary, resolution, embedding <-> $1::vector AS distance
     FROM incident_memory
     ORDER BY embedding <-> $1::vector
     LIMIT $2`,
    [vectorStr, limit]
  );
  return rows;
}
