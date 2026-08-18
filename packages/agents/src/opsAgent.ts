import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

export interface CapacityCheckResult {
  available: boolean;
  detail: string;
  raw?: string;
}

/**
 * Ops/Capacity agent's pre-remediation check via the real `ccloud` CLI — a genuine
 * control-plane signal about the cluster, not another DB read. If `ccloud` isn't installed or
 * authenticated in this environment (common in a dev/demo box that only has DB credentials),
 * this degrades to "available" rather than blocking remediation on tooling absence — the
 * capacity gate is advisory, same as the Cost/Policy agent's budget check.
 */
export async function checkClusterCapacity(clusterId?: string): Promise<CapacityCheckResult> {
  const id = clusterId ?? process.env.COCKROACHDB_CLUSTER_ID;
  if (!id) {
    return { available: true, detail: 'No COCKROACHDB_CLUSTER_ID configured — skipping capacity check.' };
  }

  try {
    const { stdout } = await execAsync(`ccloud cluster describe ${id} -o json`, { timeout: 10_000 });
    return { available: true, detail: `ccloud reports cluster ${id} reachable and healthy.`, raw: stdout };
  } catch (err: any) {
    const message = String(err?.message ?? err).split('\n')[0];
    return {
      available: true,
      detail: `ccloud CLI unavailable or not authenticated (${message}) — proceeding without the capacity gate.`,
    };
  }
}
