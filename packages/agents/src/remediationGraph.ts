import { StateGraph, Annotation, Send, START, END } from '@langchain/langgraph';
import type { Incident } from '@agentguard/db';
import { runRemediationAgent, type RemediationAgentResult } from './remediationAgent';

export interface RemediationSummary {
  incidentId: string;
  agentCount: number;
  committed: number;
  rejected: number;
  retriedActions: number;
  committedAction: string | null;
  committedCost: number | null;
}

const RemediationGraphState = Annotation.Root({
  incident: Annotation<Incident>(),
  agentCount: Annotation<number>(),
  agentId: Annotation<string>(),
  results: Annotation<RemediationAgentResult[]>({
    reducer: (existing, update) => existing.concat(update),
    default: () => [],
  }),
  summary: Annotation<RemediationSummary | null>({
    reducer: (_existing, update) => update,
    default: () => null,
  }),
});

type RemediationState = typeof RemediationGraphState.State;

/**
 * Fans out into N concurrent remediation_agent branches racing to claim + act on the same
 * incident — the "N concurrent claim attempts" mechanic from the plan. Mirrors
 * diagnosisGraph's Send-based fan-out.
 */
function dispatchRemediationAgents(state: RemediationState): Send[] {
  return Array.from({ length: state.agentCount }, (_, i) =>
    new Send('remediation_agent', { ...state, agentId: `remediate-agent-${i + 1}` })
  );
}

async function remediationAgentNode(state: RemediationState): Promise<Partial<RemediationState>> {
  const result = await runRemediationAgent({ incident: state.incident, agentId: state.agentId });
  return { results: [result] };
}

async function aggregateNode(state: RemediationState): Promise<Partial<RemediationState>> {
  const { results, incident } = state;
  const committed = results.filter((r) => r.outcome === 'COMMITTED');
  const rejected = results.filter((r) => r.outcome === 'REJECTED');
  const retriedActions = results.reduce((sum, r) => sum + r.retries, 0);

  const summary: RemediationSummary = {
    incidentId: incident.incident_id,
    agentCount: results.length,
    committed: committed.length,
    rejected: rejected.length,
    retriedActions,
    committedAction: committed[0]?.action ?? null,
    committedCost: committed[0]?.cost ?? null,
  };

  return { summary };
}

const graph = new StateGraph(RemediationGraphState)
  .addNode('remediation_agent', remediationAgentNode)
  .addNode('aggregate', aggregateNode)
  .addConditionalEdges(START, dispatchRemediationAgents, ['remediation_agent'])
  .addEdge('remediation_agent', 'aggregate')
  .addEdge('aggregate', END);

export const remediationGraph = graph.compile();

export interface RunConcurrentRemediationOptions {
  incident: Incident;
  agentCount?: number;
}

export interface RunConcurrentRemediationResult {
  summary: RemediationSummary;
  results: RemediationAgentResult[];
}

export async function runConcurrentRemediation(
  opts: RunConcurrentRemediationOptions
): Promise<RunConcurrentRemediationResult> {
  const finalState = await remediationGraph.invoke({
    incident: opts.incident,
    agentCount: opts.agentCount ?? 5,
    agentId: '',
  });

  return { summary: finalState.summary as RemediationSummary, results: finalState.results };
}
