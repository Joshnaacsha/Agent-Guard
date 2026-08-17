import { config } from 'dotenv';
import { resolve } from 'path';
config({ path: resolve(__dirname, '..', '..', '..', '..', '.env') });

import { insertIncidentMemory, seedRemediationBudget } from '@agentguard/db';
import { generateEmbedding } from '@agentguard/agents';

const PAST_INCIDENTS = [
  {
    summary: 'Pod payment-service-7d4f9 in namespace production entered CrashLoopBackOff. Container exited with code 137 (OOMKilled). Memory limit was 256Mi.',
    resolution: 'Heap dump revealed a memory leak in the payment processing worker thread. Increased memory limit to 512Mi. Deployed v2.1.4 with the leak patched. Pod stabilized within 3 minutes.',
  },
  {
    summary: 'Pod auth-service-abc12 in namespace production failed to start. Error: required environment variable DATABASE_URL not set.',
    resolution: 'A config map update accidentally removed the DATABASE_URL key. Re-added the missing key and performed a rolling restart. Service recovered in under 1 minute.',
  },
  {
    summary: 'Pod api-gateway-9x3k1 in namespace staging stuck in ImagePullBackOff. Image tag "v3.2-latest" does not exist in registry.',
    resolution: 'CI pipeline incorrectly tagged the image as "v3.2-latest" instead of "v3.2.0". Updated deployment manifest to correct tag. Pod came up after the change.',
  },
  {
    summary: 'Three pods of notification-worker in namespace production entered ErrImagePull. Error: unauthorized: authentication required from registry.',
    resolution: 'Docker registry credentials in imagePullSecret had expired. Rotated the service account token, updated the Kubernetes secret, performed rolling restart. All pods recovered.',
  },
  {
    summary: 'Pod data-processor-jvm-5f2d in namespace production OOMKilled repeatedly. JVM heap limited to 512Mi but processing 2GB datasets.',
    resolution: 'Added JVM flags -Xmx1500m -Xms512m. Increased memory limit to 2Gi. Added Kubernetes resource request of 1Gi for proper node scheduling. Stabilized after restart.',
  },
  {
    summary: 'Pod order-service-3x9q in namespace production CrashLoopBackOff. Logs show: dial tcp 10.0.1.45:5432 connection refused on startup.',
    resolution: 'The PostgreSQL pod was in Pending state due to a PVC provisioning delay. Added init container to wait for DB readiness with 60s timeout. Order service started cleanly on next rollout.',
  },
  {
    summary: 'Pod ml-inference-v2-7tpk in namespace production Pending for over 20 minutes. Event: Insufficient nvidia.com/gpu on all nodes.',
    resolution: 'GPU nodes were occupied by a batch training job. Cordoned training job to dedicated node pool using node affinity. Inference pod scheduled and started within 2 minutes.',
  },
  {
    summary: 'Pod user-service-6mn2 in namespace production CrashLoopBackOff. Liveness probe failing: HTTP probe received 503 before service fully initialized.',
    resolution: 'Service bootstrap takes 15 seconds to load caches. Added initialDelaySeconds: 30 to liveness probe. Set failureThreshold to 5. Pod passed health checks on next deployment.',
  },
  {
    summary: 'Pod report-generator-8kl3 in namespace staging CrashLoopBackOff. Error: configmap "report-templates" not found in namespace staging.',
    resolution: 'Config map was created in wrong namespace during refactoring. Re-applied the config map to staging namespace. Pod came up on next restart.',
  },
  {
    summary: 'Pod analytics-db-0 in namespace production Pending indefinitely. Event: pod has unbound immediate PersistentVolumeClaims.',
    resolution: 'StorageClass was deleted during a cluster upgrade leaving PVC provisioner unable to create volumes. Recreated StorageClass and re-applied PVC. Pod bound and started in 4 minutes.',
  },
  {
    summary: 'Pod batch-exporter-2nm5 in namespace production OOMKilled during nightly export at 02:00 UTC. Memory spiked to 4Gi processing a 50M row dataset.',
    resolution: 'Changed batch job to process in 500K row chunks. Added 3Gi memory limit. Nightly job now completes in 40 minutes with peak memory of 1.2Gi.',
  },
  {
    summary: 'Pod legacy-api-7vb4 in namespace production CrashLoopBackOff. Error: bind address already in use on port 8080.',
    resolution: 'Previous pod instance was not fully terminated and held the host port. Force-deleted the stuck terminating pod. New pod started without port conflict.',
  },
  {
    summary: 'Five pods in namespace production stuck in ImagePullBackOff. Error: toomanyrequests: You have reached your pull rate limit from Docker Hub.',
    resolution: 'Migrated all Docker Hub images to internal AWS ECR registry. Updated deployment manifests to ECR URLs. Images pulled without rate limiting.',
  },
  {
    summary: 'Pod search-service-4xk9 in namespace production Pending indefinitely. Node selector requires zone=us-east-1a but all nodes in that zone are cordoned for maintenance.',
    resolution: 'Updated node selector to zone in (us-east-1a, us-east-1b). Pod scheduled to us-east-1b immediately after the change.',
  },
  {
    summary: 'Pod checkout-service-9mn3 in namespace production CrashLoopBackOff. Error: connect ETIMEDOUT to inventory-service:8080 after 3 retries on startup.',
    resolution: 'inventory-service deployment was accidentally scaled to 0 replicas. Scaled back to 3 replicas. Added circuit breaker with 500ms timeout and 3 retries to prevent future cascading failures.',
  },
];

const NAMESPACE_BUDGETS = [
  { namespace: 'production', budget: 10000 },
  { namespace: 'staging', budget: 5000 },
  { namespace: 'development', budget: 2000 },
];

async function main(): Promise<void> {
  console.log('Seeding remediation budgets...');
  for (const { namespace, budget } of NAMESPACE_BUDGETS) {
    await seedRemediationBudget(namespace, budget);
    console.log(`  ✓ ${namespace}: $${budget}`);
  }

  console.log(`\nSeeding ${PAST_INCIDENTS.length} past incidents into incident_memory...`);
  for (let i = 0; i < PAST_INCIDENTS.length; i++) {
    const { summary, resolution } = PAST_INCIDENTS[i];
    const embedding = await generateEmbedding(`${summary} Resolution: ${resolution}`);
    await insertIncidentMemory(summary, resolution, embedding);
    console.log(`  ✓ [${i + 1}/${PAST_INCIDENTS.length}] ${summary.substring(0, 70)}...`);
  }

  console.log('\n✓ Seed complete');
  process.exit(0);
}

main().catch((err) => {
  console.error('Seed failed:', err);
  process.exit(1);
});
