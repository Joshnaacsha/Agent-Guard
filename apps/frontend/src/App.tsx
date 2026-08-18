import { useEffect, useState, useCallback } from 'react';

interface Incident {
  incident_id: string;
  pod_name: string;
  namespace: string;
  status: string;
  version: number;
  created_at: string;
}

interface Diagnosis {
  diagnosis_id: string;
  agent_id: string;
  root_cause: string;
  confidence: number;
  status: 'PROPOSED' | 'CONFIRMED' | 'SUPERSEDED';
  created_at: string;
}

interface AgentAction {
  action_id: string;
  agent_id: string;
  action: string;
  outcome: 'COMMITTED' | 'REJECTED' | 'RETRIED' | 'SUPERSEDED';
  created_at: string;
}

interface DiagnosisSummary {
  agentCount: number;
  reconciliationEnabled: boolean;
  confirmed: number;
  superseded: number;
  proposed: number;
  confirmedRootCause: string | null;
}

interface RemediationSummary {
  agentCount: number;
  committed: number;
  rejected: number;
  retriedActions: number;
  committedAction: string | null;
  committedCost: number | null;
}

interface ConsistencyIssue {
  severity: 'ERROR' | 'WARN';
  message: string;
}

interface ConsistencyReport {
  issues: ConsistencyIssue[];
  ok: boolean;
}

const statusColor: Record<string, string> = {
  DETECTED: '#888',
  DIAGNOSING: '#e6a700',
  DIAGNOSED: '#3b82f6',
  REMEDIATING: '#e6a700',
  RESOLVED: '#22c55e',
};

function StatusPill({ status }: { status: string }) {
  return (
    <span
      style={{
        color: statusColor[status] ?? '#888',
        border: `1px solid ${statusColor[status] ?? '#888'}`,
        borderRadius: 4,
        padding: '1px 6px',
        fontSize: 12,
      }}
    >
      {status}
    </span>
  );
}

