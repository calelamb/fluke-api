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

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  DATABASE_URL: z.string().startsWith('postgresql://'),
  DIRECT_URL: z.string().startsWith('postgresql://'),
  PORT: z.coerce.number().int().positive().default(4000),
  JWT_SECRET: z.string().min(32),
  ADMIN_COOKIE_NAME: z.string().min(1).default('fluke_admin'),
  WEB_ORIGIN: originList.default('http://localhost:5173'),
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
