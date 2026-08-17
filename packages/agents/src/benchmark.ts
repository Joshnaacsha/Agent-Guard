import { config } from 'dotenv';
import { resolve } from 'path';
config({ path: resolve(__dirname, '..', '..', '..', '.env') });

import { createIncident, getDiagnoses } from '@agentguard/db';
import { runConcurrentDiagnosis } from './diagnosisGraph';
import { defaultSymptomFor } from './symptoms';

interface ArmResult {
  label: string;
  proposed: number;
  confirmed: number;
  superseded: number;
  distinctRootCauses: number;
}

async function runArm(label: string, agentCount: number, reconcile: boolean): Promise<ArmResult> {
  const incident = await createIncident(`bench-pod-${Date.now().toString(36)}`, 'production');
  const symptom = defaultSymptomFor(incident);

  console.log(`\n--- ${label} ---`);
  console.log(`Incident ${incident.incident_id.substring(0, 8)} | ${incident.namespace}/${incident.pod_name}`);
  console.log(`Symptom: ${symptom}`);
  console.log(`Firing ${agentCount} concurrent diagnosis agents (reconcile=${reconcile})...`);

  const start = Date.now();
  const { summary } = await runConcurrentDiagnosis({ incident, symptom, agentCount, reconcile });
  const elapsedMs = Date.now() - start;

  const diagnoses = await getDiagnoses(incident.incident_id);
  const distinctRootCauses = new Set(diagnoses.map((d) => d.root_cause)).size;

  console.log(`Done in ${elapsedMs}ms — proposed=${diagnoses.length} confirmed=${summary.confirmed} superseded=${summary.superseded}`);
  console.log(`Distinct root-cause texts written: ${distinctRootCauses}`);
  if (summary.confirmedRootCause) {
    console.log(`Confirmed root cause: ${summary.confirmedRootCause}`);
  }

  return {
    label,
    proposed: diagnoses.length,
    confirmed: summary.confirmed,
    superseded: summary.superseded,
    distinctRootCauses,
  };
}

function printComparison(rows: ArmResult[]): void {
  console.log('\n=== Diagnosis Benchmark: Siloed vs. Shared Memory ===\n');
  const header = ['Arm', 'Proposed', 'Confirmed', 'Superseded', 'Distinct root causes stored'];
  const widths = header.map((h) => h.length);
  const table = [header, ...rows.map((r) => [r.label, String(r.proposed), String(r.confirmed), String(r.superseded), String(r.distinctRootCauses)])];
  table.forEach((row) => row.forEach((cell, i) => { widths[i] = Math.max(widths[i], cell.length); }));
  table.forEach((row, i) => {
    console.log(row.map((cell, j) => cell.padEnd(widths[j])).join('  |  '));
    if (i === 0) console.log(widths.map((w) => '-'.repeat(w)).join('--|--'));
  });

  const siloed = rows.find((r) => r.label.startsWith('WITHOUT'));
  const reconciled = rows.find((r) => r.label.startsWith('WITH '));
  if (siloed && reconciled) {
    console.log(
      `\nWithout reconciliation: ${siloed.distinctRootCauses} independently-"true" root causes sit in the table at once.` +
      `\nWith reconciliation: exactly ${reconciled.confirmed} confirmed root cause, ${reconciled.superseded} correctly marked superseded.`
    );
  }
}

async function main(): Promise<void> {
  const agentCount = parseInt(process.env.BENCHMARK_AGENT_COUNT ?? '8', 10);

  const withoutReconciliation = await runArm('WITHOUT reconciliation (siloed)', agentCount, false);
  const withReconciliation = await runArm('WITH reconciliation (shared memory)', agentCount, true);

  printComparison([withoutReconciliation, withReconciliation]);
  process.exit(0);
}

main().catch((err) => {
  console.error('Benchmark failed:', err);
  process.exit(1);
});
