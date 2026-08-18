import {
  LambdaClient, InvokeCommand, GetFunctionCommand, UpdateFunctionConfigurationCommand,
} from '@aws-sdk/client-lambda';

const FUNCTION_NAME = process.env.POD_WORKER_LAMBDA_NAME ?? 'agentguard-pod-worker';
const REGION = process.env.AWS_REGION ?? 'us-east-1';
const BASELINE_MEMORY_MB = 128;
const BASELINE_TIMEOUT_S = 5;

let client: LambdaClient | null = null;
function getClient(): LambdaClient {
  if (!client) client = new LambdaClient({ region: REGION });
  return client;
}

async function waitForConfigUpdate(maxAttempts = 15): Promise<void> {
  for (let i = 0; i < maxAttempts; i++) {
    const { Configuration } = await getClient().send(new GetFunctionCommand({ FunctionName: FUNCTION_NAME }));
    if (Configuration?.LastUpdateStatus !== 'InProgress') return;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
}

/**
 * Remediation (awsRemediator.ts) leaves real config changes on the live function — raised
 * memory, raised timeout, or a FORCE_HEALTHY env var — so a previously-remediated function
 * keeps reporting "no crash" on the next chaos-demo invoke instead of failing again. Resetting
 * to baseline before every crash/oom/timeout invoke makes each "Invoke →" click reproduce a
 * genuine failure regardless of what an earlier remediation did, without requiring a manual
 * `npm run lambda:deploy` between demo runs. Skipped when already at baseline to avoid the
 * ~1-2s UpdateFunctionConfiguration round trip on every invoke.
 */
async function resetToBaselineIfNeeded(): Promise<void> {
  const { Configuration } = await getClient().send(new GetFunctionCommand({ FunctionName: FUNCTION_NAME }));
  const env = Configuration?.Environment?.Variables ?? {};
  const atBaseline =
    Configuration?.MemorySize === BASELINE_MEMORY_MB &&
    Configuration?.Timeout === BASELINE_TIMEOUT_S &&
    Object.keys(env).length === 0;
  if (atBaseline) return;

  await getClient().send(new UpdateFunctionConfigurationCommand({
    FunctionName: FUNCTION_NAME,
    MemorySize: BASELINE_MEMORY_MB,
    Timeout: BASELINE_TIMEOUT_S,
    Environment: { Variables: {} },
  }));
  await waitForConfigUpdate();
}

export type PodFailureMode = 'healthy' | 'crash-loop' | 'oom' | 'timeout';

export interface PodWorkerInvocation {
  ok: boolean;
  requestId: string;
  durationMs: number;
  failureMode: PodFailureMode;
  errorType?: string;
  errorMessage?: string;
}

/**
 * Invokes the real `agentguard-pod-worker` Lambda function (see infra/lambda/) — this stands
 * in for a Kubernetes pod's container process. On crash-loop/oom/timeout, AWS Lambda itself
 * kills the invocation and returns FunctionError + a real requestId; this wraps that into a
 * structured result so the caller can turn a genuine AWS failure into a k8s-style incident.
 */
export async function invokePodWorker(
  podName: string,
  namespace: string,
  failureMode: PodFailureMode
): Promise<PodWorkerInvocation> {
  if (failureMode !== 'healthy') await resetToBaselineIfNeeded();

  const start = Date.now();
  const command = new InvokeCommand({
    FunctionName: FUNCTION_NAME,
    Payload: Buffer.from(JSON.stringify({ podName, namespace, failureMode })),
  });

  const response = await getClient().send(command);
  const durationMs = Date.now() - start;
  const requestId = response.$metadata.requestId ?? 'unknown';

  if (response.FunctionError) {
    const payload = response.Payload
      ? JSON.parse(Buffer.from(response.Payload).toString('utf-8'))
      : {};
    return {
      ok: false,
      requestId,
      durationMs,
      failureMode,
      errorType: payload.errorType ?? response.FunctionError,
      errorMessage: payload.errorMessage ?? 'Lambda invocation failed',
    };
  }

  return { ok: true, requestId, durationMs, failureMode };
}
