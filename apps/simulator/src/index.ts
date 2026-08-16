import { config } from 'dotenv';
import { resolve } from 'path';
config({ path: resolve(__dirname, '..', '..', '..', '.env') });

import { createIncident } from '@agentguard/db';

const POD_SERVICES = [
  'api-gateway', 'auth-service', 'payment-service', 'order-service',
  'notification-worker', 'report-generator', 'data-processor', 'checkout-service',
  'search-service', 'inventory-service', 'user-service', 'analytics-db',
];

const NAMESPACES = ['production', 'staging', 'development'] as const;

export const POD_FAILURE_TYPES = [
  'CrashLoopBackOff', 'OOMKilled', 'ImagePullBackOff',
  'ErrImagePull', 'ContainerCreating', 'Pending',
] as const;

export type PodFailureType = (typeof POD_FAILURE_TYPES)[number];

function randomFrom<T>(arr: readonly T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

async function emitEvent(): Promise<void> {
  const service = randomFrom(POD_SERVICES);
  const podName = `${service}-${Math.random().toString(36).substring(2, 8)}`;
  const namespace = randomFrom(NAMESPACES);
  const failureType = randomFrom(POD_FAILURE_TYPES);

  const incident = await createIncident(podName, namespace);
  const shortId = incident.incident_id.substring(0, 8);
  console.log(`[${new Date().toISOString()}] INCIDENT ${shortId} | ${namespace}/${podName} | ${failureType}`);
}

async function main(): Promise<void> {
  const intervalMs = parseInt(process.env.SIMULATOR_INTERVAL_MS ?? '5000', 10);
  const totalEvents = parseInt(process.env.SIMULATOR_TOTAL_EVENTS ?? '0', 10); // 0 = unlimited

  console.log(`Simulator starting — interval: ${intervalMs}ms | total: ${totalEvents || 'unlimited'}`);
  console.log('Press Ctrl+C to stop\n');

  let count = 0;

  const run = async () => {
    try {
      await emitEvent();
      count++;
    } catch (err) {
      console.error('Event failed:', err);
    }
    if (totalEvents > 0 && count >= totalEvents) {
      console.log(`\n✓ Emitted ${count} events. Done.`);
      process.exit(0);
    }
  };

  await run();
  const timer = setInterval(run, intervalMs);

  process.on('SIGINT', () => {
    clearInterval(timer);
    console.log(`\nSimulator stopped after ${count} events.`);
    process.exit(0);
  });
}

main().catch((err) => {
  console.error('Simulator failed:', err);
  process.exit(1);
});

