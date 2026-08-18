import { useEffect, useState, useCallback } from 'react';
import type { Session } from '@supabase/supabase-js';
import { supabase } from './supabase';
import Auth from './Auth';

/* ── theme tokens ───────────────────────────────────────────── */
const C = {
  bg:      '#0d1117',
  surface: '#161b22',
  border:  '#30363d',
  text:    '#e6edf3',
  muted:   '#8b949e',
  blue:    '#58a6ff',
  green:   '#3fb950',
  yellow:  '#d29922',
  orange:  '#f0883e',
  red:     '#f85149',
};

const statusMeta: Record<string, { color: string; label: string }> = {
  DETECTED:    { color: C.muted,   label: 'DETECTED' },
  DIAGNOSING:  { color: C.yellow,  label: 'DIAGNOSING' },
  DIAGNOSED:   { color: C.blue,    label: 'DIAGNOSED' },
  REMEDIATING: { color: C.orange,  label: 'REMEDIATING' },
  RESOLVED:    { color: C.green,   label: 'RESOLVED' },
};

const outcomeMeta: Record<string, string> = {
  COMMITTED:  C.green,
  REJECTED:   C.red,
  RETRIED:    C.yellow,
  SUPERSEDED: C.muted,
};

/* ── shared types ───────────────────────────────────────────── */
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

interface DiagnosisAgentResult {
  agentId: string;
  rootCause: string;
  confidence: number;
  status: 'CONFIRMED' | 'SUPERSEDED' | 'PROPOSED';
}

interface RemediationAgentResult {
  agentId: string;
  outcome: 'COMMITTED' | 'REJECTED' | 'RETRIED';
  reason: string;
  action: string | null;
  cost: number | null;
  retries: number;
}

/* inject keyframes once at module level */
if (typeof document !== 'undefined') {
  const s = document.createElement('style');
  s.textContent = `
    @keyframes ag-pulse  { 0%,100%{opacity:.35} 50%{opacity:.9} }
    @keyframes ag-pop    { 0%{transform:scale(.86);opacity:0} 100%{transform:scale(1);opacity:1} }
    @keyframes ag-glow   { 0%,100%{box-shadow:0 0 6px #3fb95066} 50%{box-shadow:0 0 22px #3fb950,0 0 40px #3fb95033} }
    @keyframes ag-live   { 0%,100%{opacity:1} 50%{opacity:.25} }
    @keyframes ag-slide  { from{opacity:0;transform:translateY(6px)} to{opacity:1;transform:translateY(0)} }
    @keyframes ag-border { 0%,100%{border-color:#30363d} 50%{border-color:#58a6ff55} }
    .ag-pulse  { animation: ag-pulse  1.1s ease-in-out infinite; }
    .ag-pop    { animation: ag-pop    0.2s ease-out forwards; }
    .ag-glow   { animation: ag-glow   1.6s ease-in-out infinite; }
    .ag-live   { animation: ag-live   0.9s ease-in-out infinite; }
    .ag-slide  { animation: ag-slide  0.3s ease-out forwards; }
    .ag-border { animation: ag-border 2s   ease-in-out infinite; }
  `;
  document.head.appendChild(s);
}

/* ── small components ───────────────────────────────────────── */
function Pill({ label, color }: { label: string; color: string }) {
  return (
    <span style={{
      display: 'inline-block',
      fontSize: 11, fontWeight: 600, letterSpacing: '0.05em',
      color, border: `1px solid ${color}`,
      borderRadius: 4, padding: '1px 7px',
    }}>{label}</span>
  );
}

function Card({ children, style }: { children: React.ReactNode; style?: React.CSSProperties }) {
  return (
    <div style={{
      background: C.surface, border: `1px solid ${C.border}`,
      borderRadius: 8, padding: '1rem',
      ...style,
    }}>{children}</div>
  );
}

function StatBox({ value, label, color }: { value: number | string; label: string; color: string }) {
  return (
    <div style={{ textAlign: 'center', flex: 1 }}>
      <div style={{ fontSize: 32, fontWeight: 700, color, lineHeight: 1 }}>{value}</div>
      <div style={{ fontSize: 11, color: C.muted, marginTop: 4, textTransform: 'uppercase', letterSpacing: '0.07em' }}>{label}</div>
    </div>
  );
}

function Btn({
  onClick, disabled, children, variant = 'default',
}: {
  onClick: () => void; disabled?: boolean; children: React.ReactNode; variant?: 'default' | 'primary' | 'danger';
}) {
  const bg = variant === 'primary' ? C.blue : variant === 'danger' ? C.red : C.surface;
  const fg = variant === 'default' ? C.text : '#0d1117';
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      style={{
        background: disabled ? C.border : bg,
        color: disabled ? C.muted : fg,
        border: `1px solid ${disabled ? C.border : variant === 'default' ? C.border : bg}`,
        borderRadius: 6, padding: '6px 14px', fontSize: 13, fontWeight: 600,
        cursor: disabled ? 'not-allowed' : 'pointer', transition: 'opacity 0.15s',
        fontFamily: 'inherit',
      }}
    >{children}</button>
  );
}

/* ── workflow stepper ───────────────────────────────────────── */
const WORKFLOW_STEPS = [
  { key: 'DETECTED',    label: 'Detected'    },
  { key: 'DIAGNOSING',  label: 'Diagnosing'  },
  { key: 'DIAGNOSED',   label: 'Diagnosed'   },
  { key: 'REMEDIATING', label: 'Remediating' },
  { key: 'RESOLVED',    label: 'Resolved'    },
];

