interface CiSeedEnvironment {
  readonly [key: string]: string | undefined;
}

const EXPECTED_DATABASE = '/fluke_test';
const EXPECTED_HOST = 'localhost';
const EXPECTED_PORT = '5432';
const EXPECTED_USER = 'fluke';

function isIsolatedCiDatabase(value: string | undefined): boolean {
  if (value === undefined) return false;
  try {
    const url = new URL(value);
    return url.protocol === 'postgresql:'
      && url.hostname === EXPECTED_HOST
      && url.port === EXPECTED_PORT
      && url.pathname === EXPECTED_DATABASE
      && url.username === EXPECTED_USER;
  } catch {
    return false;
  }
}

export function assertCiIdentifierReleaseSeedAllowed(env: CiSeedEnvironment): void {
  const databaseUrl = env.DATABASE_URL;
  if (
    env.CI !== 'true'
    || env.GITHUB_ACTIONS !== 'true'
    || env.NODE_ENV !== 'test'
    || env.IDENTIFIER_MODE !== 'disabled'
    || !isIsolatedCiDatabase(databaseUrl)
    || !isIsolatedCiDatabase(env.DIRECT_URL)
    || databaseUrl !== env.DIRECT_URL
  ) {
    throw new Error('CI identifier release fixture refused: isolated test database required.');
  }
}
