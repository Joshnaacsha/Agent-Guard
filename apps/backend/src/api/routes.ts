import { Router } from 'express';
import { listIncidents, createIncident } from '@agentguard/db';

export const router = Router();

router.get('/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

router.get('/incidents', async (_req, res) => {
  try {
    const incidents = await listIncidents(50);
    res.json(incidents);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch incidents' });
  }
});

router.post('/incidents/simulate', async (req, res) => {
  try {
    const podName = req.body?.pod_name ?? `sim-pod-${Math.random().toString(36).substring(2, 8)}`;
    const namespace = req.body?.namespace ?? 'production';
    const incident = await createIncident(podName, namespace);
    res.status(201).json(incident);
  } catch (err) {
    res.status(500).json({ error: 'Failed to create incident' });
  }
});

// Phase 2: trigger concurrent diagnosis on an incident
router.post('/incidents/:id/diagnose', async (_req, res) => {
  res.status(501).json({ message: 'Not yet implemented — Phase 2' });
});

// Phase 3: trigger concurrent remediation on a diagnosed incident
router.post('/incidents/:id/remediate', async (_req, res) => {
  res.status(501).json({ message: 'Not yet implemented — Phase 3' });
});