const STEP_GUIDE: Record<string, { heading: string; body: string }> = {
  DETECTED: {
    heading: 'Pod failure detected — awaiting investigation.',
    body: 'Click "Run Concurrent Diagnosis" below. 8 AI agents will launch in parallel, each searching shared vector memory for similar past incidents and proposing a root cause. A CockroachDB transaction will reconcile them into one confirmed answer.',
  },
  DIAGNOSING: {
    heading: 'Diagnosis running...',
    body: 'Agents are investigating in parallel. Watch the race cards below to see each agent\'s result as they come in.',
  },
  DIAGNOSED: {
    heading: 'Root cause confirmed. Ready to fix.',
    body: 'Click "Run Concurrent Remediation" below. 8 agents will simultaneously attempt to claim the fix. CockroachDB\'s atomic UPDATE ensures exactly one commits — no duplicate restarts, no double-spent budget.',
  },
  REMEDIATING: {
    heading: 'Remediation running...',
    body: 'Agents are racing to claim and execute the fix. Only one will win.',
  },
  RESOLVED: {
    heading: 'Incident resolved.',
    body: 'One agent committed the fix and the budget was deducted. The other 7 agents were rejected by CockroachDB\'s serializable transaction — their actions never committed. Scroll down to see the full audit log.',
  },
};

function WorkflowStepper({ status }: { status: string }) {
  const currentIdx = WORKFLOW_STEPS.findIndex((s) => s.key === status);
  return (
    <div style={{ display: 'flex', alignItems: 'center', marginBottom: '1.25rem' }}>
      {WORKFLOW_STEPS.map((step, i) => {
        const done   = i < currentIdx;
        const active = i === currentIdx;
        return (
          <div key={step.key} style={{ display: 'flex', alignItems: 'center', flex: i < WORKFLOW_STEPS.length - 1 ? 1 : 'none' }}>
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
              <div
                style={{
                width: 30, height: 30, borderRadius: '50%', flexShrink: 0,
                background: done ? C.green : active ? C.blue : C.surface,
                border: `2px solid ${done ? C.green : active ? C.blue : C.border}`,
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                fontWeight: 800, fontSize: 11,
                color: done || active ? '#0d1117' : C.muted,
              }}>
                {done ? '✓' : i + 1}
              </div>
              <div style={{
                fontSize: 10, marginTop: 5, fontWeight: active ? 700 : 400,
                color: done ? C.green : active ? C.text : C.muted,
                whiteSpace: 'nowrap',
              }}>{step.label}</div>
            </div>
            {i < WORKFLOW_STEPS.length - 1 && (
              <div style={{
                flex: 1, height: 2, marginBottom: 16,
                background: done ? C.green : C.border,
                margin: '0 6px 16px',
              }} />
            )}
          </div>
        );
      })}
    </div>
  );
}

/* ── agent race visualiser ──────────────────────────────────── */
const DIAG_SCAN_MSGS = [
  'Querying pod logs...',
  'Searching vector memory...',
  'Analyzing failure pattern...',
  'Correlating node metrics...',
  'Checking deploy history...',
  'Proposing root cause...',
  'Validating hypothesis...',
  'Estimating confidence...',
];
const REM_SCAN_MSGS = [
  'Checking incident status...',
  'Evaluating fix options...',
  'Verifying budget...',
  'Claiming remediation slot...',
  'Preparing restart command...',
  'Executing fix...',
  'Confirming completion...',
  'Logging to audit...',
];

