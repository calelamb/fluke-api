import { z } from 'zod';

export const CapabilitiesSchema = z.object({
  accounts: z.boolean(),
  identification: z.boolean(),
  submissions: z.boolean(),
});

export const SafeErrorSchema = z.object({
  error: z.string().min(1),
});

export type Capabilities = z.infer<typeof CapabilitiesSchema>;
export type SafeError = z.infer<typeof SafeErrorSchema>;

export const RELEASE_A_CAPABILITIES: Readonly<Capabilities> = Object.freeze(
  CapabilitiesSchema.parse({
    accounts: false,
    identification: false,
    submissions: false,
  }),
);
