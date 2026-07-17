import { describe, expect, it } from 'vitest';
import { jobDefinition } from '../../src/jobs/job-catalog.js';

describe('scheduled job catalog', () => {
  it.each([
    ['acartia', 'acartia-ingest', 2 * 60_000],
    ['gbif', 'gbif-ingest', 15 * 60_000],
    ['predictions', 'prediction-compute', 10 * 60_000],
  ] as const)('defines %s with a bounded deadline', (name, jobName, timeoutMs) => {
    expect(jobDefinition(name)).toEqual({ jobName, name, timeoutMs });
  });

  it('rejects unknown and blank job names', () => {
    expect(() => jobDefinition('')).toThrow('Unknown scheduled job');
    expect(() => jobDefinition('acartia-ingest')).toThrow('Unknown scheduled job');
  });
});
