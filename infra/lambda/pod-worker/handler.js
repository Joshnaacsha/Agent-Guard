// AgentGuard's "pod worker" Lambda — this stands in for a Kubernetes pod's container process.
// Deployed with a small memory limit (128MB) and short timeout (5s) so the failure modes below
// are genuine AWS Lambda crashes (real OOM kill, real Sandbox.Timedout), not simulated strings.
exports.handler = async (event) => {
  const failureMode = event?.failureMode ?? 'healthy';
  const podName = event?.podName ?? 'unknown-pod';
  const namespace = event?.namespace ?? 'default';

  // Set by the remediation agent via a real UpdateFunctionConfiguration call after a
  // CrashLoopBackOff diagnosis — models a hotfix deployed to the running function. If it's
  // set, no failure mode below can crash the invocation anymore.
  if (process.env.FORCE_HEALTHY === 'true') {
    return { statusCode: 200, body: `${podName} healthy (FORCE_HEALTHY hotfix active)` };
  }

  console.log(`pod-worker starting: pod=${podName} namespace=${namespace} mode=${failureMode}`);

  switch (failureMode) {
    case 'healthy':
      return { statusCode: 200, body: `${podName} healthy` };

    case 'crash-loop':
      // Process throws on startup, same shape as a container that exits immediately — k8s
      // would restart it and mark it CrashLoopBackOff after enough consecutive failures.
      throw new Error(`Container process crashed on startup (exit code 1) — CrashLoopBackOff`);

    case 'oom': {
      // Deliberately exceed the function's *current* memory limit so the Lambda runtime itself
      // kills the process (real container OOM) — the same failure mode as a k8s OOMKilled pod.
      // Allocated in small chunks (not one huge Buffer.alloc) so a low memory limit triggers a
      // real "signal: killed" container OOM instead of a V8-internal RangeError. The total is
      // fixed (not scaled to memory), so after a real remediation raises MemorySize past this,
      // the identical invocation succeeds.
      const allocateMb = Number(event?.allocateMb ?? 300);
      const chunkMb = 20;
      const chunks = [];
      for (let allocated = 0; allocated < allocateMb; allocated += chunkMb) {
        chunks.push(Buffer.alloc(chunkMb * 1024 * 1024, 1));
      }
      return { statusCode: 200, body: `allocated ~${chunks.length * chunkMb}MB without dying` };
    }

    case 'timeout': {
      // Sleep a fixed duration — if it exceeds the function's *current* configured timeout, AWS
      // kills the invocation with a real Sandbox.Timedout error (a container that never becomes
      // ready). After a real remediation raises the timeout past this, the same call succeeds.
      const sleepMs = Number(event?.sleepMs ?? 8000);
      await new Promise((resolve) => setTimeout(resolve, sleepMs));
      return { statusCode: 200, body: `completed after ${sleepMs}ms sleep` };
    }

    default:
      throw new Error(`Unknown failureMode: ${failureMode}`);
  }
};
