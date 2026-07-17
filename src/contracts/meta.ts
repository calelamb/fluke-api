import { z } from 'zod';

export const CapabilitiesSchema = z.object({
  accounts: z.boolean(),
  identification: z.boolean(),
  submissions: z.boolean(),
});

export const PublicErrorCodeSchema = z.enum([
  'VALIDATION_ERROR',
  'NOT_FOUND',
  'UNAUTHORIZED',
  'FORBIDDEN',
  'RATE_LIMITED',
  'CONFLICT',
  'UPSTREAM_UNAVAILABLE',
  'INTERNAL_ERROR',
]);

export const SafeErrorSchema = z.object({
  code: PublicErrorCodeSchema,
  message: z.string().min(1).max(500),
  retryable: z.boolean(),
  requestId: z.string().min(1).max(200),
}).strict();

export type Capabilities = z.infer<typeof CapabilitiesSchema>;
export type SafeError = z.infer<typeof SafeErrorSchema>;
export type PublicErrorCode = z.infer<typeof PublicErrorCodeSchema>;

export const RELEASE_A_CAPABILITIES: Readonly<Capabilities> = Object.freeze(
  CapabilitiesSchema.parse({
    accounts: false,
    identification: false,
    submissions: false,
  }),
);
