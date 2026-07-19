import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { generateKeyPairSync } from 'node:crypto';
import { parse as parseDotEnv } from 'dotenv';
import { describe, expect, it } from 'vitest';
import { parseEnv } from '../src/env.js';
import { createFeatureConfig, validateFeatureConfig } from '../src/features.js';

const REQUIRED_ENV: NodeJS.ProcessEnv = {
  DATABASE_URL: 'postgresql://test:test@localhost:5432/test',
  DIRECT_URL: 'postgresql://test:test@localhost:5432/test',
  JWT_SECRET: 'x'.repeat(32),
};
const repositoryRoot = fileURLToPath(new URL('../', import.meta.url));

function generateEcPrivateKey(namedCurve: string): string {
  return generateKeyPairSync('ec', {
    namedCurve,
    privateKeyEncoding: { format: 'pem', type: 'pkcs8' },
    publicKeyEncoding: { format: 'pem', type: 'spki' },
  }).privateKey;
}

function generateSec1PrivateKey(): string {
  return generateKeyPairSync('ec', {
    namedCurve: 'prime256v1',
    privateKeyEncoding: { format: 'pem', type: 'sec1' },
    publicKeyEncoding: { format: 'pem', type: 'spki' },
  }).privateKey;
}

function generateEncryptedPrivateKey(): string {
  return generateKeyPairSync('ec', {
    namedCurve: 'prime256v1',
    privateKeyEncoding: {
      cipher: 'aes-256-cbc',
      format: 'pem',
      passphrase: 'test-only-passphrase',
      type: 'pkcs8',
    },
    publicKeyEncoding: { format: 'pem', type: 'spki' },
  }).privateKey;
}

const VALID_APPLE_PRIVATE_KEY = generateEcPrivateKey('prime256v1');

const SAFE_RELEASE_B_ENV: NodeJS.ProcessEnv = {
  ...REQUIRED_ENV,
  NODE_ENV: 'production',
  WEB_ORIGIN: 'https://fluke.example',
  API_PUBLIC_ORIGIN: 'https://api.fluke.example',
  ENABLE_ACCOUNTS: 'true',
  ENABLE_SUBMISSIONS: 'true',
  ENABLE_IDENTIFY: 'false',
  PRODUCTION_MUTATIONS_ACK: 'true',
  STORAGE_BACKEND: 's3',
  OBJECT_STORAGE_ACCESS_KEY_ID: 'access',
  OBJECT_STORAGE_BUCKET: 'fluke-private',
  OBJECT_STORAGE_ENDPOINT: 'https://objects.example.com',
  OBJECT_STORAGE_FORCE_PATH_STYLE: 'true',
  OBJECT_STORAGE_REGION: 'us-west-2',
  OBJECT_STORAGE_SECRET_ACCESS_KEY: 'secret',
  APPLE_CLIENT_ID: 'app.fluke.Fluke',
  APPLE_TEAM_ID: '86RBV2JZ8F',
  APPLE_KEY_ID: 'ABC123DEFG',
  APPLE_PRIVATE_KEY: VALID_APPLE_PRIVATE_KEY,
  APPLE_TOKEN_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64'),
  OBSERVER_JWT_SECRET: 'j'.repeat(43),
  OBSERVER_CSRF_SECRET: 'c'.repeat(43),
};

