import { randomUUID } from 'node:crypto';

const SAFE_REQUEST_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/u;

export function resolveRequestId(header: string | string[] | undefined): string {
  if (typeof header === 'string' && SAFE_REQUEST_ID.test(header)) {
    return header;
  }

  return randomUUID();
}
