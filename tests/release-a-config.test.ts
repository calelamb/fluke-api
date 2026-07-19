import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parseEnv } from '../src/env.js';

const repositoryRoot = fileURLToPath(new URL('../', import.meta.url));

function readRepositoryFile(relativePath: string): string {
  return readFileSync(`${repositoryRoot}${relativePath}`, 'utf8');
}

const REQUIRED_ENV: NodeJS.ProcessEnv = {
  DATABASE_URL: 'postgresql://test:test@localhost:5432/test',
  DIRECT_URL: 'postgresql://test:test@localhost:5432/test',
  JWT_SECRET: 'x'.repeat(32),
};

const SAFE_S3_ENV: NodeJS.ProcessEnv = {
  STORAGE_BACKEND: 's3',
  OBJECT_STORAGE_ACCESS_KEY_ID: 'access',
  OBJECT_STORAGE_BUCKET: 'fluke-private',
  OBJECT_STORAGE_ENDPOINT: 'https://objects.example.com',
  OBJECT_STORAGE_FORCE_PATH_STYLE: 'true',
  OBJECT_STORAGE_REGION: 'us-west-2',
  OBJECT_STORAGE_SECRET_ACCESS_KEY: 'secret',
};

const SAFE_PRODUCTION_ENV: NodeJS.ProcessEnv = {
  ...REQUIRED_ENV,
  ...SAFE_S3_ENV,
  NODE_ENV: 'production',
  WEB_ORIGIN: 'https://fluke.example,https://www.fluke.example',
  API_PUBLIC_ORIGIN: 'https://api.fluke.example',
};

