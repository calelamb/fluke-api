interface CiSeedEnvironment {
  readonly [key: string]: string | undefined;
}

const EXPECTED_CI_DATABASE_URL =
  'postgresql://fluke:fluke_test_password@localhost:5432/fluke_test';

export function assertCiIdentifierReleaseSeedAllowed(env: CiSeedEnvironment): void {
  const databaseUrl = env.DATABASE_URL;
  if (
    env.CI !== 'true'
    || env.GITHUB_ACTIONS !== 'true'
    || env.NODE_ENV !== 'test'
    || env.IDENTIFIER_MODE !== 'disabled'
    || databaseUrl !== EXPECTED_CI_DATABASE_URL
    || env.DIRECT_URL !== EXPECTED_CI_DATABASE_URL
  ) {
    throw new Error('CI identifier release fixture refused: isolated test database required.');
  }
}
