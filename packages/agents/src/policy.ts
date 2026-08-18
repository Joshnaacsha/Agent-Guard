import { getRemediationBudget } from '@agentguard/db';

export type RemediationAction = 'restart' | 'rollback' | 'scale-up' | 'config-fix' | 'timeout-fix';

const ACTION_COST_TABLE: Record<RemediationAction, number> = {
  restart: 50,
  rollback: 300,
  'scale-up': 500,
  'config-fix': 20,
  'timeout-fix': 80,
};

export interface RemediationCostEstimate {
  action: RemediationAction;
  estimatedCost: number;
}

/** Cheap heuristic mapping a confirmed root cause to the fix it implies and its cost. */
export function estimateRemediationCost(rootCause: string): RemediationCostEstimate {
  const lower = rootCause.toLowerCase();
  let action: RemediationAction = 'restart';

  if (lower.includes('rollback') || lower.includes('bad deploy') || lower.includes('regression') || lower.includes('bad image')) {
    action = 'rollback';
  } else if (lower.includes('timed out') || lower.includes('timeout') || lower.includes('sandbox.timedout')) {
    action = 'timeout-fix';
  } else if (lower.includes('memory') || lower.includes('oom') || lower.includes('capacity') || lower.includes('scale') || lower.includes('gpu')) {
    action = 'scale-up';
  } else if (lower.includes('config') || lower.includes('secret') || lower.includes('env') || lower.includes('credential')) {
    action = 'config-fix';
  }

  return { action, estimatedCost: ACTION_COST_TABLE[action] };
}

export interface PolicyDecision {
  approved: boolean;
  namespace: string;
  action: RemediationAction;
  estimatedCost: number;
  availableBudget: number;
  reason: string;
}

/**
 * Cost/Policy agent's approval logic: reads the current remediation_budget snapshot for a
 * namespace and decides whether a proposed fix is affordable. This is advisory only — it does
 * not reserve or deduct budget. Phase 3's atomic claim + write-skew transaction on
 * remediation_budget is what actually commits the spend under concurrency.
 */
export async function evaluateRemediationPolicy(namespace: string, rootCause: string): Promise<PolicyDecision> {
  const budgetRow = await getRemediationBudget(namespace);
  const availableBudget = budgetRow?.budget ?? 0;
  const { action, estimatedCost } = estimateRemediationCost(rootCause);
  const approved = availableBudget >= estimatedCost;

  return {
    approved,
    namespace,
    action,
    estimatedCost,
    availableBudget,
    reason: approved
      ? `Estimated cost $${estimatedCost} for '${action}' is within the $${availableBudget} ${namespace} budget.`
      : `Estimated cost $${estimatedCost} for '${action}' exceeds the $${availableBudget} remaining ${namespace} budget.`,
  };
}
