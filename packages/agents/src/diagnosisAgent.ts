import { ChatGoogleGenerativeAI } from '@langchain/google-genai';
import { z } from 'zod';
import type { Incident, DiagnosisStatus } from '@agentguard/db';
import { proposeDiagnosis, proposeDiagnosisWithReconciliation, logAgentAction } from '@agentguard/db';
import { findSimilarIncidents } from './tools';

const DiagnosisOutputSchema = z.object({
  root_cause: z.string().describe('A concise, specific root cause for the pod failure (one sentence)'),
  confidence: z.number().min(0).max(1).describe('Confidence in this root cause, from 0 to 1'),
});

let model: ChatGoogleGenerativeAI | null = null;
function getModel(): ChatGoogleGenerativeAI {
  if (!model) {
    model = new ChatGoogleGenerativeAI({ model: 'gemini-flash-latest', temperature: 0.4 });
  }
  return model;
}

export interface DiagnosisAgentInput {
  incident: Incident;
  symptom: string;
  agentId: string;
  /** Whether this agent writes through the reconciliation transaction, or proposes in isolation. */
  reconcile: boolean;
}

export interface DiagnosisAgentResult {
  agentId: string;
  incidentId: string;
  rootCause: string;
  confidence: number;
  status: DiagnosisStatus;
  /** true only when reconcile=true and this diagnosis lost to an already-CONFIRMED one */
  reconciled: boolean;
}

function buildPrompt(incident: Incident, symptom: string, similar: Awaited<ReturnType<typeof findSimilarIncidents>>): string {
  const context = similar.length
    ? similar
        .map((s, i) => `${i + 1}. [distance ${s.distance.toFixed(3)}] ${s.summary}\n   Resolution: ${s.resolution}`)
        .join('\n')
    : 'No similar past incidents found.';

  return [
    'You are a Kubernetes SRE diagnosis agent investigating a single pod incident.',
    `Pod: ${incident.pod_name}`,
    `Namespace: ${incident.namespace}`,
    `Symptom: ${symptom}`,
    '',
    'Similar past incidents (nearest first, from shared incident memory):',
    context,
    '',
    'Propose the single most likely root cause for this pod failure and your confidence in it.',
  ].join('\n');
}

export async function runDiagnosisAgent(input: DiagnosisAgentInput): Promise<DiagnosisAgentResult> {
  const { incident, symptom, agentId, reconcile } = input;

  const similar = await findSimilarIncidents(symptom, 3);
  const prompt = buildPrompt(incident, symptom, similar);

  const structuredModel = getModel().withStructuredOutput(DiagnosisOutputSchema, { name: 'diagnosis' });
  const { root_cause, confidence } = await structuredModel.invoke(prompt);

  if (reconcile) {
    const { diagnosis, reconciled } = await proposeDiagnosisWithReconciliation(
      incident.incident_id,
      agentId,
      root_cause,
      confidence
    );
    await logAgentAction(
      incident.incident_id,
      agentId,
      `propose_diagnosis:${diagnosis.status}`,
      reconciled ? 'SUPERSEDED' : 'COMMITTED'
    );
    return {
      agentId,
      incidentId: incident.incident_id,
      rootCause: root_cause,
      confidence,
      status: diagnosis.status,
      reconciled,
    };
  }

  // Siloed mode: no reconciliation check — every agent's claim stands on its own.
  const diagnosis = await proposeDiagnosis(incident.incident_id, agentId, root_cause, confidence);
  await logAgentAction(incident.incident_id, agentId, `propose_diagnosis:${diagnosis.status}`, 'COMMITTED');
  return {
    agentId,
    incidentId: incident.incident_id,
    rootCause: root_cause,
    confidence,
    status: diagnosis.status,
    reconciled: false,
  };
}
