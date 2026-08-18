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

export function isLambdaOriginatedIncident(podName: string): boolean {
  return podName.startsWith(LAMBDA_INCIDENT_PREFIX);
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

async function reinvokeAndCheck(payload: Record<string, unknown>): Promise<boolean> {
  const response = await getClient().send(new InvokeCommand({
    FunctionName: FUNCTION_NAME,
    // verify:true makes handler.js log this invoke as "[AgentGuard fix verification re-invoke]"
    // instead of an ordinary chaos-demo call — otherwise it's indistinguishable in CloudWatch
    // from a plain successful invoke, since the fix itself (an UpdateFunctionConfiguration API
    // call) never produces a log line at all.
    Payload: Buffer.from(JSON.stringify({ ...payload, verify: true })),
  }));
  return !response.FunctionError;
}

/**
 * Applies a real fix to the agentguard-pod-worker Lambda function based on the confirmed root
 * cause, waits for AWS to finish applying it, then re-invokes the same function with the same
 * failure mode to prove the fix actually holds. This is the "resolve directly in AWS" step —
 * remediation isn't a DB status flip, it's a genuine UpdateFunctionConfiguration call plus a
 * genuine re-invocation showing the previously-crashing call now succeeds.
 */
export async function applyAwsFix(action: RemediationAction): Promise<AwsFixResult> {
  try {
    switch (action) {
      case 'scale-up': {
        await getClient().send(new UpdateFunctionConfigurationCommand({
          FunctionName: FUNCTION_NAME,
          MemorySize: 512,
        }));
        await waitForConfigUpdate();
        const verified = await reinvokeAndCheck({ failureMode: 'oom', allocateMb: 300 });
        return { applied: true, detail: `Raised ${FUNCTION_NAME} MemorySize 128MB → 512MB.`, verified };
      }

      case 'timeout-fix': {
        await getClient().send(new UpdateFunctionConfigurationCommand({
          FunctionName: FUNCTION_NAME,
          Timeout: 15,
        }));
        await waitForConfigUpdate();
        const verified = await reinvokeAndCheck({ failureMode: 'timeout', sleepMs: 8000 });
        return { applied: true, detail: `Raised ${FUNCTION_NAME} Timeout 5s → 15s.`, verified };
      }

      case 'restart': {
        await getClient().send(new UpdateFunctionConfigurationCommand({
          FunctionName: FUNCTION_NAME,
          Environment: { Variables: { FORCE_HEALTHY: 'true' } },
        }));
        await waitForConfigUpdate();
        const verified = await reinvokeAndCheck({ failureMode: 'crash-loop' });
        return { applied: true, detail: `Deployed FORCE_HEALTHY=true hotfix env var to ${FUNCTION_NAME}.`, verified };
      }

      default:
        return { applied: false, detail: `No AWS-side fix mapped for action '${action}'.`, verified: null };
    }
  } catch (err: any) {
    return { applied: false, detail: `AWS fix failed: ${err.message ?? String(err)}`, verified: null };
  }
}
