import {
  LambdaClient, UpdateFunctionConfigurationCommand, GetFunctionCommand, InvokeCommand,
} from '@aws-sdk/client-lambda';
import type { RemediationAction } from './policy';

const FUNCTION_NAME = process.env.POD_WORKER_LAMBDA_NAME ?? 'agentguard-pod-worker';
const REGION = process.env.AWS_REGION ?? 'us-east-1';

let client: LambdaClient | null = null;
function getClient(): LambdaClient {
  if (!client) client = new LambdaClient({ region: REGION });
  return client;
}

// Route-level convention (apps/backend/src/api/routes.ts /incidents/lambda-invoke): incidents
// created from a real pod-worker Lambda crash always get this pod_name prefix. Only those
// incidents are safe to apply a real AWS fix to — everything else is a synthetic/simulated
// incident with no real Lambda function behind it.
const LAMBDA_INCIDENT_PREFIX = 'lambda-pod-';

// The four failure modes the pod-worker Lambda handler supports (must match handler.js).
type LambdaFailureMode = 'healthy' | 'crash-loop' | 'oom' | 'timeout';
const LAMBDA_FAILURE_MODES: LambdaFailureMode[] = ['healthy', 'crash-loop', 'oom', 'timeout'];

export function isLambdaOriginatedIncident(podName: string): boolean {
  return podName.startsWith(LAMBDA_INCIDENT_PREFIX);
}

/**
 * Extracts the original failure mode from a `lambda-pod-<mode>-<rand>` incident pod name
 * (see routes.ts /incidents/lambda-invoke). Falls back to `crash-loop` when the mode is
 * missing so an older incident row still gets a real AWS fix + verification instead of a
 * silent no-op.
 */
export function parseLambdaFailureMode(podName: string): LambdaFailureMode {
  const suffix = podName.slice(LAMBDA_INCIDENT_PREFIX.length);
  const first = suffix.split('-')[0];
  return LAMBDA_FAILURE_MODES.includes(first as LambdaFailureMode)
    ? (first as LambdaFailureMode)
    : 'crash-loop';
}

export interface AwsFixResult {
  applied: boolean;
  detail: string;
  /** true = re-invoked the function after the fix and it succeeded; false = still failing; null = not re-tested */
  verified: boolean | null;
}

async function waitForConfigUpdate(maxAttempts = 15): Promise<void> {
  for (let i = 0; i < maxAttempts; i++) {
    const { Configuration } = await getClient().send(new GetFunctionCommand({ FunctionName: FUNCTION_NAME }));
    if (Configuration?.LastUpdateStatus !== 'InProgress') return;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
}

/**
 * Re-invokes the pod-worker Lambda with the *original* failure mode that crashed the incident
 * — so a memory raise is verified against the real OOM invoke, a timeout raise against the
 * real long invoke, and a hotfix env var against the real crash-loop invoke. The verify:true
 * flag makes handler.js tag its log line as "[AgentGuard fix verification re-invoke]" so this
 * appears distinctly in CloudWatch next to the original crash.
 */
async function reinvokeAndCheck(failureMode: LambdaFailureMode): Promise<boolean> {
  const payload: Record<string, unknown> = { failureMode, verify: true };
  if (failureMode === 'oom') payload.allocateMb = 300;
  if (failureMode === 'timeout') payload.sleepMs = 8000;

  const response = await getClient().send(new InvokeCommand({
    FunctionName: FUNCTION_NAME,
    Payload: Buffer.from(JSON.stringify(payload)),
  }));
  return !response.FunctionError;
}

/**
 * "Redeploy fixed code" hotfix — sets FORCE_HEALTHY=true on the running Lambda function so
 * handler.js short-circuits any subsequent failure-mode invocation. Used for the three actions
 * (`restart`, `rollback`, `config-fix`) that all model "the code / config is broken, ship a
 * healthy version." UpdateFunctionConfiguration.Environment replaces the whole variable set,
 * which is fine here — the function has no other required env vars.
 */
async function applyHotfix(): Promise<void> {
  await getClient().send(new UpdateFunctionConfigurationCommand({
    FunctionName: FUNCTION_NAME,
    Environment: { Variables: { FORCE_HEALTHY: 'true' } },
  }));
  await waitForConfigUpdate();
}

/**
 * Applies a real fix to the agentguard-pod-worker Lambda function based on the confirmed root
 * cause, waits for AWS to finish applying it, then re-invokes the same function with the
 * original failure mode to prove the fix actually holds. This is the "resolve directly in AWS"
 * step — remediation isn't a DB status flip, it's a genuine UpdateFunctionConfiguration call
 * plus a genuine re-invocation showing the previously-crashing call now succeeds.
 */
export async function applyAwsFix(
  action: RemediationAction,
  originalFailureMode: LambdaFailureMode
): Promise<AwsFixResult> {
  console.log(`[awsRemediator] applying '${action}' to ${FUNCTION_NAME} (original mode: ${originalFailureMode})`);
  try {
    switch (action) {
      case 'scale-up': {
        await getClient().send(new UpdateFunctionConfigurationCommand({
          FunctionName: FUNCTION_NAME,
          MemorySize: 512,
        }));
        await waitForConfigUpdate();
        const verified = await reinvokeAndCheck(originalFailureMode);
        console.log(`[awsRemediator] scale-up applied; verify(${originalFailureMode})=${verified}`);
        return { applied: true, detail: `Raised ${FUNCTION_NAME} MemorySize 128MB → 512MB.`, verified };
      }

      case 'timeout-fix': {
        await getClient().send(new UpdateFunctionConfigurationCommand({
          FunctionName: FUNCTION_NAME,
          Timeout: 15,
        }));
        await waitForConfigUpdate();
        const verified = await reinvokeAndCheck(originalFailureMode);
        console.log(`[awsRemediator] timeout-fix applied; verify(${originalFailureMode})=${verified}`);
        return { applied: true, detail: `Raised ${FUNCTION_NAME} Timeout 5s → 15s.`, verified };
      }

      case 'restart':
      case 'rollback':
      case 'config-fix': {
        // All three model "the code/config is broken, ship a fixed version" — for the demo
        // Lambda that's the same operation: flip FORCE_HEALTHY=true so handler.js short-circuits
        // every failure mode. Distinct action labels stay in the audit log & UI.
        await applyHotfix();
        const verified = await reinvokeAndCheck(originalFailureMode);
        const label =
          action === 'restart' ? 'FORCE_HEALTHY=true hotfix env var'
          : action === 'rollback' ? 'FORCE_HEALTHY=true rollback env var (simulates redeploy of prior-known-good image)'
          : 'FORCE_HEALTHY=true config-fix env var (simulates missing/corrected config)';
        console.log(`[awsRemediator] ${action} applied; verify(${originalFailureMode})=${verified}`);
        return { applied: true, detail: `Deployed ${label} to ${FUNCTION_NAME}.`, verified };
      }

      default: {
        const exhaustive: never = action;
        return { applied: false, detail: `No AWS-side fix mapped for action '${exhaustive}'.`, verified: null };
      }
    }
  } catch (err: any) {
    const message = err?.message ?? String(err);
    console.error(`[awsRemediator] '${action}' failed: ${message}`);
    return { applied: false, detail: `AWS fix failed: ${message}`, verified: null };
  }
}

