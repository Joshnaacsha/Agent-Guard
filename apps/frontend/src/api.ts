// Base URL for the AgentGuard backend. Empty string keeps requests relative,
// which works in dev (Vite proxies /api to localhost:3001) and in any setup
// where frontend and backend share an origin. Set VITE_API_URL when they're
// deployed separately (e.g. frontend on Vercel, backend on Render).
export const API_BASE = (import.meta.env.VITE_API_URL ?? '').replace(/\/$/, '');

export function apiUrl(path: string): string {
  return `${API_BASE}${path}`;
}
