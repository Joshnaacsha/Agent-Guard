import type { Incident } from '@agentguard/db';
import {
  claimIncidentForRemediation, claimRemediationBudget, resolveIncident,
  logAgentAction, getConfirmedDiagnosis,
} from '@agentguard/db';
import { estimateRemediationCost, type RemediationAction } from './policy';
import { checkClusterCapacity } from './opsAgent';
import { applyAwsFix, isLambdaOriginatedIncident, type AwsFixResult } from './awsRemediator';

export interface RemediationAgentInput {
  incident: Incident;
  agentId: string;
}

export interface RemediationAgentResult {
  agentId: string;
  incidentId: string;
  outcome: 'COMMITTED' | 'REJECTED';
  reason: string;
  action: RemediationAction | null;
  cost: number | null;
  retries: number;
  /** set only when the incident came from a real Lambda invocation and a real AWS fix was attempted */
  awsFix: AwsFixResult | null;
}

/**
 * A single remediation agent's full attempt at closing out one incident:
 * 1. Race the atomic claim (`claimIncidentForRemediation`) — only one agent per incident wins.
 * 2. Losers stop here (REJECTED, no budget touched — the claim is the concurrency gate).
 * 3. The winner checks cluster capacity (advisory), estimates the fix cost from the confirmed
 *    root cause, then races the budget write-skew transaction against every other agent
 *    currently spending in the same namespace.
 * 4. On a successful budget draw, executes the fix (simulated) and resolves the incident.
 */
export async function runRemediationAgent(input: RemediationAgentInput): Promise<RemediationAgentResult> {
  const { incident, agentId } = input;

  const claimed = await claimIncidentForRemediation(incident.incident_id);
  if (!claimed) {
    await logAgentAction(incident.incident_id, agentId, 'claim_remediation', 'REJECTED');
    return {
      agentId,
      incidentId: incident.incident_id,
      outcome: 'REJECTED',
      reason: 'Lost the claim race - another agent is already remediating this incident.',
      action: null,
      cost: null,
      retries: 0,
      awsFix: null,
    };
  }

  await checkClusterCapacity();

  const diagnosis = await getConfirmedDiagnosis(incident.incident_id);
  const rootCause = diagnosis?.root_cause ?? 'unknown root cause';
  const { action, estimatedCost } = estimateRemediationCost(rootCause);

  let retries = 0;
  const { success, remainingBudget } = await claimRemediationBudget(
    incident.namespace,
    estimatedCost,
    () => {
      retries++;
    }
  );

  if (retries > 0) {
    await logAgentAction(incident.incident_id, agentId, `budget_conflict x${retries}`, 'RETRIED');
  }

  if (!success) {
    await logAgentAction(incident.incident_id, agentId, `remediate:${action}`, 'REJECTED');
    return {
      agentId,
      incidentId: incident.incident_id,
      outcome: 'REJECTED',
      reason: `Insufficient budget: needed $${estimatedCost}, only $${remainingBudget} left in ${incident.namespace}.`,
      action,
      cost: estimatedCost,
      retries,
      awsFix: null,
    };
  }

  // If this incident came from a real pod-worker Lambda crash, actually fix the Lambda —
  // real UpdateFunctionConfiguration call, then a real re-invocation proving it now succeeds —
  // instead of only flipping the incident's status in the database.
  let awsFix: AwsFixResult | null = null;
  if (isLambdaOriginatedIncident(incident.pod_name)) {
    awsFix = await applyAwsFix(action);
    await logAgentAction(
      incident.incident_id,
      agentId,
      `aws_fix:${action}${awsFix.verified === false ? ':unverified' : ''}`,
      awsFix.applied && awsFix.verified !== false ? 'COMMITTED' : 'REJECTED'
    );
  }

  await resolveIncident(incident.incident_id);
  await logAgentAction(incident.incident_id, agentId, `remediate:${action}`, 'COMMITTED');

  return {
    agentId,
    incidentId: incident.incident_id,
    outcome: 'COMMITTED',
    reason: `Executed '${action}' for $${estimatedCost}; $${remainingBudget} left in ${incident.namespace}.` +
      (awsFix ? ` AWS: ${awsFix.detail}${awsFix.verified === true ? ' Verified fixed.' : awsFix.verified === false ? ' Re-invoke still failed.' : ''}` : ''),
    action,
    cost: estimatedCost,
    retries,
    awsFix,
  };
}
