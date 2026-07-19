import { z } from 'zod';
import { IsoDateTimeSchema } from './common.js';

export const IdentificationModeSchema = z.enum(['disabled', 'on-device', 'server']);

export const CapabilitiesSchema = z.object({
  accounts: z.boolean(),
  identification: z.boolean(),
  identificationMode: IdentificationModeSchema,
  submissions: z.boolean(),
}).strict().superRefine((capabilities, context) => {
  if (capabilities.identification !== (capabilities.identificationMode !== 'disabled')) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'identification must match identificationMode availability',
      path: ['identification'],
    });
  }
});

export const HealthSchema = z.object({
  status: z.literal('ok'),
  timestamp: IsoDateTimeSchema,
}).strict();

export const ReadinessSchema = z.object({
  status: z.literal('ready'),
}).strict();

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
export type IdentificationMode = z.infer<typeof IdentificationModeSchema>;
export type Health = z.infer<typeof HealthSchema>;
export type Readiness = z.infer<typeof ReadinessSchema>;
export type SafeError = z.infer<typeof SafeErrorSchema>;
export type PublicErrorCode = z.infer<typeof PublicErrorCodeSchema>;

export const RELEASE_A_CAPABILITIES: Readonly<Capabilities> = Object.freeze(
  CapabilitiesSchema.parse({
    accounts: false,
    identification: false,
    identificationMode: 'disabled',
    submissions: false,
  }),
);
