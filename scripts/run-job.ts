import { pathToFileURL } from 'node:url';
import { PrismaClient } from '@prisma/client';
import { jobDefinition } from '../src/jobs/job-catalog.js';
import { JOB_EXIT } from '../src/jobs/job-runner.js';
import { runScheduledJob } from '../src/jobs/run-scheduled-job.js';

interface JobCliDependencies {
  readonly createClient: () => PrismaClient;
  readonly runScheduledJob: typeof runScheduledJob;
  readonly writeStderr: (message: string) => void;
  readonly writeStdout: (message: string) => void;
}

const DEFAULT_DEPENDENCIES: JobCliDependencies = Object.freeze({
  createClient: () => new PrismaClient(),
  runScheduledJob,
  writeStderr: (message: string) => process.stderr.write(message),
  writeStdout: (message: string) => process.stdout.write(message),
});

async function disconnect(client: PrismaClient, dependencies: JobCliDependencies): Promise<boolean> {
  try {
    await client.$disconnect();
    return true;
  } catch {
    dependencies.writeStderr('{"level":"error","code":"JOB_DISCONNECT_FAILED"}\n');
    return false;
  }
}

async function executeJob(
  definition: ReturnType<typeof jobDefinition>,
  client: PrismaClient,
  dependencies: JobCliDependencies,
): Promise<Readonly<{ exitCode: number; summary?: Readonly<Record<string, unknown>> }>> {
  try {
    return await dependencies.runScheduledJob(definition.name, client);
  } catch {
    dependencies.writeStderr(`${JSON.stringify({
      code: 'JOB_RUNTIME_FAILED',
      job: definition.name,
      level: 'error',
    })}\n`);
    return { exitCode: JOB_EXIT.FAILURE };
  }
}

export async function runJobCli(
  value: string | undefined,
  dependencies: JobCliDependencies = DEFAULT_DEPENDENCIES,
): Promise<number> {
  const definition = (() => {
    try {
      return jobDefinition(value);
    } catch {
      return null;
    }
  })();
  if (!definition) {
    dependencies.writeStderr('{"level":"error","code":"INVALID_JOB_NAME"}\n');
    return JOB_EXIT.CONFIG;
  }

  const client = dependencies.createClient();
  const execution = await executeJob(definition, client, dependencies);
  const disconnected = await disconnect(client, dependencies);
  const exitCode = disconnected ? execution.exitCode : JOB_EXIT.FAILURE;
  dependencies.writeStdout(`${JSON.stringify({
    exitCode,
    job: definition.name,
    summary: disconnected ? execution.summary ?? null : null,
  })}\n`);
  return exitCode;
}

const invokedPath = process.argv[1] ? pathToFileURL(process.argv[1]).href : '';
if (import.meta.url === invokedPath) {
  process.exitCode = await runJobCli(process.argv[2]);
}
