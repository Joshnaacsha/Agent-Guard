import { Router } from 'express';
import { listIncidents, createIncident, getIncident, getDiagnoses, getAgentActions } from '@agentguard/db';
import {
  runConcurrentDiagnosis, evaluateRemediationPolicy, defaultSymptomFor,
  runConcurrentRemediation, checkIncidentConsistency, checkFleetConsistency,
} from '@agentguard/agents';
import { invokePodWorker, type PodFailureMode } from '../aws/lambdaInvoker';

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

// AWS Lambda chaos demo: invokes the real agentguard-pod-worker Lambda function (see
// infra/lambda/), which stands in for a pod's container process. A genuine AWS crash/OOM/
// timeout becomes a real incident, fed with the actual Lambda requestId + error as its symptom.
const VALID_FAILURE_MODES: PodFailureMode[] = ['healthy', 'crash-loop', 'oom', 'timeout'];

router.post('/incidents/lambda-invoke', async (req, res) => {
  try {
    const namespace = req.body?.namespace ?? 'production';
    const failureMode: PodFailureMode = VALID_FAILURE_MODES.includes(req.body?.failure_mode)
      ? req.body.failure_mode
      : 'crash-loop';
    // Encode the failure mode in the pod_name so the remediation agent can later verify the
    // AWS-side fix against the *actual* mode that crashed (isLambdaOriginatedIncident +
    // parseLambdaFailureMode). Prefix stays `lambda-pod-` so isLambdaOriginatedIncident matches.
    const podName = req.body?.pod_name ?? `lambda-pod-${failureMode}-${Math.random().toString(36).substring(2, 8)}`;

    const invocation = await invokePodWorker(podName, namespace, failureMode);

    if (invocation.ok) {
      res.json({ ok: true, invocation, incident: null, symptom: null });
      return;
    }

    const incident = await createIncident(podName, namespace);
    const symptom =
      `Pod ${podName} in namespace ${namespace} crashed when its container was invoked as the real ` +
      `AWS Lambda function agentguard-pod-worker (RequestId ${invocation.requestId}, ${invocation.durationMs}ms): ` +
      `${invocation.errorType ?? 'Error'} — ${invocation.errorMessage ?? 'unknown error'}.`;

    res.status(201).json({ ok: false, invocation, incident, symptom });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to invoke pod worker Lambda — check AWS credentials and that agentguard-pod-worker is deployed' });
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