describe('Release B production capability configuration', () => {
  it.each([
    { ENABLE_ACCOUNTS: 'true', ENABLE_SUBMISSIONS: 'false' },
    { ENABLE_ACCOUNTS: 'false', ENABLE_SUBMISSIONS: 'true' },
    { ENABLE_ACCOUNTS: 'true', ENABLE_SUBMISSIONS: 'true', ENABLE_IDENTIFY: 'true' },
  ])('rejects unsafe production capability combinations', (flags) => {
    expect(() => parseEnv({ ...SAFE_RELEASE_B_ENV, ...flags })).toThrow();
  });

  it('accepts accounts plus submissions with identify disabled and all dependencies', () => {
    const env = parseEnv(SAFE_RELEASE_B_ENV);

    expect(createFeatureConfig(env)).toEqual({
      accounts: true,
      identification: false,
      identificationMode: 'disabled',
      submissions: true,
    });
  });

  it('rejects server inference but accepts on-device identification in production', () => {
    expect(() => parseEnv({
      ...SAFE_RELEASE_B_ENV,
      ENABLE_IDENTIFY: undefined,
      IDENTIFIER_MODE: 'server',
    })).toThrow(/IDENTIFIER_MODE.*server/u);

    const onDevice = parseEnv({
      ...SAFE_RELEASE_B_ENV,
      ENABLE_IDENTIFY: undefined,
      IDENTIFIER_MODE: 'on-device',
    });
    expect(createFeatureConfig(onDevice)).toMatchObject({
      identification: true,
      identificationMode: 'on-device',
    });
  });

  it('rejects production on-device mode without the submission surface', () => {
    expect(() => parseEnv({
      ...SAFE_RELEASE_B_ENV,
      ENABLE_ACCOUNTS: 'false',
      ENABLE_IDENTIFY: undefined,
      ENABLE_SUBMISSIONS: 'false',
      IDENTIFIER_MODE: 'on-device',
      PRODUCTION_MUTATIONS_ACK: 'false',
    })).toThrow(/IDENTIFIER_MODE.*submissions/u);
  });

  it('reports identification available in both compute modes', () => {
    const onDevice = parseEnv({
      ...REQUIRED_ENV,
      IDENTIFIER_MODE: 'on-device',
      NODE_ENV: 'test',
    });
    const server = parseEnv({
      ...REQUIRED_ENV,
      IDENTIFIER_MODE: 'server',
      NODE_ENV: 'test',
    });

    expect(createFeatureConfig(onDevice)).toMatchObject({
      identification: true,
      identificationMode: 'on-device',
    });
    expect(createFeatureConfig(server)).toMatchObject({
      identification: true,
      identificationMode: 'server',
    });
  });

  it('rejects a capability boolean that contradicts the declared mode', () => {
    expect(() => validateFeatureConfig({
      accounts: false,
      identification: false,
      identificationMode: 'on-device',
      submissions: true,
    })).toThrow(/identification must match identificationMode/u);
  });

  it.each([
    'PRODUCTION_MUTATIONS_ACK',
    'APPLE_CLIENT_ID',
    'APPLE_TEAM_ID',
    'APPLE_KEY_ID',
    'APPLE_PRIVATE_KEY',
    'APPLE_TOKEN_ENCRYPTION_KEY',
    'OBSERVER_JWT_SECRET',
    'OBSERVER_CSRF_SECRET',
    'OBJECT_STORAGE_BUCKET',
    'OBJECT_STORAGE_REGION',
    'OBJECT_STORAGE_ENDPOINT',
    'OBJECT_STORAGE_ACCESS_KEY_ID',
    'OBJECT_STORAGE_SECRET_ACCESS_KEY',
  ] as const)('rejects safe Release B when %s is absent or false', (name) => {
    const input = { ...SAFE_RELEASE_B_ENV };
    if (name === 'PRODUCTION_MUTATIONS_ACK') input[name] = 'false';
    else delete input[name];

    expect(() => parseEnv(input)).toThrow(new RegExp(name));
  });

  it.each([
    ['wrong Apple client', { APPLE_CLIENT_ID: 'app.example.other' }],
    ['wrong Apple team', { APPLE_TEAM_ID: 'ABCDEFGHIJ' }],
    ['malformed Apple key id', { APPLE_KEY_ID: 'short' }],
    ['malformed Apple private key', { APPLE_PRIVATE_KEY: 'secret' }],
    ['malformed encryption key', { APPLE_TOKEN_ENCRYPTION_KEY: 'not-base64' }],
    ['short observer JWT secret', { OBSERVER_JWT_SECRET: 'short' }],
    ['short observer CSRF secret', { OBSERVER_CSRF_SECRET: 'short' }],
  ])('rejects %s', (_name, override) => {
    expect(() => parseEnv({ ...SAFE_RELEASE_B_ENV, ...override })).toThrow();
  });

  it.each([
    [
      'malformed PKCS#8 content',
      '-----BEGIN PRIVATE KEY-----\nnot-a-real-key\n-----END PRIVATE KEY-----',
    ],
    [
      'an RSA PKCS#8 key',
      generateKeyPairSync('rsa', {
        modulusLength: 2048,
        privateKeyEncoding: { format: 'pem', type: 'pkcs8' },
        publicKeyEncoding: { format: 'pem', type: 'spki' },
      }).privateKey,
    ],
    ['an EC key on the wrong curve', generateEcPrivateKey('secp384r1')],
    ['a P-256 SEC1 key', generateSec1PrivateKey()],
    ['an encrypted P-256 PKCS#8 key', generateEncryptedPrivateKey()],
    ['a PKCS#8 key with trailing content', `${VALID_APPLE_PRIVATE_KEY}trailing-content`],
  ])('rejects %s for Apple ES256 client secrets', (_name, privateKey) => {
    expect(() => parseEnv({
      ...SAFE_RELEASE_B_ENV,
      APPLE_PRIVATE_KEY: privateKey,
    })).toThrow(/APPLE_PRIVATE_KEY/);
  });

  it('rejects a partial dormant observer dependency block', () => {
    expect(() => parseEnv({
      ...REQUIRED_ENV,
      NODE_ENV: 'test',
      APPLE_CLIENT_ID: 'app.fluke.Fluke',
    })).toThrow(/APPLE/);

    expect(() => parseEnv({
      ...REQUIRED_ENV,
      NODE_ENV: 'test',
      OBSERVER_JWT_SECRET: 'j'.repeat(43),
    })).toThrow(/OBSERVER/);
  });

  it('rejects a production mutation acknowledgement while capabilities remain off', () => {
    expect(() => parseEnv({
      ...SAFE_RELEASE_B_ENV,
      ENABLE_ACCOUNTS: 'false',
      ENABLE_SUBMISSIONS: 'false',
    })).toThrow(/PRODUCTION_MUTATIONS_ACK/);
  });

  it('defaults the mutation acknowledgement and path-style option to false', () => {
    const parsed = parseEnv({
      ...REQUIRED_ENV,
      NODE_ENV: 'test',
    });

    expect(parsed.PRODUCTION_MUTATIONS_ACK).toBe(false);
    expect(parsed.OBJECT_STORAGE_FORCE_PATH_STYLE).toBe(false);
  });

  it('documents safe defaults, exact Apple identifiers, and three secret generation commands', () => {
    const example = readFileSync(`${repositoryRoot}.env.example`, 'utf8');

    expect(example).toContain('PRODUCTION_MUTATIONS_ACK="false"');
    expect(example).toContain('APPLE_CLIENT_ID="app.fluke.Fluke"');
    expect(example).toContain('APPLE_TEAM_ID="86RBV2JZ8F"');
    for (const name of [
      'APPLE_TOKEN_ENCRYPTION_KEY',
      'OBSERVER_JWT_SECRET',
      'OBSERVER_CSRF_SECRET',
    ]) {
      expect(example).toContain(`# ${name}: openssl rand -base64 32`);
    }
    expect(example).not.toContain('BEGIN PRIVATE KEY');
  });

  it('keeps the copied environment example valid with Release B secrets unset', () => {
    const example = readFileSync(`${repositoryRoot}.env.example`, 'utf8');
    const parsed = parseEnv(parseDotEnv(example));

    expect(createFeatureConfig(parsed)).toEqual({
      accounts: false,
      identification: false,
      identificationMode: 'disabled',
      submissions: false,
    });
  });
});