function AgentRace({
  mode, agentCount, busy, diagResults, remResults, resolved,
}: {
  mode: 'diagnosis' | 'remediation';
  agentCount: number;
  busy: boolean;
  diagResults: DiagnosisAgentResult[] | null;
  remResults: RemediationAgentResult[] | null;
  resolved: boolean;
}) {
  const results = mode === 'diagnosis' ? diagResults : remResults;
  const [revealed, setRevealed] = useState(0);
  const [cycleIdx, setCycleIdx] = useState(0);

  useEffect(() => {
    if (!busy) { setCycleIdx(0); return; }
    const id = setInterval(() => setCycleIdx((n) => n + 1), 650);
    return () => clearInterval(id);
  }, [busy]);

  useEffect(() => {
    if (!results?.length) { setRevealed(0); return; }
    setRevealed(0);
    let n = 0;
    const id = setInterval(() => {
      n += 1;
      setRevealed(n);
      if (n >= results.length) clearInterval(id);
    }, 150);
    return () => clearInterval(id);
  }, [results]);

  const isDiag = mode === 'diagnosis';
  const MSGS = isDiag ? DIAG_SCAN_MSGS : REM_SCAN_MSGS;
  const accentColor = isDiag ? C.blue : C.orange;

  function getState(i: number) {
    if (!results || i >= revealed) return busy ? 'scanning' : 'idle';
    if (isDiag) return (results[i] as DiagnosisAgentResult).status === 'CONFIRMED' ? 'confirmed' : 'superseded';
    return (results[i] as RemediationAgentResult).outcome === 'COMMITTED' ? 'committed' : 'rejected';
  }

  const isWinner = (state: string) => state === 'confirmed' || state === 'committed';

  const confirmedCount = !results ? 0 :
    isDiag ? (results as DiagnosisAgentResult[]).filter((r) => r.status === 'CONFIRMED').length
           : (results as RemediationAgentResult[]).filter((r) => r.outcome === 'COMMITTED').length;
  const loserCount = results ? results.length - confirmedCount : 0;
  const loserLabel = isDiag ? 'superseded' : 'rejected';

  return (
    <Card style={{ marginBottom: '1rem', position: 'relative', overflow: 'hidden' }}>
      {/* subtle accent line at top */}
      <div style={{ position: 'absolute', top: 0, left: 0, right: 0, height: 2, background: `linear-gradient(90deg, ${accentColor}88, transparent)` }} />

      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: '1rem' }}>
        <div style={{ fontWeight: 800, fontSize: 13, color: accentColor, letterSpacing: '0.02em' }}>
          {isDiag ? 'Diagnosis Race' : 'Remediation Race'}
        </div>
        <div style={{ fontSize: 11, color: C.muted }}>{agentCount} agents · parallel</div>

        {/* LIVE badge */}
        {busy && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 5, marginLeft: 4 }}>
            <div className="ag-live" style={{ width: 6, height: 6, borderRadius: '50%', background: C.red }} />
            <span style={{ fontSize: 10, fontWeight: 700, color: C.red, letterSpacing: '0.1em' }}>LIVE</span>
          </div>
        )}

        {/* final tally after reveal */}
        {results && revealed >= results.length && (
          <div className="ag-slide" style={{ marginLeft: 'auto', fontSize: 12, color: accentColor, fontWeight: 700 }}>
            {confirmedCount} committed &middot; <span style={{ color: C.muted, fontWeight: 400 }}>{loserCount} {loserLabel}</span>
          </div>
        )}

        {/* in-progress reveal counter */}
        {results && revealed < results.length && (
          <div style={{ marginLeft: 'auto', fontSize: 11, color: C.muted }}>
            revealing {revealed}/{results.length}...
          </div>
        )}
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 8 }}>
        {Array.from({ length: agentCount }, (_, i) => {
          const state = getState(i);
          const scanning = state === 'scanning';
          const winner = isWinner(state);
          const isRevealed = !!(results && i < revealed);
          const r = results?.[i];
          const msg = MSGS[(i * 3 + cycleIdx) % MSGS.length];

          return (
            <div
              key={i}
              className={scanning ? 'ag-pulse' : isRevealed ? 'ag-pop' : ''}
              style={{
                borderRadius: 10,
                border: `1px solid ${winner ? C.green : state === 'rejected' ? '#3d1010' : C.border}`,
                background: winner ? '#0a1f0d' : state === 'rejected' ? '#140909' : C.surface,
                padding: '12px 14px',
                transition: 'border-color 0.3s, background 0.4s',
                position: 'relative',
              }}
            >
              {/* agent id */}
              <div style={{
                fontSize: 9, fontFamily: 'monospace', fontWeight: 700,
                color: winner ? C.green : C.muted,
                marginBottom: 6, letterSpacing: '0.06em', textTransform: 'uppercase',
              }}>
                {isDiag ? `diag-agent-${i + 1}` : `remed-agent-${i + 1}`}
              </div>

              {/* state label */}
              {scanning && (
                <div className="ag-pulse" style={{ fontSize: 11, color: C.muted, lineHeight: 1.5 }}>
                  {msg}
                </div>
              )}
              {!scanning && (
                <div style={{
                  fontSize: winner ? 13 : 11,
                  fontWeight: winner ? 800 : 600,
                  color: winner ? C.green : state === 'rejected' ? C.red : C.muted,
                  letterSpacing: winner ? '0.04em' : 0,
                }}>
                  {state === 'idle' ? '—'
                    : state === 'confirmed' ? 'CONFIRMED'
                    : state === 'committed' ? 'COMMITTED'
                    : state === 'superseded' ? 'SUPERSEDED'
                    : state === 'rejected' ? 'REJECTED'
                    : state}
                </div>
              )}

              {/* sub-detail */}
              {isRevealed && r && isDiag && (r as DiagnosisAgentResult).confidence && (
                <div style={{ fontSize: 10, color: C.muted, marginTop: 4 }}>
                  confidence {(r as DiagnosisAgentResult).confidence}
                </div>
              )}
              {isRevealed && r && !isDiag && (r as RemediationAgentResult).action && (
                <div style={{ fontSize: 10, color: C.muted, marginTop: 4 }}>
                  action: {(r as RemediationAgentResult).action}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </Card>
  );
}

/* ── landing page ───────────────────────────────────────────── */
function LandingPage({ onEnter, session, onSignIn }: { onEnter: () => void; session: Session | null; onSignIn: () => void }) {
  const features = [
    {
      abbr: 'SM',
      title: 'Shared Agent Memory',
      color: C.blue,
      desc: 'Every diagnosis agent writes to one CockroachDB cluster. No siloed guesses — agents see what others have already found.',
    },
    {
      abbr: 'DR',
      title: 'Diagnosis Reconciliation',
      color: C.green,
      desc: '8 agents investigate the same pod in parallel. A single CockroachDB transaction ensures only 1 root cause is ever confirmed — the rest are automatically superseded.',
    },
    {
      abbr: 'RR',
      title: 'Remediation Race',
      color: C.orange,
      desc: '8 remediation agents race to claim the fix. Serializable transactions guarantee exactly 1 commits — no duplicate restarts, no double-spent budget.',
    },
  ];

  const stack = [
    { label: 'CockroachDB', sub: 'Distributed SQL + Vector' },
    { label: 'LangGraph', sub: 'Concurrent agent graphs' },
    { label: 'Gemini', sub: 'Embeddings (3072-dim)' },
    { label: 'AWS', sub: 'Cloud deployment' },
  ];

  /* subtle animated gradient orb */
  const orbStyle = (color: string, top: string, left: string, size: number): React.CSSProperties => ({
    position: 'absolute', top, left,
    width: size, height: size, borderRadius: '50%',
    background: color, filter: 'blur(120px)', opacity: 0.12,
    pointerEvents: 'none',
  });

  return (
    <div style={{
      minHeight: '100vh', background: C.bg, color: C.text,
      fontFamily: "'Segoe UI', system-ui, sans-serif",
      overflowX: 'hidden', position: 'relative',
    }}>
      {/* background orbs */}
      <div style={orbStyle(C.blue,   '-5%',  '-5%',  600)} />
      <div style={orbStyle(C.green,  '40%',  '70%',  500)} />
      <div style={orbStyle(C.orange, '70%',  '10%',  400)} />

      {/* nav */}
      <nav style={{
        position: 'sticky', top: 0, zIndex: 10,
        background: 'rgba(13,17,23,0.85)', backdropFilter: 'blur(16px)',
        borderBottom: `1px solid ${C.border}`,
        padding: '1.1rem 3rem', display: 'flex', alignItems: 'center', gap: 36,
      }}>
        <span style={{ fontWeight: 900, fontSize: 22, letterSpacing: '-0.03em' }}>AgentGuard</span>
        <div style={{ display: 'flex', gap: 24, marginLeft: 12 }}>
          {['Platform', 'Architecture', 'Memory'].map((l) => (
            <span key={l} style={{ fontSize: 14, color: C.muted, cursor: 'default' }}>{l}</span>
          ))}
        </div>
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 12, alignItems: 'center' }}>
          <a href="https://github.com/Joshnaacsha/Agent-Guard" target="_blank" rel="noreferrer"
            style={{ fontSize: 13, color: C.muted, textDecoration: 'none' }}>GitHub</a>
          {session ? (
            <>
              <span style={{ fontSize: 13, color: C.muted, maxWidth: 180, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {session.user.email}
              </span>
              <button
                onClick={() => supabase.auth.signOut()}
                style={{ background: 'none', border: `1px solid ${C.border}`, borderRadius: 6, color: C.muted, cursor: 'pointer', fontSize: 12, padding: '5px 12px', fontFamily: 'inherit' }}
              >Sign out</button>
              <button
                onClick={onEnter}
                style={{ background: C.blue, color: '#0d1117', border: 'none', borderRadius: 8, padding: '8px 22px', fontWeight: 700, fontSize: 14, cursor: 'pointer', fontFamily: 'inherit' }}
              >Open Console</button>
            </>
          ) : (
            <button
              onClick={onSignIn}
              style={{ background: C.blue, color: '#0d1117', border: 'none', borderRadius: 8, padding: '8px 22px', fontWeight: 700, fontSize: 14, cursor: 'pointer', fontFamily: 'inherit' }}
            >Sign In</button>
          )}
        </div>
      </nav>

      {/* hero */}
      <div style={{ textAlign: 'center', padding: '7rem 2rem 4rem', position: 'relative' }}>
        <h1 style={{
          fontSize: 'clamp(2.5rem, 6vw, 4.5rem)', fontWeight: 900,
          lineHeight: 1.1, marginBottom: '1.5rem', letterSpacing: '-0.03em',
        }}>
          Siloed agents guess in parallel.<br />
          <span style={{ color: C.blue }}>AgentGuard</span>'s agents{' '}
          <span style={{
            background: `linear-gradient(135deg, ${C.green}, ${C.blue})`,
            WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent',
          }}>remember together.</span>
        </h1>

        <p style={{
          fontSize: 18, color: C.muted, maxWidth: 640,
          margin: '0 auto 2.5rem', lineHeight: 1.7,
        }}>
          A Kubernetes incident response system where multiple AI agents concurrently diagnose
          pod failures and execute remediations — sharing one transactional memory backed by CockroachDB.
        </p>

        <div style={{ display: 'flex', gap: 12, justifyContent: 'center', flexWrap: 'wrap' }}>
          {session ? (
            <button
              onClick={onEnter}
              style={{ background: C.blue, color: '#0d1117', border: 'none', borderRadius: 10, padding: '14px 32px', fontWeight: 800, fontSize: 16, cursor: 'pointer', fontFamily: 'inherit' }}
            >Launch Dashboard →</button>
          ) : (
            <button
              onClick={onSignIn}
              style={{ background: C.blue, color: '#0d1117', border: 'none', borderRadius: 10, padding: '14px 32px', fontWeight: 800, fontSize: 16, cursor: 'pointer', fontFamily: 'inherit' }}
            >Sign In →</button>
          )}
          <a href="https://github.com/Joshnaacsha/Agent-Guard" target="_blank" rel="noreferrer"
            style={{ background: 'transparent', color: C.text, border: `1px solid ${C.border}`, borderRadius: 10, padding: '14px 32px', fontWeight: 600, fontSize: 16, textDecoration: 'none', display: 'inline-block' }}
          >GitHub ↗</a>
        </div>
      </div>

      {/* stats bar */}
      <div style={{
        display: 'flex', justifyContent: 'center', gap: 0,
        borderTop: `1px solid ${C.border}`, borderBottom: `1px solid ${C.border}`,
        margin: '0 0 5rem',
      }}>
        {[
          { n: '8', label: 'Agents in parallel' },
          { n: '1', label: 'Root cause confirmed' },
          { n: '0', label: 'Duplicate remediations' },
          { n: '40001', label: 'SQLSTATE retried automatically' },
        ].map((s, i) => (
          <div key={i} style={{
            flex: 1, textAlign: 'center', padding: '1.5rem 1rem',
            borderRight: i < 3 ? `1px solid ${C.border}` : 'none',
          }}>
            <div style={{ fontSize: 28, fontWeight: 800, color: C.blue, fontVariantNumeric: 'tabular-nums' }}>{s.n}</div>
            <div style={{ fontSize: 12, color: C.muted, marginTop: 4 }}>{s.label}</div>
          </div>
        ))}
      </div>

      {/* feature cards */}
      <div style={{ padding: '0 2rem 5rem', maxWidth: 1100, margin: '0 auto' }}>
        <h2 style={{ textAlign: 'center', fontWeight: 800, fontSize: 28, marginBottom: '0.75rem' }}>
          Two real concurrency mechanics, both proven
        </h2>
        <p style={{ textAlign: 'center', color: C.muted, marginBottom: '2.5rem', fontSize: 15 }}>
          Removing CockroachDB's guarantees would visibly break this application.
        </p>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: 20 }}>
          {features.map((f) => (
            <div key={f.title} style={{
              background: C.surface, border: `1px solid ${C.border}`,
              borderRadius: 12, padding: '1.75rem',
              borderTop: `3px solid ${f.color}`,
            }}>
              <div style={{
                display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                width: 40, height: 40, borderRadius: 8,
                background: `${f.color}18`, border: `1px solid ${f.color}44`,
                fontSize: 13, fontWeight: 800, color: f.color, marginBottom: '0.9rem',
                letterSpacing: '0.04em',
              }}>{f.abbr}</div>
              <div style={{ fontWeight: 700, fontSize: 16, marginBottom: '0.6rem', color: f.color }}>{f.title}</div>
              <div style={{ color: C.muted, fontSize: 14, lineHeight: 1.65 }}>{f.desc}</div>
            </div>
          ))}
        </div>
      </div>

      {/* how it works */}
      <div style={{
        background: C.surface, borderTop: `1px solid ${C.border}`, borderBottom: `1px solid ${C.border}`,
        padding: '4rem 2rem', marginBottom: '5rem',
      }}>
        <div style={{ maxWidth: 900, margin: '0 auto' }}>
          <h2 style={{ textAlign: 'center', fontWeight: 800, fontSize: 26, marginBottom: '2.5rem' }}>
            How it works
          </h2>
          <div style={{ display: 'flex', gap: 0, alignItems: 'flex-start', flexWrap: 'wrap' }}>
            {[
              { step: '1', title: 'Pod fails', desc: 'Simulator fires a Kubernetes pod failure event (CrashLoopBackOff, OOMKilled, ImagePullBackOff…) into the incidents table.' },
              { step: '2', title: '8 agents diagnose', desc: 'LangGraph fans out 8 concurrent agents. Each searches vector memory for similar past incidents and proposes a root cause.' },
              { step: '3', title: 'Reconcile', desc: 'A CockroachDB transaction picks the first confirmed diagnosis and marks the remaining 7 as SUPERSEDED — one truth, atomically.' },
              { step: '4', title: '8 agents remediate', desc: 'Remediation agents race to claim the fix. The atomic UPDATE ensures exactly 1 commits. Budget is deducted under serializable isolation.' },
            ].map((s, i, arr) => (
              <div key={i} style={{ flex: 1, minWidth: 180, display: 'flex', alignItems: 'flex-start', gap: 0 }}>
                <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', flex: 1 }}>
                  <div style={{
                    width: 40, height: 40, borderRadius: '50%',
                    background: C.blue, color: '#0d1117',
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    fontWeight: 800, fontSize: 16, flexShrink: 0,
                  }}>{s.step}</div>
                  {i < arr.length - 1 && (
                    <div style={{ width: '100%', height: 2, background: C.border, marginTop: 19, marginBottom: 0 }} />
                  )}
                </div>
                <div style={{ padding: '0 1rem 0 0.75rem', marginTop: 4 }}>
                  <div style={{ fontWeight: 700, fontSize: 14, marginBottom: 6 }}>{s.title}</div>
                  <div style={{ fontSize: 12, color: C.muted, lineHeight: 1.6 }}>{s.desc}</div>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* tech stack */}
      <div style={{ textAlign: 'center', padding: '0 2rem 6rem', maxWidth: 900, margin: '0 auto' }}>
        <h2 style={{ fontWeight: 800, fontSize: 22, marginBottom: '2rem' }}>Built on</h2>
        <div style={{ display: 'flex', gap: 16, justifyContent: 'center', flexWrap: 'wrap' }}>
          {stack.map((t) => (
            <div key={t.label} style={{
              background: C.surface, border: `1px solid ${C.border}`,
              borderRadius: 10, padding: '1rem 1.5rem', minWidth: 140, textAlign: 'center',
            }}>
              <div style={{ fontWeight: 700, fontSize: 15 }}>{t.label}</div>
              <div style={{ fontSize: 11, color: C.muted, marginTop: 4 }}>{t.sub}</div>
            </div>
          ))}
        </div>
      </div>

      {/* footer CTA */}
      <div style={{
        background: C.surface, borderTop: `1px solid ${C.border}`,
        textAlign: 'center', padding: '4rem 2rem',
      }}>
        <h2 style={{ fontWeight: 800, fontSize: 24, marginBottom: '1rem' }}>Start an investigation</h2>
        <p style={{ color: C.muted, marginBottom: '2rem', fontSize: 15 }}>
          Simulate a pod failure, watch 8 agents diagnose it concurrently, see reconciliation happen live.
        </p>
        {session ? (
          <button
            onClick={onEnter}
            style={{ background: C.blue, color: '#0d1117', border: 'none', borderRadius: 10, padding: '14px 36px', fontWeight: 800, fontSize: 16, cursor: 'pointer', fontFamily: 'inherit' }}
          >Open Console</button>
        ) : (
          <button
            onClick={onSignIn}
            style={{ background: C.blue, color: '#0d1117', border: 'none', borderRadius: 10, padding: '14px 36px', fontWeight: 800, fontSize: 16, cursor: 'pointer', fontFamily: 'inherit' }}
          >Sign In</button>
        )}
      </div>
    </div>
  );
}

/* ── main app ───────────────────────────────────────────────── */
function App() {
  const [session, setSession]         = useState<Session | null>(null);
  const [authLoading, setAuthLoading] = useState(true);
  const [showLanding, setShowLanding] = useState(true);
  const [showAuth, setShowAuth]       = useState(false);
  const [backendOk, setBackendOk]     = useState(false);
  const [incidents, setIncidents] = useState<Incident[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [diagnoses, setDiagnoses] = useState<Diagnosis[]>([]);
  const [actions, setActions] = useState<AgentAction[]>([]);
  const [diagnosisSummary, setDiagnosisSummary] = useState<DiagnosisSummary | null>(null);
  const [remediationSummary, setRemediationSummary] = useState<RemediationSummary | null>(null);
  const [diagnosisAgentResults, setDiagnosisAgentResults] = useState<DiagnosisAgentResult[] | null>(null);
  const [remediationAgentResults, setRemediationAgentResults] = useState<RemediationAgentResult[] | null>(null);
  const [consistency, setConsistency] = useState<ConsistencyReport | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session);
      if (data.session) setShowLanding(false); // restore dashboard on page refresh
      setAuthLoading(false);
    });
    const { data: { subscription } } = supabase.auth.onAuthStateChange((event, s) => {
      setSession(s);
      if (event === 'SIGNED_IN')  { setShowAuth(false); setShowLanding(false); }
      if (event === 'SIGNED_OUT') { setShowAuth(false); setShowLanding(true);  }
    });
    return () => subscription.unsubscribe();
  }, []);

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
      .then(() => setBackendOk(true))
      .catch(() => setBackendOk(false));
    refreshIncidents();
  }, [refreshIncidents]);

  useEffect(() => {
    if (selectedId) {
      setDiagnosisSummary(null);
      setRemediationSummary(null);
      setDiagnosisAgentResults(null);
      setRemediationAgentResults(null);
      setError(null);
      refreshSelected(selectedId);
    }
  }, [selectedId, refreshSelected]);

  async function runAction(label: string, fn: () => Promise<Response>) {
    setBusy(label); setError(null);
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
    const incident = await runAction('simulate', () =>
      fetch('/api/incidents/simulate', { method: 'POST' })
    );
    if (incident) { await refreshIncidents(); setSelectedId(incident.incident_id); }
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
      setDiagnosisAgentResults(body.results ?? null);
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
      setRemediationAgentResults(body.results ?? null);
      setConsistency(body.consistency);
      await Promise.all([refreshIncidents(), refreshSelected(selectedId)]);
    }
  }

  const selected = incidents.find((i) => i.incident_id === selectedId) ?? null;
  const sm = statusMeta[selected?.status ?? ''] ?? { color: C.muted, label: selected?.status ?? '' };

  if (authLoading) return (
    <div style={{ minHeight: '100vh', background: '#0d1117', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#8b949e', fontSize: 13 }}>
      Loading…
    </div>
  );
  if (!session && showAuth) return <Auth onBack={() => setShowAuth(false)} />;
  if (showLanding) return <LandingPage onEnter={() => setShowLanding(false)} session={session} onSignIn={() => setShowAuth(true)} />;
  if (!session)    return <LandingPage onEnter={() => setShowLanding(false)} session={null}    onSignIn={() => setShowAuth(true)} />;

  return (
    <div style={{
      minHeight: '100vh', background: C.bg, color: C.text,
      fontFamily: "'Segoe UI', system-ui, sans-serif", fontSize: 14,
    }}>
      {/* header */}
      <div style={{
        background: C.surface, borderBottom: `1px solid ${C.border}`,
        padding: '0 2rem', height: 56,
        display: 'flex', alignItems: 'center', flexShrink: 0,
      }}>
        {/* logo mark */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginRight: 28 }}>
          <div style={{
            width: 30, height: 30, borderRadius: 8,
            background: `linear-gradient(135deg, ${C.blue}, #1a5fa8)`,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            fontWeight: 900, fontSize: 13, color: '#fff', flexShrink: 0,
          }}>AG</div>
          <span style={{ fontWeight: 800, fontSize: 17, letterSpacing: '-0.03em' }}>AgentGuard</span>
        </div>

        <div style={{ width: 1, height: 22, background: C.border, marginRight: 20 }} />

        {/* breadcrumb */}
        <button onClick={() => setShowLanding(true)} style={{
          background: 'none', border: 'none', cursor: 'pointer',
          color: C.muted, fontSize: 13, fontFamily: 'inherit', padding: 0,
        }}>Overview</button>
        <span style={{ color: C.border, margin: '0 8px' }}>›</span>
        <span style={{ fontSize: 13, color: C.text }}>Incident Console</span>

        <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 20 }}>
          <span style={{ fontSize: 12, color: C.muted }}>
            <span style={{ color: C.text, fontWeight: 600 }}>{incidents.length}</span> incidents
          </span>
          <div style={{ width: 1, height: 16, background: C.border }} />
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <div style={{ width: 7, height: 7, borderRadius: '50%', background: backendOk ? C.green : C.red }} />
            <span style={{ fontSize: 12, color: C.muted }}>{backendOk ? 'Connected' : 'Offline'}</span>
          </div>
          <div style={{ width: 1, height: 16, background: C.border }} />
          <span style={{ fontSize: 12, color: C.muted, maxWidth: 160, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {session?.user.email}
          </span>
          <button
            onClick={() => supabase.auth.signOut()}
            style={{
              background: 'none', border: `1px solid ${C.border}`, borderRadius: 5,
              color: C.muted, cursor: 'pointer', fontSize: 12, padding: '3px 10px',
              fontFamily: 'inherit', transition: 'border-color 0.15s, color 0.15s',
            }}
          >Sign out</button>
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '300px 1fr', gap: 0, height: 'calc(100vh - 56px)' }}>

        {/* ── left sidebar: incident list ── */}
        <div style={{
          borderRight: `1px solid ${C.border}`,
          display: 'flex', flexDirection: 'column', overflow: 'hidden',
        }}>
          <div style={{ padding: '1rem', borderBottom: `1px solid ${C.border}`, display: 'flex', gap: 8 }}>
            <Btn onClick={handleSimulate} disabled={busy !== null} variant="primary">
              {busy === 'simulate' ? 'Creating…' : '+ Simulate'}
            </Btn>
            <Btn onClick={refreshIncidents} disabled={busy !== null}>Refresh</Btn>
          </div>

          <div style={{ overflowY: 'auto', flex: 1 }}>
            {incidents.length === 0 && (
              <div style={{ padding: '2rem 1rem', color: C.muted, textAlign: 'center', fontSize: 13 }}>
                No incidents yet.<br />Click Simulate to create one.
              </div>
            )}
            {incidents.map((inc) => {
              const meta = statusMeta[inc.status] ?? { color: C.muted };
              const isSelected = inc.incident_id === selectedId;
              return (
                <div
                  key={inc.incident_id}
                  onClick={() => setSelectedId(inc.incident_id)}
                  style={{
                    padding: '10px 14px', cursor: 'pointer',
                    borderBottom: `1px solid ${C.border}`,
                    background: isSelected ? '#1c2333' : 'transparent',
                    borderLeft: isSelected ? `3px solid ${C.blue}` : '3px solid transparent',
                  }}
                >
                  <div style={{ fontSize: 13, fontWeight: 500, marginBottom: 2 }}>
                    {inc.pod_name}
                  </div>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <span style={{ fontSize: 11, color: C.muted }}>{inc.namespace}</span>
                    <Pill label={inc.status} color={meta.color} />
                  </div>
                  <div style={{ fontSize: 10, color: C.muted, marginTop: 3 }}>
                    {inc.incident_id.substring(0, 8)}
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        {/* ── right panel ── */}
        <div style={{
          overflowY: 'auto', padding: '1.5rem',
          backgroundImage: 'radial-gradient(circle, #30363d28 1px, transparent 1px)',
          backgroundSize: '28px 28px',
        }}>
          {!selected && (
            <div style={{ color: C.muted, textAlign: 'center', marginTop: '6rem', fontSize: 15 }}>
              <div style={{ fontSize: 32, marginBottom: 12, opacity: 0.3 }}>&#9616;&#9612;</div>
              Select an incident from the left panel—
              <br />or click <strong style={{ color: C.text }}>+ Simulate</strong> to create one.
            </div>
          )}

          {selected && (
            <div style={{ maxWidth: 820 }}>

              {/* incident header */}
              <div style={{ marginBottom: '1.25rem' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 4 }}>
                  <span style={{ fontSize: 20, fontWeight: 700 }}>{selected.pod_name}</span>
                  <Pill label={sm.label} color={sm.color} />
                </div>
                <div style={{ color: C.muted, fontSize: 13 }}>
                  namespace: <strong style={{ color: C.text }}>{selected.namespace}</strong>
                  &nbsp;·&nbsp; id: {selected.incident_id}
                  &nbsp;·&nbsp; v{selected.version}
                </div>
              </div>

              {/* workflow progress */}
              <WorkflowStepper status={busy === 'diagnose' ? 'DIAGNOSING' : busy === 'remediate' ? 'REMEDIATING' : selected.status} />

              {/* step guidance */}
              {(() => {
                const effectiveStatus = busy === 'diagnose' ? 'DIAGNOSING' : busy === 'remediate' ? 'REMEDIATING' : selected.status;
                const guide = STEP_GUIDE[effectiveStatus];
                if (!guide) return null;
                const isActionable = effectiveStatus === 'DETECTED' || effectiveStatus === 'DIAGNOSED';
                return (
                  <div style={{
                    background: isActionable ? 'rgba(88,166,255,0.06)' : C.surface,
                    border: `1px solid ${isActionable ? 'rgba(88,166,255,0.3)' : C.border}`,
                    borderRadius: 8, padding: '0.9rem 1rem', marginBottom: '1.25rem',
                  }}>
                    <div style={{ fontWeight: 700, fontSize: 14, marginBottom: 5, color: isActionable ? C.text : C.muted }}>
                      {guide.heading}
                    </div>
                    <div style={{ fontSize: 12, color: C.muted, lineHeight: 1.65 }}>{guide.body}</div>
                  </div>
                );
              })()}

              {/* only show the button relevant to the current step */}
              {selected.status === 'DETECTED' && (
                <div style={{ marginBottom: '1.5rem' }}>
                  <Btn onClick={handleDiagnose} disabled={busy !== null} variant="primary">
                    {busy === 'diagnose' ? 'Running diagnosis...' : 'Run Concurrent Diagnosis (8 agents)'}
                  </Btn>
                </div>
              )}
              {selected.status === 'DIAGNOSED' && (
                <div style={{ marginBottom: '1.5rem' }}>
                  <Btn onClick={handleRemediate} disabled={busy !== null} variant="primary">
                    {busy === 'remediate' ? 'Running remediation...' : 'Run Concurrent Remediation (8 agents)'}
                  </Btn>
                </div>
              )}

              {error && (
                <div style={{
                  background: '#3a1212', border: `1px solid ${C.red}`,
                  color: C.red, borderRadius: 6, padding: '0.6rem 1rem', marginBottom: '1rem', fontSize: 13,
                }}>{error}</div>
              )}

              {/* diagnosis agent race — shown while busy or after results */}
              {(busy === 'diagnose' || diagnosisAgentResults) && (
                <AgentRace
                  mode="diagnosis"
                  agentCount={8}
                  busy={busy === 'diagnose'}
                  diagResults={diagnosisAgentResults}
                  remResults={null}
                  resolved={selected.status === 'RESOLVED'}
                />
              )}

              {/* confirmed root cause callout */}
              {diagnosisSummary?.confirmedRootCause && (
                <div style={{
                  marginBottom: '1rem', background: '#0c1f10', border: `1px solid ${C.green}`,
                  borderRadius: 8, padding: '0.75rem 1rem', fontSize: 13,
                }}>
                  <div style={{ fontSize: 10, fontWeight: 700, color: C.green, textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 6 }}>
                    Confirmed root cause
                  </div>
                  <div style={{ color: C.text, lineHeight: 1.6 }}>{diagnosisSummary.confirmedRootCause}</div>
                </div>
              )}

              {/* remediation agent race */}
              {(busy === 'remediate' || remediationAgentResults) && (
                <AgentRace
                  mode="remediation"
                  agentCount={8}
                  busy={busy === 'remediate'}
                  diagResults={null}
                  remResults={remediationAgentResults}
                  resolved={selected.status === 'RESOLVED'}
                />
              )}

              {/* remediation committed action */}
              {remediationSummary?.committedAction && (
                <div style={{
                  marginBottom: '1rem', background: '#0c1f10', border: `1px solid ${C.green}`,
                  borderRadius: 8, padding: '0.75rem 1rem', fontSize: 13,
                  display: 'flex', gap: 20, alignItems: 'center',
                }}>
                  <div>
                    <div style={{ fontSize: 10, fontWeight: 700, color: C.green, textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 4 }}>Action committed</div>
                    <div style={{ color: C.text }}>{remediationSummary.committedAction}</div>
                  </div>
                  <div style={{ marginLeft: 'auto', textAlign: 'right' }}>
                    <div style={{ fontSize: 10, color: C.muted, marginBottom: 2 }}>Cost</div>
                    <div style={{ fontWeight: 700, color: C.green }}>${remediationSummary.committedCost}</div>
                  </div>
                </div>
              )}

              {/* consistency check */}
              {consistency && (
                <Card style={{ marginBottom: '1rem', borderColor: consistency.ok ? C.green : C.red }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                    <div style={{
                      width: 28, height: 28, borderRadius: '50%',
                      background: consistency.ok ? C.green : C.red,
                      display: 'flex', alignItems: 'center', justifyContent: 'center',
                      fontSize: 14, color: '#0d1117', fontWeight: 700, flexShrink: 0,
                    }}>{consistency.ok ? '✓' : '✗'}</div>
                    <div>
                      <div style={{ fontWeight: 700, color: consistency.ok ? C.green : C.red }}>
                        Consistency Audit: {consistency.ok ? 'PASS' : 'FAIL'}
                      </div>
                      <div style={{ fontSize: 12, color: C.muted }}>
                        Independent audit — no duplicate commits, no contradicting diagnoses
                      </div>
                    </div>
                  </div>
                  {consistency.issues.map((iss, idx) => (
                    <div key={idx} style={{
                      marginTop: 8, fontSize: 12, padding: '4px 8px', borderRadius: 4,
                      background: iss.severity === 'ERROR' ? '#3a1212' : '#2a2010',
                      color: iss.severity === 'ERROR' ? C.red : C.yellow,
                    }}>
                      [{iss.severity}] {iss.message}
                    </div>
                  ))}
                </Card>
              )}

              {/* diagnoses table */}
              <Card style={{ marginBottom: '1rem' }}>
                <div style={{ fontWeight: 700, marginBottom: '0.75rem', fontSize: 13 }}>
                  Diagnoses written to shared memory
                </div>
                {diagnoses.length === 0 ? (
                  <div style={{ color: C.muted, fontSize: 13 }}>None yet — run concurrent diagnosis above.</div>
                ) : (
                  <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                    <thead>
                      <tr style={{ color: C.muted, textAlign: 'left', borderBottom: `1px solid ${C.border}` }}>
                        <th style={{ padding: '4px 8px', fontWeight: 600 }}>Agent</th>
                        <th style={{ padding: '4px 8px', fontWeight: 600 }}>Root cause</th>
                        <th style={{ padding: '4px 8px', fontWeight: 600 }}>Conf.</th>
                        <th style={{ padding: '4px 8px', fontWeight: 600 }}>Status</th>
                      </tr>
                    </thead>
                    <tbody>
                      {diagnoses.map((d) => {
                        const col = d.status === 'CONFIRMED' ? C.green : d.status === 'SUPERSEDED' ? C.muted : C.yellow;
                        return (
                          <tr key={d.diagnosis_id} style={{ borderBottom: `1px solid ${C.border}` }}>
                            <td style={{ padding: '6px 8px', color: C.muted }}>{d.agent_id}</td>
                            <td style={{ padding: '6px 8px', color: d.status === 'CONFIRMED' ? C.text : C.muted }}>
                              {d.root_cause}
                            </td>
                            <td style={{ padding: '6px 8px', color: C.muted }}>{d.confidence}</td>
                            <td style={{ padding: '6px 8px' }}>
                              <Pill label={d.status} color={col} />
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                )}
              </Card>

              {/* audit log */}
              <Card>
                <div style={{ fontWeight: 700, marginBottom: '0.75rem', fontSize: 13 }}>
                  Agent actions — audit log
                </div>
                {actions.length === 0 ? (
                  <div style={{ color: C.muted, fontSize: 13 }}>No actions logged yet.</div>
                ) : (
                  <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                    <thead>
                      <tr style={{ color: C.muted, textAlign: 'left', borderBottom: `1px solid ${C.border}` }}>
                        <th style={{ padding: '4px 8px', fontWeight: 600 }}>Agent</th>
                        <th style={{ padding: '4px 8px', fontWeight: 600 }}>Action</th>
                        <th style={{ padding: '4px 8px', fontWeight: 600 }}>Outcome</th>
                        <th style={{ padding: '4px 8px', fontWeight: 600 }}>Time</th>
                      </tr>
                    </thead>
                    <tbody>
                      {actions.map((a) => (
                        <tr key={a.action_id} style={{ borderBottom: `1px solid ${C.border}` }}>
                          <td style={{ padding: '6px 8px', color: C.muted }}>{a.agent_id}</td>
                          <td style={{ padding: '6px 8px' }}>{a.action}</td>
                          <td style={{ padding: '6px 8px' }}>
                            <Pill label={a.outcome} color={outcomeMeta[a.outcome] ?? C.muted} />
                          </td>
                          <td style={{ padding: '6px 8px', color: C.muted }}>
                            {new Date(a.created_at).toLocaleTimeString()}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </Card>

            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export default App;
