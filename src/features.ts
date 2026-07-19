import {
  CapabilitiesSchema,
  type Capabilities,
} from './contracts/index.js';
import { env, type Env } from './env.js';

export type FeatureConfig = Readonly<Capabilities>;

type FeatureEnvironment = Pick<
  Env,
  'ENABLE_ACCOUNTS' | 'ENABLE_SUBMISSIONS' | 'IDENTIFIER_MODE'
>;

export function createFeatureConfig(input: FeatureEnvironment): FeatureConfig {
  return Object.freeze(CapabilitiesSchema.parse({
    accounts: input.ENABLE_ACCOUNTS,
    identification: input.IDENTIFIER_MODE !== 'disabled',
    identificationMode: input.IDENTIFIER_MODE,
    submissions: input.ENABLE_SUBMISSIONS,
  }));
}

export function validateFeatureConfig(input: Capabilities): FeatureConfig {
  return Object.freeze(CapabilitiesSchema.parse(input));
}

export const features = createFeatureConfig(env);
