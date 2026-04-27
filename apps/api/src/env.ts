import { z } from 'zod';

const envSchema = z.object({
  DATABASE_URL: z.string().startsWith('postgresql://'),
  DIRECT_URL: z.string().startsWith('postgresql://'),
  PORT: z.coerce.number().int().positive().default(4000),
});

const parsedEnv = envSchema.safeParse(process.env);

if (!parsedEnv.success) {
  const details = parsedEnv.error.issues
    .map((issue) => `- ${issue.path.join('.')}: ${issue.message}`)
    .join('\n');

  throw new Error(
    `Invalid API environment.\n${details}\n\nCopy apps/api/.env.example to apps/api/.env and fill in the Neon connection strings.`,
  );
}

export const env = parsedEnv.data;
