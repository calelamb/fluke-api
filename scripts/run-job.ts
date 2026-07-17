import { pathToFileURL } from 'node:url';
import { PrismaClient } from '@prisma/client';
import { jobDefinition } from '../src/jobs/job-catalog.js';
import { JOB_EXIT } from '../src/jobs/job-runner.js';
import { runScheduledJob } from '../src/jobs/run-scheduled-job.js';

export async function runJobCli(value: string | undefined): Promise<number> {
  let definition: ReturnType<typeof jobDefinition>;
  try {
    definition = jobDefinition(value);
  } catch {
    process.stderr.write('{"level":"error","code":"INVALID_JOB_NAME"}\n');
    return JOB_EXIT.CONFIG;
  }

  const client = new PrismaClient();
  try {
    const result = await runScheduledJob(definition.name, client);
    process.stdout.write(`${JSON.stringify({
      exitCode: result.exitCode,
      job: definition.name,
      summary: result.summary ?? null,
    })}\n`);
    return result.exitCode;
  } catch {
    process.stderr.write(`${JSON.stringify({
      code: 'JOB_RUNTIME_FAILED',
      job: definition.name,
      level: 'error',
    })}\n`);
    return JOB_EXIT.FAILURE;
  } finally {
    await client.$disconnect();
  }
}

const invokedPath = process.argv[1] ? pathToFileURL(process.argv[1]).href : '';
if (import.meta.url === invokedPath) {
  process.exitCode = await runJobCli(process.argv[2]);
}
