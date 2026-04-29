import { z } from 'zod';

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
    WEB_ORIGIN: originList.default('http://localhost:5174,http://localhost:5173'),

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
    API_PUBLIC_ORIGIN: z.string().url().default('http://localhost:4000'),

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

const parsedEnv = envSchema.safeParse(process.env);

if (!parsedEnv.success) {
  const details = parsedEnv.error.issues
    .map((issue) => `- ${issue.path.join('.')}: ${issue.message}`)
    .join('\n');

  throw new Error(
    `Invalid API environment.\n${details}\n\nCopy apps/api/.env.example to apps/api/.env and fill in the Neon connection strings, JWT_SECRET, and WEB_ORIGIN.`,
  );
}

export const env = parsedEnv.data;
export const isProduction = env.NODE_ENV === 'production';
