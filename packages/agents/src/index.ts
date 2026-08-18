// @agentguard/agents — built across Phase 1 (embedding pipeline),
// Phase 2 (diagnosis subgraph + policy agent), and Phase 3 (remediation subgraph).
export { generateEmbedding, generateEmbeddings } from './embeddings/pipeline';

export { searchSimilarIncidentsTool, findSimilarIncidents } from './tools';
export type { SimilarIncidentMatch } from './tools';

export { runDiagnosisAgent } from './diagnosisAgent';
export type { DiagnosisAgentInput, DiagnosisAgentResult } from './diagnosisAgent';

export { diagnosisGraph, runConcurrentDiagnosis } from './diagnosisGraph';
export type { DiagnosisSummary, RunConcurrentDiagnosisOptions, RunConcurrentDiagnosisResult } from './diagnosisGraph';

export { evaluateRemediationPolicy, estimateRemediationCost } from './policy';
export type { PolicyDecision, RemediationCostEstimate, RemediationAction } from './policy';

export { defaultSymptomFor } from './symptoms';

export { checkClusterCapacity } from './opsAgent';
export type { CapacityCheckResult } from './opsAgent';

export { applyAwsFix, isLambdaOriginatedIncident, parseLambdaFailureMode } from './awsRemediator';
export type { AwsFixResult } from './awsRemediator';

export { runRemediationAgent } from './remediationAgent';
export type { RemediationAgentInput, RemediationAgentResult } from './remediationAgent';

export { remediationGraph, runConcurrentRemediation } from './remediationGraph';
export type { RemediationSummary, RunConcurrentRemediationOptions, RunConcurrentRemediationResult } from './remediationGraph';

export { checkIncidentConsistency, checkFleetConsistency } from './consistencyChecker';
export type { ConsistencyIssue, ConsistencyReport, FleetConsistencyReport } from './consistencyChecker';
