import { useEffect, useState } from 'react';

function App() {
  const [status, setStatus] = useState('Connecting...');

  useEffect(() => {
    // Supabase Realtime subscriptions and backend polling wired in Phase 1+
    fetch('/api/health')
      .then((r) => r.json())
      .then(() => setStatus('Backend connected'))
      .catch(() => setStatus('Backend offline'));
  }, []);

  return (
    <div style={{ fontFamily: 'monospace', padding: '2rem' }}>
      <h1>AgentGuard</h1>
      <p>Concurrency-Safe Kubernetes Incident Response</p>
      <p style={{ color: '#888' }}>{status}</p>
    </div>
  );
}

export default App;