describe('Release A environment configuration', () => {
  it('rejects a partial object-storage block even while local storage is selected', () => {
    expect(() => parseEnv({
      ...REQUIRED_ENV,
      STORAGE_BACKEND: 'local',
      OBJECT_STORAGE_BUCKET: 'partial-private-bucket',
    })).toThrow(/OBJECT_STORAGE/);
  });

  it('rejects production local storage including the implicit default', () => {
    expect(() => parseEnv({
      ...REQUIRED_ENV,
      NODE_ENV: 'production',
      WEB_ORIGIN: 'https://fluke.example',
      API_PUBLIC_ORIGIN: 'https://api.fluke.example',
    })).toThrow(/STORAGE_BACKEND/);
  });

  it('requires every private S3 value when the S3 backend is selected', () => {
    expect(() => parseEnv({
      ...REQUIRED_ENV,
      NODE_ENV: 'test',
      STORAGE_BACKEND: 's3',
    })).toThrow(/OBJECT_STORAGE_BUCKET/);
  });

  it('parses a complete private S3 configuration', () => {
    expect(parseEnv({
      ...REQUIRED_ENV,
      NODE_ENV: 'test',
      STORAGE_BACKEND: 's3',
      OBJECT_STORAGE_ACCESS_KEY_ID: 'access',
      OBJECT_STORAGE_BUCKET: 'fluke-private',
      OBJECT_STORAGE_ENDPOINT: 'https://objects.example.com',
      OBJECT_STORAGE_FORCE_PATH_STYLE: 'true',
      OBJECT_STORAGE_REGION: 'us-west-2',
      OBJECT_STORAGE_SECRET_ACCESS_KEY: 'secret',
    })).toMatchObject({
      OBJECT_STORAGE_BUCKET: 'fluke-private',
      OBJECT_STORAGE_FORCE_PATH_STYLE: true,
      STORAGE_BACKEND: 's3',
    });
  });

  it('defaults every Release B capability to false', () => {
    const parsed = parseEnv({ ...REQUIRED_ENV, NODE_ENV: 'test' });

    expect(parsed).toMatchObject({
      ENABLE_ACCOUNTS: false,
      ENABLE_IDENTIFY: false,
      ENABLE_SUBMISSIONS: false,
      IDENTIFIER_MODE: 'disabled',
    });
  });

  it.each([
    ['true', 'server'],
    ['false', 'disabled'],
  ] as const)('maps legacy ENABLE_IDENTIFY=%s to %s mode', (legacy, mode) => {
    expect(parseEnv({
      ...REQUIRED_ENV,
      ENABLE_IDENTIFY: legacy,
      NODE_ENV: 'test',
    }).IDENTIFIER_MODE).toBe(mode);
  });

  it.each(['disabled', 'on-device', 'server'] as const)(
    'accepts explicit IDENTIFIER_MODE=%s without the legacy flag',
    (mode) => {
      expect(parseEnv({
        ...REQUIRED_ENV,
        IDENTIFIER_MODE: mode,
        NODE_ENV: 'test',
      }).IDENTIFIER_MODE).toBe(mode);
    },
  );

  it('rejects conflicting explicit and legacy identifier configuration', () => {
    expect(() => parseEnv({
      ...REQUIRED_ENV,
      ENABLE_IDENTIFY: 'false',
      IDENTIFIER_MODE: 'on-device',
      NODE_ENV: 'test',
    })).toThrow(/IDENTIFIER_MODE.*ENABLE_IDENTIFY/u);
  });

  it('parses only explicit true and false feature values', () => {
    const parsed = parseEnv({
      ...REQUIRED_ENV,
      NODE_ENV: 'development',
      ENABLE_ACCOUNTS: 'true',
      ENABLE_IDENTIFY: 'false',
      ENABLE_SUBMISSIONS: 'true',
    });

    expect(parsed).toMatchObject({
      ENABLE_ACCOUNTS: true,
      ENABLE_IDENTIFY: false,
      ENABLE_SUBMISSIONS: true,
    });
    expect(() => parseEnv({
      ...REQUIRED_ENV,
      ENABLE_SUBMISSIONS: 'yes',
    })).toThrow(/ENABLE_SUBMISSIONS/);
  });

  it('requires explicit public origins in production', () => {
    expect(() => parseEnv({
      ...REQUIRED_ENV,
      NODE_ENV: 'production',
    })).toThrow(/WEB_ORIGIN/);

    expect(() => parseEnv({
      ...REQUIRED_ENV,
      NODE_ENV: 'production',
      WEB_ORIGIN: 'https://fluke.example',
    })).toThrow(/API_PUBLIC_ORIGIN/);
  });

  it.each([
    ['insecure web origin', { WEB_ORIGIN: 'http://fluke.example' }],
    ['local web origin', { WEB_ORIGIN: 'https://localhost:5173' }],
    ['wildcard web origin', { WEB_ORIGIN: 'https://*.fluke.example' }],
    ['insecure API origin', { API_PUBLIC_ORIGIN: 'http://api.fluke.example' }],
    ['local API origin', { API_PUBLIC_ORIGIN: 'https://127.0.0.1:4000' }],
  ])('rejects an unsafe production %s', (_name, override) => {
    expect(() => parseEnv({
      ...SAFE_PRODUCTION_ENV,
      ...override,
    })).toThrow(/origin/i);
  });

  it.each([
    ['ULA fc00::/7 start', 'https://[fc00::1]'],
    ['ULA fd00::/8', 'https://[fd12:3456::1]'],
    ['link-local fe80::/10', 'https://[fe80::1]'],
    ['loopback', 'https://[::1]'],
    ['unspecified', 'https://[::]'],
    ['IPv4-mapped loopback', 'https://[::ffff:127.0.0.1]'],
    ['IPv4-mapped private 10/8', 'https://[::ffff:10.0.0.1]'],
    ['IPv4-mapped private 172.16/12', 'https://[::ffff:172.16.0.1]'],
    ['IPv4-mapped private 192.168/16', 'https://[::ffff:192.168.1.1]'],
    ['IPv4-mapped link-local', 'https://[::ffff:169.254.1.1]'],
  ])('rejects the private or local IPv6 class %s', (_name, origin) => {
    expect(() => parseEnv({
      ...SAFE_PRODUCTION_ENV,
      API_PUBLIC_ORIGIN: origin,
    })).toThrow(/API_PUBLIC_ORIGIN/);
  });

  it('accepts a globally routable IPv6 production origin', () => {
    expect(parseEnv({
      ...SAFE_PRODUCTION_ENV,
      API_PUBLIC_ORIGIN: 'https://[2606:4700:4700::1111]',
    }).API_PUBLIC_ORIGIN).toBe('https://[2606:4700:4700::1111]');
  });

  it.each([
    'ENABLE_ACCOUNTS',
    'ENABLE_IDENTIFY',
    'ENABLE_SUBMISSIONS',
  ] as const)('rejects %s in a production Release A process', (flag) => {
    expect(() => parseEnv({
      ...SAFE_PRODUCTION_ENV,
      [flag]: 'true',
    })).toThrow(new RegExp(flag));
  });

  it('accepts explicit safe production Release A configuration', () => {
    expect(parseEnv(SAFE_PRODUCTION_ENV)).toMatchObject({
      NODE_ENV: 'production',
      WEB_ORIGIN: ['https://fluke.example', 'https://www.fluke.example'],
      API_PUBLIC_ORIGIN: 'https://api.fluke.example',
      ENABLE_ACCOUNTS: false,
      ENABLE_IDENTIFY: false,
      ENABLE_SUBMISSIONS: false,
    });
  });

  it('documents explicit identifier mode with the legacy migration mapping', () => {
    const example = readRepositoryFile('.env.example');

    expect(example).toContain('ENABLE_SUBMISSIONS="false"');
    expect(example).toContain('ENABLE_ACCOUNTS="false"');
    expect(example).toContain('IDENTIFIER_MODE="disabled"');
    expect(example).toContain('ENABLE_IDENTIFY=true maps to server');
    expect(example).not.toMatch(/^ENABLE_IDENTIFY=/mu);
  });

  it('smokes the production container with explicit safe public origins', () => {
    const workflow = readRepositoryFile('.github/workflows/ci.yml');

    expect(workflow).toContain('-e WEB_ORIGIN=https://web.ci.invalid');
    expect(workflow).toContain('-e API_PUBLIC_ORIGIN=https://api.ci.invalid');
  });
});
