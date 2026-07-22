import { jobDefinition } from '../src/jobs/job-catalog.js';
import { warmPublicReads } from '../src/jobs/public-read-warmer.js';

async function main(): Promise<number> {
  try {
    const job = jobDefinition(process.argv[2]).name;
    const result = await warmPublicReads(job, {
      fetch: globalThis.fetch,
      origin: process.env.PUBLIC_READ_ORIGIN ?? '',
    });
    process.stdout.write(`${JSON.stringify({ job, ...result })}\n`);
    return 0;
  } catch {
    process.stderr.write('{"code":"PUBLIC_READ_WARM_FAILED"}\n');
    return 1;
  }
}

process.exitCode = await main();
