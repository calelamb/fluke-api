import {
  CapabilitiesSchema,
  type Capabilities,
} from './contracts/index.js';
import { env, type Env } from './env.js';

export type FeatureConfig = Readonly<Capabilities>;

type FeatureEnvironment = Pick<
  Env,
  'ENABLE_ACCOUNTS' | 'ENABLE_IDENTIFY' | 'ENABLE_SUBMISSIONS'
>;

export function createFeatureConfig(input: FeatureEnvironment): FeatureConfig {
  return Object.freeze(CapabilitiesSchema.parse({
    accounts: input.ENABLE_ACCOUNTS,
    identification: input.ENABLE_IDENTIFY,
    submissions: input.ENABLE_SUBMISSIONS,
  }));
}

export function validateFeatureConfig(input: Capabilities): FeatureConfig {
  return Object.freeze(CapabilitiesSchema.parse(input));
}

export const features = createFeatureConfig(env);
