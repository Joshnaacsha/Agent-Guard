import type { Incident } from '@agentguard/db';

const FAILURE_TEMPLATES = [
  (p: string, n: string) => `Pod ${p} in namespace ${n} is in CrashLoopBackOff. Container keeps exiting shortly after start.`,
  (p: string, n: string) => `Pod ${p} in namespace ${n} was OOMKilled. Container exited with code 137.`,
  (p: string, n: string) => `Pod ${p} in namespace ${n} is stuck in ImagePullBackOff — the image cannot be pulled.`,
  (p: string, n: string) => `Pod ${p} in namespace ${n} is failing readiness checks; the process starts but never becomes ready.`,
  (p: string, n: string) => `Pod ${p} in namespace ${n} is Pending and has not been scheduled onto any node.`,
] as const;

/**
 * Incidents don't persist a failure description (Phase 1's `incidents` table only has
 * pod/namespace/status). Diagnosis agents need something to investigate, so this derives a
 * plausible, deterministic symptom from the incident's identity when the caller doesn't supply
 * a real one (e.g. from an alert payload).
 */
export function defaultSymptomFor(incident: Incident): string {
  const seed = [...incident.incident_id].reduce((acc, ch) => acc + ch.charCodeAt(0), 0);
  const template = FAILURE_TEMPLATES[seed % FAILURE_TEMPLATES.length];
  return template(incident.pod_name, incident.namespace);
}
