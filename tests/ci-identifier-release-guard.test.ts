import { describe, expect, it } from 'vitest';
import { assertCiIdentifierReleaseSeedAllowed } from '../src/ops/ci-identifier-release-guard.js';

const SAFE_ENV = Object.freeze({
  CI: 'true',
  DATABASE_URL: 'postgresql://fluke:fluke_test_password@localhost:5432/fluke_test',
  DIRECT_URL: 'postgresql://fluke:fluke_test_password@localhost:5432/fluke_test',
  GITHUB_ACTIONS: 'true',
  IDENTIFIER_MODE: 'disabled',
  NODE_ENV: 'test',
});

describe('CI identifier release seed guard', () => {
  it('allows only the isolated GitHub Actions test database', () => {
    expect(() => assertCiIdentifierReleaseSeedAllowed(SAFE_ENV)).not.toThrow();
  });

  it.each([
    ['production mode', { NODE_ENV: 'production' }],
    ['non-Actions execution', { GITHUB_ACTIONS: undefined }],
    ['non-local host', { DATABASE_URL: 'postgresql://fluke:x@db.example/fluke_test' }],
    ['non-test database', { DATABASE_URL: 'postgresql://fluke:x@localhost:5432/fluke' }],
    ['alternate password', {
      DATABASE_URL: 'postgresql://fluke:not-the-ci-password@localhost:5432/fluke_test',
      DIRECT_URL: 'postgresql://fluke:not-the-ci-password@localhost:5432/fluke_test',
    }],
    ['socket host override', {
      DATABASE_URL: 'postgresql://fluke:fluke_test_password@localhost:5432/fluke_test?host=%2Fcloudsql%2Fproduction',
      DIRECT_URL: 'postgresql://fluke:fluke_test_password@localhost:5432/fluke_test?host=%2Fcloudsql%2Fproduction',
    }],
    ['schema override', {
      DATABASE_URL: 'postgresql://fluke:fluke_test_password@localhost:5432/fluke_test?schema=production',
      DIRECT_URL: 'postgresql://fluke:fluke_test_password@localhost:5432/fluke_test?schema=production',
    }],
    ['arbitrary query', {
      DATABASE_URL: 'postgresql://fluke:fluke_test_password@localhost:5432/fluke_test?connection_limit=1',
      DIRECT_URL: 'postgresql://fluke:fluke_test_password@localhost:5432/fluke_test?connection_limit=1',
    }],
    ['fragment', {
      DATABASE_URL: 'postgresql://fluke:fluke_test_password@localhost:5432/fluke_test#production',
      DIRECT_URL: 'postgresql://fluke:fluke_test_password@localhost:5432/fluke_test#production',
    }],
    ['percent-encoded database path', {
      DATABASE_URL: 'postgresql://fluke:fluke_test_password@localhost:5432/%66luke_test',
      DIRECT_URL: 'postgresql://fluke:fluke_test_password@localhost:5432/%66luke_test',
    }],
    ['different direct database', {
      DIRECT_URL: 'postgresql://fluke:fixture@localhost:5432/other_test',
    }],
    ['enabled product mode', { IDENTIFIER_MODE: 'on-device' }],
  ] as const)('rejects %s before a synthetic release can be written', (_case, override) => {
    expect(() => assertCiIdentifierReleaseSeedAllowed({
      ...SAFE_ENV,
      ...override,
    })).toThrow('CI identifier release fixture refused');
  });
});
