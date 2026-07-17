import { env } from '../src/env.js';

if (
  env.NODE_ENV !== 'test'
  || env.ENABLE_ACCOUNTS
  || env.ENABLE_IDENTIFY
  || env.ENABLE_SUBMISSIONS
) {
  throw new Error('CI test environment must collect in the all-off test configuration');
}
