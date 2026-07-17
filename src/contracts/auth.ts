import { z } from 'zod';
import { StableIdSchema } from './common.js';

export const AuthAppleRequestSchema = z.object({
  authorizationCode: z.string().min(1).max(4_096),
  fullName: z.string().trim().min(1).max(120).nullable().optional(),
  identityToken: z.string().min(1).max(16_384),
  nonce: z.string().min(32).max(256),
}).strict();

export const AuthenticatedUserSchema = z.object({
  displayName: z.string().max(120).nullable(),
  email: z.string().email().max(320).nullable(),
  id: StableIdSchema,
  role: z.literal('OBSERVER'),
}).strict();

export const AuthAppleResponseSchema = z.object({
  csrfToken: z.string().min(32).max(512),
  user: AuthenticatedUserSchema,
}).strict();

export const DeleteAccountResponseSchema = z.object({
  ok: z.literal(true),
}).strict();

export type AuthAppleRequest = z.infer<typeof AuthAppleRequestSchema>;
export type AuthAppleResponse = z.infer<typeof AuthAppleResponseSchema>;
export type AuthenticatedUser = z.infer<typeof AuthenticatedUserSchema>;
export type DeleteAccountResponse = z.infer<typeof DeleteAccountResponseSchema>;
