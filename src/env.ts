import ipaddr from 'ipaddr.js';
import { z } from 'zod';
import { objectStorageEndpointIssue } from './lib/storage-endpoint.js';

const DEVELOPMENT_WEB_ORIGINS = 'http://localhost:5174,http://localhost:5173';
const DEVELOPMENT_API_ORIGIN = 'http://localhost:4000';
const FIXED_OBSERVER_COOKIE_NAMES = new Set(['fluke_observer', 'fluke_csrf']);
const RFC_COOKIE_TOKEN_PATTERN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/u;

const adminCookieName = z
  .string()
  .min(1)
  .max(128)
  .regex(RFC_COOKIE_TOKEN_PATTERN, 'must be an RFC cookie-token-safe name')
  .refine(
    (value) => !FIXED_OBSERVER_COOKIE_NAMES.has(value),
    'must not collide with a fixed observer cookie name',
  )
  .refine(
    (value) => !value.startsWith('__Host-') && !value.startsWith('__Secure-'),
    'must not use a security prefix because local non-TLS development cannot honor it',
  );

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
    ADMIN_COOKIE_NAME: adminCookieName.default('fluke_admin'),
    WEB_ORIGIN: originList.default(DEVELOPMENT_WEB_ORIGINS),
    ENABLE_SUBMISSIONS: featureFlag,
    ENABLE_ACCOUNTS: featureFlag,
    ENABLE_IDENTIFY: featureFlag,

    // Local storage is restricted to development/test. Production mutation
    // processes must select the private S3-compatible adapter.
    STORAGE_BACKEND: z.enum(['local', 's3']).default('local'),
    UPLOADS_DIR: z.string().min(1).default('uploads'),
    /**
     * Absolute origin the API is reachable at, used to build absolute photo
     * URLs returned to the frontend. Defaults to localhost in dev; set to
     * the production API host (e.g. https://api.fluke.example) in prod.
     */
    API_PUBLIC_ORIGIN: z.string().url().default(DEVELOPMENT_API_ORIGIN),
    IDENTIFIER_SERVICE_URL: z.string().url().default('http://localhost:4100'),

    OBJECT_STORAGE_BUCKET: z.string().min(3).max(63).optional(),
    OBJECT_STORAGE_REGION: z.string().min(1).max(64).optional(),
    OBJECT_STORAGE_ENDPOINT: z.string().url().optional(),
    OBJECT_STORAGE_ACCESS_KEY_ID: z.string().min(1).max(256).optional(),
    OBJECT_STORAGE_SECRET_ACCESS_KEY: z.string().min(1).max(1_024).optional(),
    OBJECT_STORAGE_FORCE_PATH_STYLE: z
      .enum(['true', 'false'])
      .transform((value) => value === 'true')
      .optional(),
  })
  .superRefine((value, ctx) => {
    const storageKeys = [
      'OBJECT_STORAGE_BUCKET',
      'OBJECT_STORAGE_REGION',
      'OBJECT_STORAGE_ENDPOINT',
      'OBJECT_STORAGE_ACCESS_KEY_ID',
      'OBJECT_STORAGE_SECRET_ACCESS_KEY',
      'OBJECT_STORAGE_FORCE_PATH_STYLE',
    ] as const;
    const configuredStorageValues = storageKeys.filter((key) => value[key] !== undefined);
    if (configuredStorageValues.length > 0 && configuredStorageValues.length < storageKeys.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['OBJECT_STORAGE'],
        message: 'OBJECT_STORAGE_* values must be configured all-or-none',
      });
    }
    if (value.STORAGE_BACKEND === 's3') {
      for (const key of storageKeys) {
        if (value[key] === undefined) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: [key],
            message: `STORAGE_BACKEND=s3 requires ${key}`,
          });
        }
      }
      if (value.OBJECT_STORAGE_ENDPOINT) {
        const issue = objectStorageEndpointIssue(value.OBJECT_STORAGE_ENDPOINT);
        if (issue) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['OBJECT_STORAGE_ENDPOINT'],
            message: `object storage endpoint ${issue}`,
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
  if (parsed.STORAGE_BACKEND !== 's3') {
    issues.push('STORAGE_BACKEND: production requires private S3-compatible storage');
  }
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
