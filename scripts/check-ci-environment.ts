import { env } from '../src/env.js';

if (
  env.NODE_ENV !== 'test'
  || env.ENABLE_ACCOUNTS
  || env.IDENTIFIER_MODE !== 'disabled'
  || env.ENABLE_SUBMISSIONS
) {
  throw new Error('CI test environment must collect in the all-off test configuration');
}
