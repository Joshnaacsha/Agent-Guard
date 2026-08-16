import { getPool } from './client';
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
