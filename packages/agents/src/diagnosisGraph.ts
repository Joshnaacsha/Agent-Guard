import { StateGraph, Annotation, Send, START, END } from '@langchain/langgraph';
import type { Incident } from '@agentguard/db';
import { updateIncidentStatus } from '@agentguard/db';
import { runDiagnosisAgent, type DiagnosisAgentResult } from './diagnosisAgent';

export interface DiagnosisSummary {
  incidentId: string;
  agentCount: number;
  reconciliationEnabled: boolean;
  confirmed: number;
  superseded: number;
  proposed: number;
  confirmedRootCause: string | null;
}

const DiagnosisGraphState = Annotation.Root({
  incident: Annotation<Incident>(),
  symptom: Annotation<string>(),
  agentCount: Annotation<number>(),
  reconcile: Annotation<boolean>(),
  agentId: Annotation<string>(),
  results: Annotation<DiagnosisAgentResult[]>({
    reducer: (existing, update) => existing.concat(update),
    default: () => [],
  }),
  summary: Annotation<DiagnosisSummary | null>({
    reducer: (_existing, update) => update,
    default: () => null,
  }),
});

type DiagnosisState = typeof DiagnosisGraphState.State;

/**
 * Fans out into N concurrent diagnosis_agent branches — this is the graph-native
 * "N Diagnosis Agents run concurrently against the same incident" mechanic. LangGraph
 * runs every Send in parallel and only proceeds past diagnosis_agent once all N finish.
 */
function dispatchDiagnosisAgents(state: DiagnosisState): Send[] {
  return Array.from({ length: state.agentCount }, (_, i) =>
    new Send('diagnosis_agent', { ...state, agentId: `diag-agent-${i + 1}` })
  );
}

async function diagnosisAgentNode(state: DiagnosisState): Promise<Partial<DiagnosisState>> {
  const result = await runDiagnosisAgent({
    incident: state.incident,
    symptom: state.symptom,
    agentId: state.agentId,
    reconcile: state.reconcile,
  });
  return { results: [result] };
}

async function aggregateNode(state: DiagnosisState): Promise<Partial<DiagnosisState>> {
  const { results, incident, reconcile } = state;
  const confirmed = results.filter((r) => r.status === 'CONFIRMED');
  const superseded = results.filter((r) => r.status === 'SUPERSEDED');
  const proposed = results.filter((r) => r.status === 'PROPOSED');

  if (reconcile && confirmed.length > 0) {
    await updateIncidentStatus(incident.incident_id, 'DIAGNOSED');
  }

  const summary: DiagnosisSummary = {
    incidentId: incident.incident_id,
    agentCount: results.length,
    reconciliationEnabled: reconcile,
    confirmed: confirmed.length,
    superseded: superseded.length,
    proposed: proposed.length,
    confirmedRootCause: confirmed[0]?.rootCause ?? null,
  };

  return { summary };
}

const graph = new StateGraph(DiagnosisGraphState)
  .addNode('diagnosis_agent', diagnosisAgentNode)
  .addNode('aggregate', aggregateNode)
  .addConditionalEdges(START, dispatchDiagnosisAgents, ['diagnosis_agent'])
  .addEdge('diagnosis_agent', 'aggregate')
  .addEdge('aggregate', END);

export const diagnosisGraph = graph.compile();

export interface RunConcurrentDiagnosisOptions {
  incident: Incident;
  symptom: string;
  agentCount?: number;
  /** false runs the naive/siloed arm (no reconciliation) for benchmark contrast. */
  reconcile?: boolean;
}

export interface RunConcurrentDiagnosisResult {
  summary: DiagnosisSummary;
  results: DiagnosisAgentResult[];
}

export async function runConcurrentDiagnosis(
  opts: RunConcurrentDiagnosisOptions
): Promise<RunConcurrentDiagnosisResult> {
  const finalState = await diagnosisGraph.invoke({
    incident: opts.incident,
    symptom: opts.symptom,
    agentCount: opts.agentCount ?? 5,
    reconcile: opts.reconcile ?? true,
    agentId: '',
  });

  return { summary: finalState.summary as DiagnosisSummary, results: finalState.results };
}
