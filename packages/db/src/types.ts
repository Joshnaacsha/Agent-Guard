export type IncidentStatus = 'DETECTED' | 'DIAGNOSING' | 'DIAGNOSED' | 'REMEDIATING' | 'RESOLVED';
export type DiagnosisStatus = 'PROPOSED' | 'CONFIRMED' | 'SUPERSEDED';
export type ActionOutcome = 'COMMITTED' | 'REJECTED' | 'RETRIED' | 'SUPERSEDED';

export interface Incident {
  incident_id: string;
  pod_name: string;
  namespace: string;
  status: IncidentStatus;
  version: number;
  created_at: Date;
}

export interface Diagnosis {
  diagnosis_id: string;
  incident_id: string;
  agent_id: string;
  root_cause: string;
  confidence: number;
  status: DiagnosisStatus;
  created_at: Date;
}

export interface RemediationBudget {
  namespace: string;
  budget: number;
}

export interface AgentAction {
  action_id: string;
  incident_id: string;
  agent_id: string;
  action: string;
  outcome: ActionOutcome;
  created_at: Date;
}

export interface IncidentMemory {
  memory_id: string;
  incident_id: string | null;
  summary: string;
  resolution: string;
  embedding: number[];
  created_at: Date;
}
