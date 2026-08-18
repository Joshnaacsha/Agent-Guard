import { LambdaClient, InvokeCommand } from '@aws-sdk/client-lambda';

const FUNCTION_NAME = process.env.POD_WORKER_LAMBDA_NAME ?? 'agentguard-pod-worker';
const REGION = process.env.AWS_REGION ?? 'us-east-1';

let client: LambdaClient | null = null;
function getClient(): LambdaClient {
  if (!client) client = new LambdaClient({ region: REGION });
  return client;
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
