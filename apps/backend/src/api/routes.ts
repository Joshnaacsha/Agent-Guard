import { Router } from 'express';
import { listIncidents, createIncident, getIncident, getDiagnoses, getAgentActions } from '@agentguard/db';
import {
  runConcurrentDiagnosis, evaluateRemediationPolicy, defaultSymptomFor,
  runConcurrentRemediation, checkIncidentConsistency, checkFleetConsistency,
} from '@agentguard/agents';

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
router.post('/incidents/:id/diagnose', async (req, res) => {
  try {
    const incident = await getIncident(req.params.id);
    if (!incident) {
      res.status(404).json({ error: 'Incident not found' });
      return;
    }

    const agentCount = Number.isFinite(req.body?.agent_count) ? Number(req.body.agent_count) : 5;
    const reconcile = req.body?.reconcile ?? true;
    const symptom = typeof req.body?.symptom === 'string' && req.body.symptom.trim().length > 0
      ? req.body.symptom
      : defaultSymptomFor(incident);

    const { summary, results } = await runConcurrentDiagnosis({ incident, symptom, agentCount, reconcile });

    let policy = null;
    if (summary.confirmedRootCause) {
      policy = await evaluateRemediationPolicy(incident.namespace, summary.confirmedRootCause);
    }

    res.json({ incident_id: incident.incident_id, symptom, summary, results, policy });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to run concurrent diagnosis' });
  }
});

// Inspect all diagnoses (proposed/confirmed/superseded) written for an incident
router.get('/incidents/:id/diagnoses', async (req, res) => {
  try {
    const diagnoses = await getDiagnoses(req.params.id);
    res.json(diagnoses);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch diagnoses' });
  }
});

// Phase 3: trigger concurrent remediation on a diagnosed incident
router.post('/incidents/:id/remediate', async (req, res) => {
  try {
    const incident = await getIncident(req.params.id);
    if (!incident) {
      res.status(404).json({ error: 'Incident not found' });
      return;
    }
    if (incident.status !== 'DIAGNOSED') {
      res.status(409).json({ error: `Incident is ${incident.status}, must be DIAGNOSED before remediation` });
      return;
    }

    const agentCount = Number.isFinite(req.body?.agent_count) ? Number(req.body.agent_count) : 5;
    const { summary, results } = await runConcurrentRemediation({ incident, agentCount });
    const consistency = await checkIncidentConsistency(incident.incident_id);

    res.json({ incident_id: incident.incident_id, summary, results, consistency });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to run concurrent remediation' });
  }
});

// Full audit log of every agent operation against one incident
router.get('/incidents/:id/actions', async (req, res) => {
  try {
    const actions = await getAgentActions(req.params.id);
    res.json(actions);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch agent actions' });
  }
});

// Independent audit of one incident's final state against the concurrency invariants
router.get('/incidents/:id/consistency', async (req, res) => {
  try {
    const report = await checkIncidentConsistency(req.params.id);
    res.json(report);
  } catch (err) {
    res.status(500).json({ error: 'Failed to run consistency check' });
  }
});

// Fleet-wide consistency check across recent incidents + all namespace budgets
router.get('/consistency', async (_req, res) => {
  try {
    const report = await checkFleetConsistency(50);
    res.json(report);
  } catch (err) {
    res.status(500).json({ error: 'Failed to run fleet consistency check' });
  }
});
