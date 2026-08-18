import {
  getIncident, getDiagnoses, getAgentActions, listIncidents, listRemediationBudgets,
} from '@agentguard/db';

export interface ConsistencyIssue {
  severity: 'ERROR' | 'WARN';
  message: string;
}

export interface ConsistencyReport {
  incidentId: string;
  issues: ConsistencyIssue[];
  ok: boolean;
}

/**
 * Independently audits one incident's final state against the invariants the concurrency
 * transactions are supposed to guarantee — it never trusts an agent's own return value, only
 * what actually landed in the shared tables.
 */
export async function checkIncidentConsistency(incidentId: string): Promise<ConsistencyReport> {
  const incident = await getIncident(incidentId);
  if (!incident) {
    return { incidentId, issues: [{ severity: 'ERROR', message: 'Incident not found' }], ok: false };
  }

  const issues: ConsistencyIssue[] = [];

  const diagnoses = await getDiagnoses(incidentId);
  const confirmedDiagnoses = diagnoses.filter((d) => d.status === 'CONFIRMED');
  if (confirmedDiagnoses.length > 1) {
    issues.push({
      severity: 'ERROR',
      message: `${confirmedDiagnoses.length} CONFIRMED diagnoses for one incident — reconciliation invariant broken`,
    });
  }

  const actions = await getAgentActions(incidentId);
  const committedRemediations = actions.filter(
    (a) => a.action.startsWith('remediate:') && a.outcome === 'COMMITTED'
  );
  if (committedRemediations.length > 1) {
    issues.push({
      severity: 'ERROR',
      message: `${committedRemediations.length} COMMITTED remediations for one incident — duplicate action committed`,
    });
  }

  if (committedRemediations.length > 0 && incident.status !== 'RESOLVED') {
    issues.push({
      severity: 'WARN',
      message: `Remediation committed but incident status is ${incident.status}, expected RESOLVED`,
    });
  }

  if (incident.status === 'REMEDIATING' && committedRemediations.length === 0) {
    const claims = actions.filter((a) => a.action === 'claim_remediation' || a.action.startsWith('remediate:'));
    if (claims.length === 0) {
      issues.push({ severity: 'WARN', message: `Incident stuck in REMEDIATING with no logged remediation attempt` });
    }
  }

  return { incidentId, issues, ok: issues.every((i) => i.severity !== 'ERROR') };
}

export interface FleetConsistencyReport {
  reports: ConsistencyReport[];
  budgetIssues: ConsistencyIssue[];
  ok: boolean;
}

/** Runs the per-incident audit across the fleet, plus a global check that no budget went negative. */
export async function checkFleetConsistency(limit = 50): Promise<FleetConsistencyReport> {
  const incidents = await listIncidents(limit);
  const reports = await Promise.all(incidents.map((i) => checkIncidentConsistency(i.incident_id)));

  const budgets = await listRemediationBudgets();
  const budgetIssues: ConsistencyIssue[] = budgets
    .filter((b) => Number(b.budget) < 0)
    .map((b) => ({ severity: 'ERROR' as const, message: `Namespace ${b.namespace} has negative budget: $${b.budget}` }));

  const ok = reports.every((r) => r.ok) && budgetIssues.length === 0;
  return { reports, budgetIssues, ok };
}