function App() {
  const [backendStatus, setBackendStatus] = useState('Connecting...');
  const [incidents, setIncidents] = useState<Incident[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [diagnoses, setDiagnoses] = useState<Diagnosis[]>([]);
  const [actions, setActions] = useState<AgentAction[]>([]);
  const [diagnosisSummary, setDiagnosisSummary] = useState<DiagnosisSummary | null>(null);
  const [remediationSummary, setRemediationSummary] = useState<RemediationSummary | null>(null);
  const [consistency, setConsistency] = useState<ConsistencyReport | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refreshIncidents = useCallback(async () => {
    const r = await fetch('/api/incidents');
    setIncidents(await r.json());
  }, []);

  const refreshSelected = useCallback(async (id: string) => {
    const [diagRes, actionsRes, consistencyRes] = await Promise.all([
      fetch(`/api/incidents/${id}/diagnoses`),
      fetch(`/api/incidents/${id}/actions`),
      fetch(`/api/incidents/${id}/consistency`),
    ]);
    setDiagnoses(await diagRes.json());
    setActions(await actionsRes.json());
    setConsistency(await consistencyRes.json());
  }, []);

  useEffect(() => {
    fetch('/api/health')
      .then((r) => r.json())
      .then(() => setBackendStatus('Backend connected'))
      .catch(() => setBackendStatus('Backend offline'));
    refreshIncidents();
  }, [refreshIncidents]);

  useEffect(() => {
    if (selectedId) refreshSelected(selectedId);
  }, [selectedId, refreshSelected]);

  async function runAction(label: string, fn: () => Promise<Response>) {
    setBusy(label);
    setError(null);
    try {
      const res = await fn();
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? `${label} failed`);
      return body;
    } catch (err: any) {
      setError(err.message ?? String(err));
      return null;
    } finally {
      setBusy(null);
    }
  }

  async function handleSimulate() {
    const incident = await runAction('simulate', () => fetch('/api/incidents/simulate', { method: 'POST' }));
    if (incident) {
      await refreshIncidents();
      setSelectedId(incident.incident_id);
    }
  }

  async function handleDiagnose() {
    if (!selectedId) return;
    const body = await runAction('diagnose', () =>
      fetch(`/api/incidents/${selectedId}/diagnose`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ agent_count: 8, reconcile: true }),
      })
    );
    if (body) {
      setDiagnosisSummary(body.summary);
      await Promise.all([refreshIncidents(), refreshSelected(selectedId)]);
    }
  }

  async function handleRemediate() {
    if (!selectedId) return;
    const body = await runAction('remediate', () =>
      fetch(`/api/incidents/${selectedId}/remediate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ agent_count: 8 }),
      })
    );
    if (body) {
      setRemediationSummary(body.summary);
      setConsistency(body.consistency);
      await Promise.all([refreshIncidents(), refreshSelected(selectedId)]);
    }
  }

  const selected = incidents.find((i) => i.incident_id === selectedId) ?? null;

  return (
    <div style={{ fontFamily: 'monospace', padding: '1.5rem', maxWidth: 1100, margin: '0 auto' }}>
      <h1 style={{ marginBottom: 0 }}>AgentGuard</h1>
      <p style={{ marginTop: 4, color: '#888' }}>
        Concurrency-Safe, Shared-Memory Incident Response — {backendStatus}
      </p>

      {error && (
        <div style={{ background: '#3a1a1a', border: '1px solid #a33', color: '#f88', padding: '0.5rem 1rem', borderRadius: 6, marginBottom: 12 }}>
          {error}
        </div>
      )}

      <div style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
        <button onClick={handleSimulate} disabled={busy !== null}>
          {busy === 'simulate' ? 'Simulating…' : '+ Simulate incident'}
        </button>
        <button onClick={refreshIncidents} disabled={busy !== null}>Refresh</button>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1.4fr', gap: 20 }}>
        <div>
          <h3>Incidents</h3>
          <div style={{ maxHeight: 420, overflowY: 'auto', border: '1px solid #333', borderRadius: 6 }}>
            {incidents.map((i) => (
              <div
                key={i.incident_id}
                onClick={() => setSelectedId(i.incident_id)}
                style={{
                  padding: '8px 10px',
                  cursor: 'pointer',
                  borderBottom: '1px solid #222',
                  background: i.incident_id === selectedId ? '#1a2a3a' : 'transparent',
                }}
              >
                <div style={{ fontSize: 13 }}>{i.namespace}/{i.pod_name}</div>
                <div style={{ fontSize: 11, color: '#888' }}>
                  {i.incident_id.substring(0, 8)} · <StatusPill status={i.status} />
                </div>
              </div>
            ))}
            {incidents.length === 0 && <div style={{ padding: 10, color: '#888' }}>No incidents yet — simulate one.</div>}
          </div>
        </div>

        <div>
          <h3>Selected incident</h3>
          {!selected && <p style={{ color: '#888' }}>Pick an incident on the left.</p>}
          {selected && (
            <div>
              <div style={{ marginBottom: 10 }}>
                <strong>{selected.namespace}/{selected.pod_name}</strong>{' '}
                <StatusPill status={selected.status} />
              </div>

              <div style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
                <button onClick={handleDiagnose} disabled={busy !== null}>
                  {busy === 'diagnose' ? 'Diagnosing…' : 'Run concurrent diagnosis (8 agents)'}
                </button>
                <button onClick={handleRemediate} disabled={busy !== null || selected.status !== 'DIAGNOSED'}>
                  {busy === 'remediate' ? 'Remediating…' : 'Run concurrent remediation (8 agents)'}
                </button>
              </div>

              {diagnosisSummary && (
                <div style={{ marginBottom: 12, fontSize: 13 }}>
                  <div style={{ color: '#3b82f6' }}>Diagnosis reconciliation</div>
                  proposed={diagnosisSummary.proposed} confirmed={diagnosisSummary.confirmed} superseded={diagnosisSummary.superseded}
                  {diagnosisSummary.confirmedRootCause && <div>Root cause: {diagnosisSummary.confirmedRootCause}</div>}
                </div>
              )}

              {remediationSummary && (
                <div style={{ marginBottom: 12, fontSize: 13 }}>
                  <div style={{ color: '#22c55e' }}>Remediation race</div>
                  committed={remediationSummary.committed} rejected={remediationSummary.rejected} budget-retries={remediationSummary.retriedActions}
                  {remediationSummary.committedAction && (
                    <div>Action: {remediationSummary.committedAction} (${remediationSummary.committedCost})</div>
                  )}
                </div>
              )}

              {consistency && (
                <div style={{ marginBottom: 12, fontSize: 13, color: consistency.ok ? '#22c55e' : '#f88' }}>
                  Consistency check: {consistency.ok ? 'PASS' : 'FAIL'}
                  {consistency.issues.map((iss, idx) => (
                    <div key={idx} style={{ color: iss.severity === 'ERROR' ? '#f88' : '#e6a700' }}>
                      [{iss.severity}] {iss.message}
                    </div>
                  ))}
                </div>
              )}

              <h4>Diagnoses</h4>
              <table style={{ width: '100%', fontSize: 12, borderCollapse: 'collapse' }}>
                <tbody>
                  {diagnoses.map((d) => (
                    <tr key={d.diagnosis_id} style={{ borderBottom: '1px solid #222' }}>
                      <td style={{ padding: 4 }}>{d.agent_id}</td>
                      <td style={{ padding: 4 }}>{d.root_cause}</td>
                      <td style={{ padding: 4 }}>{d.status}</td>
                    </tr>
                  ))}
                  {diagnoses.length === 0 && <tr><td style={{ color: '#888', padding: 4 }}>None yet</td></tr>}
                </tbody>
              </table>

              <h4>Agent actions (audit log)</h4>
              <table style={{ width: '100%', fontSize: 12, borderCollapse: 'collapse' }}>
                <tbody>
                  {actions.map((a) => (
                    <tr key={a.action_id} style={{ borderBottom: '1px solid #222' }}>
                      <td style={{ padding: 4 }}>{a.agent_id}</td>
                      <td style={{ padding: 4 }}>{a.action}</td>
                      <td style={{ padding: 4 }}>{a.outcome}</td>
                    </tr>
                  ))}
                  {actions.length === 0 && <tr><td style={{ color: '#888', padding: 4 }}>None yet</td></tr>}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export default App;
