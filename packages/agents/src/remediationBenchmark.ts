import { config } from 'dotenv';
import { resolve } from 'path';
config({ path: resolve(__dirname, '..', '..', '..', '.env') });

import {
  createIncident, updateIncidentStatus, proposeDiagnosisWithReconciliation,
  seedRemediationBudget, getRemediationBudget,
} from '@agentguard/db';
import { runConcurrentRemediation } from './remediationGraph';
import { runRemediationAgent } from './remediationAgent';
import { checkIncidentConsistency, checkFleetConsistency } from './consistencyChecker';

async function seedDiagnosedIncident(namespace: string, rootCause: string) {
  const created = await createIncident(`remediate-pod-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`, namespace);
  await proposeDiagnosisWithReconciliation(created.incident_id, 'seed-diagnosis-agent', rootCause, 0.9);
  return updateIncidentStatus(created.incident_id, 'DIAGNOSED');
}

/** Race N remediation agents at ONE incident — proves the atomic claim transaction: exactly one COMMITTED. */
async function runClaimRace(agentCount: number): Promise<void> {
  const incident = await seedDiagnosedIncident('production', 'OOMKilled - memory limit too low');

  console.log(`\n--- Claim race: ${agentCount} agents vs. 1 incident ---`);
  console.log(`Incident ${incident.incident_id.substring(0, 8)} | ${incident.namespace}/${incident.pod_name}`);

  const start = Date.now();
  const { summary } = await runConcurrentRemediation({ incident, agentCount });
  const elapsedMs = Date.now() - start;

  console.log(
    `Done in ${elapsedMs}ms — committed=${summary.committed} rejected=${summary.rejected} retriedActions=${summary.retriedActions}`
  );
  if (summary.committedAction) {
    console.log(`Committed action: ${summary.committedAction} ($${summary.committedCost})`);
  }

  const report = await checkIncidentConsistency(incident.incident_id);
  console.log(`Consistency check: ${report.ok ? 'PASS' : 'FAIL'}${report.issues.length ? ' — ' + report.issues.map((i) => i.message).join('; ') : ''}`);
}

/** Fire one remediation agent per incident, N incidents at once, all drawing the SAME namespace budget — proves the write-skew transaction under real contention. */
async function runBudgetContention(fleetSize: number, namespace: string): Promise<void> {
  console.log(`\n--- Budget contention: ${fleetSize} incidents racing the ${namespace} budget ---`);

  const before = await getRemediationBudget(namespace);
  console.log(`Starting budget: $${before?.budget ?? 0}`);

  const incidents = await Promise.all(
    Array.from({ length: fleetSize }, () => seedDiagnosedIncident(namespace, 'OOMKilled - memory limit too low'))
  );

  const start = Date.now();
  const results = await Promise.all(
    incidents.map((incident, i) => runRemediationAgent({ incident, agentId: `fleet-agent-${i + 1}` }))
  );
  const elapsedMs = Date.now() - start;

  const committed = results.filter((r) => r.outcome === 'COMMITTED').length;
  const rejected = results.filter((r) => r.outcome === 'REJECTED').length;
  const totalRetries = results.reduce((sum, r) => sum + r.retries, 0);

  const after = await getRemediationBudget(namespace);
  console.log(
    `Done in ${elapsedMs}ms — committed=${committed} rejected=${rejected} budgetConflictRetries=${totalRetries}`
  );
  console.log(`Ending budget: $${after?.budget ?? 0} (never negative: ${Number(after?.budget ?? 0) >= 0})`);

  const fleet = await checkFleetConsistency(500);
  console.log(`Fleet consistency check: ${fleet.ok ? 'PASS' : 'FAIL'}`);
  if (!fleet.ok) {
    for (const r of fleet.reports.filter((r) => !r.ok)) console.log(`  incident ${r.incidentId}: ${r.issues.map((i) => i.message).join('; ')}`);
    for (const i of fleet.budgetIssues) console.log(`  ${i.message}`);
  }
}

async function main(): Promise<void> {
  await seedRemediationBudget('production', 10_000);

  const sizes = (process.env.BENCHMARK_FLEET_SIZES ?? '10,50,100').split(',').map((s) => parseInt(s.trim(), 10));

  for (const size of sizes) {
    await runClaimRace(size);
  }

  await seedRemediationBudget('remediation-bench', 2_000);
  for (const size of sizes) {
    await runBudgetContention(size, 'remediation-bench');
    await seedRemediationBudget('remediation-bench', 2_000); // reset for next size
  }

  console.log('\n=== Remediation benchmark complete ===');
  process.exit(0);
}

main().catch((err) => {
  console.error('Remediation benchmark failed:', err);
  process.exit(1);
});
