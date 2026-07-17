import type { PrismaClient } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';
import { runJobCli } from '../../scripts/run-job.js';
import { JOB_EXIT } from '../../src/jobs/job-runner.js';

describe('runJobCli', () => {
  it('maps a disconnect failure to the documented failure exit code', async () => {
    const disconnect = vi.fn(async () => {
      throw new Error('disconnect failed');
    });
    const client = { $disconnect: disconnect } as unknown as PrismaClient;

    const writeStdout = vi.fn();
    await expect(runJobCli('predictions', {
      createClient: () => client,
      runScheduledJob: vi.fn(async () => ({ exitCode: JOB_EXIT.SUCCESS })),
      writeStderr: vi.fn(),
      writeStdout,
    })).resolves.toBe(JOB_EXIT.FAILURE);
    expect(disconnect).toHaveBeenCalledOnce();
    expect(writeStdout).toHaveBeenCalledWith(expect.stringContaining(`"exitCode":${JOB_EXIT.FAILURE}`));
    expect(writeStdout).not.toHaveBeenCalledWith(expect.stringContaining('"exitCode":0'));
  });

  it('preserves an existing failure when disconnect also fails', async () => {
    const client = {
      $disconnect: vi.fn(async () => {
        throw new Error('disconnect failed');
      }),
    } as unknown as PrismaClient;

    await expect(runJobCli('predictions', {
      createClient: () => client,
      runScheduledJob: vi.fn(async () => ({ exitCode: JOB_EXIT.FAILURE })),
      writeStderr: vi.fn(),
      writeStdout: vi.fn(),
    })).resolves.toBe(JOB_EXIT.FAILURE);
  });
});
