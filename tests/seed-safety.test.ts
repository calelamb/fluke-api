import { describe, expect, it } from 'vitest';
import { assertSyntheticHistoryAllowed } from '../src/ops/synthetic-history-guard.js';

describe('synthetic history seed guard', () => {
  it('rejects production even when the explicit opt-in is set', () => {
    expect(() =>
      assertSyntheticHistoryAllowed({
        NODE_ENV: 'production',
        ALLOW_SYNTHETIC_HISTORY: 'true',
      }),
    ).toThrowError('Synthetic historical sightings are disabled in production.');
  });

  it('requires an explicit opt-in outside production', () => {
    expect(() => assertSyntheticHistoryAllowed({ NODE_ENV: 'development' })).toThrowError(
      'Set ALLOW_SYNTHETIC_HISTORY=true to generate synthetic historical sightings.',
    );
  });

  it('allows an explicitly opted-in non-production run', () => {
    expect(() =>
      assertSyntheticHistoryAllowed({
        NODE_ENV: 'development',
        ALLOW_SYNTHETIC_HISTORY: 'true',
      }),
    ).not.toThrow();
  });
});
