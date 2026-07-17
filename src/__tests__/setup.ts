// Set required env vars before any module imports env.ts.
// Tests mock the Prisma client, so DATABASE_URL/DIRECT_URL are placeholders only.
process.env.NODE_ENV = 'test';
process.env.DATABASE_URL ??= 'postgresql://test:test@localhost:5432/test';
process.env.DIRECT_URL ??= 'postgresql://test:test@localhost:5432/test';
process.env.JWT_SECRET ??= 'test_jwt_secret_must_be_at_least_32_chars_long';
process.env.WEB_ORIGIN ??= 'http://localhost:5173';
process.env.PORT ??= '4001';
// Legacy route suites opt into Release B surfaces explicitly. Release A
// firewall tests build their own all-false immutable feature configuration.
process.env.ENABLE_ACCOUNTS = 'true';
process.env.ENABLE_IDENTIFY = 'true';
process.env.ENABLE_SUBMISSIONS = 'true';
