import ipaddr from 'ipaddr.js';
import { z } from 'zod';

const DEVELOPMENT_WEB_ORIGINS = 'http://localhost:5174,http://localhost:5173';
const DEVELOPMENT_API_ORIGIN = 'http://localhost:4000';

const featureFlag = z
  .enum(['true', 'false'])
  .default('false')
  .transform((value) => value === 'true');

const originList = z
  .string()
  .min(1)
  .transform((value) =>
    value
      .split(',')
      .map((entry) => entry.trim())
      .filter(Boolean),
  )
  .pipe(z.array(z.string().url()).min(1));

const envSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
    DATABASE_URL: z.string().startsWith('postgresql://'),
    DIRECT_URL: z.string().startsWith('postgresql://'),
    PORT: z.coerce.number().int().positive().default(4000),
    JWT_SECRET: z.string().min(32),
    ADMIN_COOKIE_NAME: z.string().min(1).default('fluke_admin'),
    WEB_ORIGIN: originList.default(DEVELOPMENT_WEB_ORIGINS),
    ENABLE_SUBMISSIONS: featureFlag,
    ENABLE_ACCOUNTS: featureFlag,
    ENABLE_IDENTIFY: featureFlag,

    // Photo storage backend. 'local' writes to apps/api/uploads/ and the API
    // serves them statically; 'r2' is reserved for the R2 adapter (stubbed
    // in src/lib/storage.ts) and requires the R2_* env vars below.
    STORAGE_BACKEND: z.enum(['local', 'r2']).default('local'),
    UPLOADS_DIR: z.string().min(1).default('uploads'),
    /**
     * Absolute origin the API is reachable at, used to build absolute photo
     * URLs returned to the frontend. Defaults to localhost in dev; set to
     * the production API host (e.g. https://api.fluke.example) in prod.
     */
    API_PUBLIC_ORIGIN: z.string().url().default(DEVELOPMENT_API_ORIGIN),
    IDENTIFIER_SERVICE_URL: z.string().url().default('http://localhost:4100'),

    R2_BUCKET: z.string().optional(),
    R2_ENDPOINT: z.string().url().optional(),
    R2_ACCESS_KEY_ID: z.string().optional(),
    R2_SECRET_ACCESS_KEY: z.string().optional(),
    R2_PUBLIC_HOST: z.string().url().optional(),
  })
  .superRefine((value, ctx) => {
    if (value.STORAGE_BACKEND === 'r2') {
      const required = ['R2_BUCKET', 'R2_ENDPOINT', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'R2_PUBLIC_HOST'] as const;
      for (const key of required) {
        if (!value[key]) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: [key],
            message: `STORAGE_BACKEND=r2 requires ${key}`,
          });
        }
      }
    }
  });

export type Env = z.infer<typeof envSchema>;

const LOCAL_IP_RANGES = [
  'linkLocal',
  'loopback',
  'private',
  'uniqueLocal',
  'unspecified',
] as const;

function isPrivateOrLocalIp(hostname: string): boolean {
  const address = hostname.startsWith('[') && hostname.endsWith(']')
    ? hostname.slice(1, -1)
    : hostname;
  if (!ipaddr.isValid(address)) {
    return false;
  }

  const range = ipaddr.process(address).range();
  return (LOCAL_IP_RANGES as readonly string[]).includes(range);
}

function productionOriginIssue(origin: string): string | null {
  const parsed = new URL(origin);
  const hostname = parsed.hostname.toLowerCase();
  const isLocalName = hostname === 'localhost'
    || hostname.endsWith('.localhost')
    || hostname.endsWith('.local')
    || hostname.endsWith('.internal');

  if (parsed.protocol !== 'https:') {
    return 'must use HTTPS';
  }
  if (hostname.includes('*')) {
    return 'must not contain a wildcard host';
  }
  if (isLocalName || isPrivateOrLocalIp(hostname)) {
    return 'must use a non-local public host';
  }
  if (parsed.username || parsed.password) {
    return 'must not include credentials';
  }
  if (parsed.pathname !== '/' || parsed.search || parsed.hash) {
    return 'must be an origin without a path, query, or fragment';
  }

  return null;
}

function productionIssues(input: NodeJS.ProcessEnv, parsed: Env): readonly string[] {
  if (parsed.NODE_ENV !== 'production') {
    return [];
  }

  const issues: string[] = [];
  if (!input.WEB_ORIGIN) {
    issues.push('WEB_ORIGIN: is required explicitly in production');
  } else {
    for (const origin of parsed.WEB_ORIGIN) {
      const issue = productionOriginIssue(origin);
      if (issue) {
        issues.push(`WEB_ORIGIN: origin ${origin} ${issue}`);
      }
    }
  }

  if (!input.API_PUBLIC_ORIGIN) {
    issues.push('API_PUBLIC_ORIGIN: is required explicitly in production');
  } else {
    const issue = productionOriginIssue(parsed.API_PUBLIC_ORIGIN);
    if (issue) {
      issues.push(`API_PUBLIC_ORIGIN: origin ${parsed.API_PUBLIC_ORIGIN} ${issue}`);
    }
  }

  const releaseBFlags = [
    ['ENABLE_ACCOUNTS', parsed.ENABLE_ACCOUNTS],
    ['ENABLE_IDENTIFY', parsed.ENABLE_IDENTIFY],
    ['ENABLE_SUBMISSIONS', parsed.ENABLE_SUBMISSIONS],
  ] as const;
  for (const [name, enabled] of releaseBFlags) {
    if (enabled) {
      issues.push(`${name}: must remain false in production Release A`);
    }
  }

  return issues;
}

function formatEnvironmentError(issues: readonly string[]): Error {
  const details = issues.map((issue) => `- ${issue}`).join('\n');
  return new Error(
    `Invalid API environment.\n${details}\n\nCopy .env.example to .env and fill in the database connection strings, JWT_SECRET, and WEB_ORIGIN.`,
  );
}

export function parseEnv(input: NodeJS.ProcessEnv): Env {
  const parsedEnv = envSchema.safeParse(input);

  if (!parsedEnv.success) {
    throw formatEnvironmentError(
      parsedEnv.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`),
    );
  }

  const releaseIssues = productionIssues(input, parsedEnv.data);
  if (releaseIssues.length > 0) {
    throw formatEnvironmentError(releaseIssues);
  }

  return parsedEnv.data;
}

export const env = parseEnv(process.env);
export const isProduction = env.NODE_ENV === 'production';
