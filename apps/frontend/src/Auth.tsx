import { useState } from 'react';
import { supabase } from './supabase';

const C = {
  bg:      '#0d1117',
  surface: '#161b22',
  border:  '#30363d',
  text:    '#e6edf3',
  muted:   '#8b949e',
  blue:    '#58a6ff',
  green:   '#3fb950',
  red:     '#f85149',
};

export default function Auth({ onBack }: { onBack?: () => void }) {
  const [tab, setTab]           = useState<'signin' | 'signup'>('signin');
  const [email, setEmail]       = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading]   = useState(false);
  const [error, setError]       = useState<string | null>(null);
  const [sent, setSent]         = useState(false);

  function resetState() { setError(null); setSent(false); }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true); resetState();
    if (tab === 'signup') {
      const { error } = await supabase.auth.signUp({
        email, password,
        options: { emailRedirectTo: window.location.origin },
      });
      setLoading(false);
      if (error) setError(error.message);
      else setSent(true);
    } else {
      const { error } = await supabase.auth.signInWithPassword({ email, password });
      setLoading(false);
      if (error) setError(error.message);
    }
  }

  return (
    <div style={{
      display: 'grid', gridTemplateColumns: '1fr 1fr',
      minHeight: '100vh',
      fontFamily: "'Segoe UI', system-ui, sans-serif", color: C.text,
    }}>

      {/* left: branding */}
      <div style={{
        background: C.bg, padding: '3rem',
        display: 'flex', flexDirection: 'column',
        position: 'relative', overflow: 'hidden',
      }}>
        <div style={{ position: 'absolute', top: '-10%', left: '-15%', width: 600, height: 600, borderRadius: '50%', background: C.blue,   filter: 'blur(160px)', opacity: 0.07, pointerEvents: 'none' }} />
        <div style={{ position: 'absolute', bottom: '5%',  right: '-15%', width: 500, height: 500, borderRadius: '50%', background: C.green, filter: 'blur(160px)', opacity: 0.05, pointerEvents: 'none' }} />

        <div style={{ display: 'flex', alignItems: 'center', gap: 10, position: 'relative' }}>
          <div style={{ width: 36, height: 36, borderRadius: 10, background: 'linear-gradient(135deg, #58a6ff, #1a5fa8)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 900, fontSize: 15, color: '#fff' }}>AG</div>
          <span style={{ fontWeight: 800, fontSize: 20, letterSpacing: '-0.03em' }}>AgentGuard</span>
        </div>

        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', justifyContent: 'center', position: 'relative', paddingBottom: '2rem' }}>
          <h2 style={{ fontSize: 'clamp(1.8rem, 3vw, 2.8rem)', fontWeight: 900, letterSpacing: '-0.03em', lineHeight: 1.2, marginBottom: '1.25rem' }}>
            AI agents that<br />
            <span style={{ color: C.blue }}>remember together.</span>
          </h2>
          <p style={{ color: C.muted, fontSize: 15, lineHeight: 1.75, maxWidth: 420, marginBottom: '2.5rem' }}>
            Kubernetes incident response with concurrent AI agents sharing one transactional memory — backed by CockroachDB.
          </p>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
            {[
              { dot: C.blue,    text: '8 diagnosis agents run in parallel' },
              { dot: C.green,   text: 'Serializable transactions — no duplicate remediations' },
              { dot: '#f0883e', text: 'Shared vector memory across all agents' },
            ].map(({ dot, text }) => (
              <div key={text} style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                <div style={{ width: 7, height: 7, borderRadius: '50%', background: dot, flexShrink: 0 }} />
                <span style={{ fontSize: 14, color: C.muted }}>{text}</span>
              </div>
            ))}
          </div>
        </div>

        {onBack && (
          <button onClick={onBack} style={{ background: 'none', border: 'none', color: C.muted, cursor: 'pointer', fontSize: 13, fontFamily: 'inherit', padding: 0, textAlign: 'left', position: 'relative' }}>
            ← Back to landing
          </button>
        )}
      </div>

      {/* right: form */}
      <div style={{
        background: C.surface, borderLeft: `1px solid ${C.border}`,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        padding: '3rem',
      }}>
        <div style={{ width: '100%', maxWidth: 420 }}>
          {sent ? (
            <div style={{ textAlign: 'center' }}>
              <div style={{ width: 64, height: 64, borderRadius: '50%', background: `${C.green}15`, border: `1px solid ${C.green}40`, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 28, margin: '0 auto 20px' }}>✉</div>
              <p style={{ fontWeight: 800, fontSize: 22, marginBottom: 10, letterSpacing: '-0.02em' }}>Check your email</p>
              <p style={{ color: C.muted, fontSize: 14, lineHeight: 1.75, marginBottom: 28 }}>
                Verification link sent to <strong style={{ color: C.text }}>{email}</strong>.<br />
                Click it to activate your account, then sign in.
              </p>
              <button onClick={() => { setSent(false); setTab('signin'); resetState(); }}
                style={{ background: 'none', border: 'none', color: C.blue, cursor: 'pointer', fontSize: 14, fontFamily: 'inherit' }}>
                Back to sign in
              </button>
            </div>
          ) : (
            <>
              <h3 style={{ fontSize: 26, fontWeight: 800, marginBottom: 8, letterSpacing: '-0.02em' }}>
                {tab === 'signin' ? 'Welcome back' : 'Create account'}
              </h3>
              <p style={{ color: C.muted, fontSize: 14, marginBottom: 32 }}>
                {tab === 'signin' ? 'Sign in to your AgentGuard account.' : 'Get started with AgentGuard.'}
              </p>
              <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: 22 }}>
                <label style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  <span style={{ fontSize: 12, fontWeight: 600, color: C.muted, letterSpacing: '0.06em', textTransform: 'uppercase' }}>Email</span>
                  <input
                    type="email" value={email} placeholder="you@example.com" required
                    onChange={e => setEmail(e.target.value)}
                    onFocus={e => (e.target.style.borderColor = C.blue)}
                    onBlur={e  => (e.target.style.borderColor = C.border)}
                    style={{ background: C.bg, border: `1px solid ${C.border}`, borderRadius: 8, padding: '13px 15px', color: C.text, fontSize: 15, fontFamily: 'inherit', width: '100%', outline: 'none', transition: 'border-color 0.15s' }}
                  />
                </label>
                <label style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  <span style={{ fontSize: 12, fontWeight: 600, color: C.muted, letterSpacing: '0.06em', textTransform: 'uppercase' }}>Password</span>
                  <input
                    type="password" value={password} required
                    placeholder={tab === 'signup' ? 'Min 6 characters' : 'Password'}
                    onChange={e => setPassword(e.target.value)}
                    onFocus={e => (e.target.style.borderColor = C.blue)}
                    onBlur={e  => (e.target.style.borderColor = C.border)}
                    style={{ background: C.bg, border: `1px solid ${C.border}`, borderRadius: 8, padding: '13px 15px', color: C.text, fontSize: 15, fontFamily: 'inherit', width: '100%', outline: 'none', transition: 'border-color 0.15s' }}
                  />
                </label>
                {error && (
                  <div style={{ background: `${C.red}15`, border: `1px solid ${C.red}40`, borderRadius: 8, padding: '11px 15px', color: C.red, fontSize: 13 }}>
                    {error}
                  </div>
                )}
                <button
                  type="submit" disabled={loading || !email || !password}
                  style={{
                    background: loading || !email || !password ? C.border : C.blue,
                    color:      loading || !email || !password ? C.muted  : '#0d1117',
                    border: 'none', borderRadius: 8, padding: '14px 0',
                    fontSize: 15, fontWeight: 700, cursor: loading ? 'wait' : 'pointer',
                    fontFamily: 'inherit', marginTop: 4,
                  }}
                >
                  {loading ? 'Please wait...' : tab === 'signin' ? 'Sign In' : 'Create Account'}
                </button>
              </form>
              <p style={{ textAlign: 'center', fontSize: 14, color: C.muted, marginTop: 28 }}>
                {tab === 'signin' ? (
                  <>{"Don't have an account? "}
                    <button type="button" onClick={() => { setTab('signup'); resetState(); }}
                      style={{ background: 'none', border: 'none', color: C.blue, cursor: 'pointer', fontSize: 14, fontFamily: 'inherit', padding: 0 }}>Sign up</button>
                  </>
                ) : (
                  <>{"Already have an account? "}
                    <button type="button" onClick={() => { setTab('signin'); resetState(); }}
                      style={{ background: 'none', border: 'none', color: C.blue, cursor: 'pointer', fontSize: 14, fontFamily: 'inherit', padding: 0 }}>Sign in</button>
                  </>
                )}
              </p>
            </>
          )}
        </div>
      </div>
    </div>
  );
}