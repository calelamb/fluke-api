import type { PrismaClient } from '@prisma/client';
import { runAcartiaIngestion, runGbifIngestion } from './ingestion-jobs.js';
import { jobDefinition, type ScheduledJobName } from './job-catalog.js';
import { runLockedJob, type JobRunResult } from './job-runner.js';
import { PostgresJobLeaseStore } from './postgres-job-store.js';
import { runPredictionJob } from './prediction-job.js';

export async function runScheduledJob(
  name: ScheduledJobName,
  client: PrismaClient,
): Promise<JobRunResult> {
  const definition = jobDefinition(name);
  const store = new PostgresJobLeaseStore(client);
  return runLockedJob({
    jobName: definition.jobName,
    store,
    timeoutMs: definition.timeoutMs,
    work: (signal, lease) => {
      if (name === 'acartia') {
        return runAcartiaIngestion({ lease, signal, store });
      }
      if (name === 'gbif') {
        return runGbifIngestion({ lease, signal, store });
      }
      return runPredictionJob({ client, lease, signal, store });
    },
  });
}
