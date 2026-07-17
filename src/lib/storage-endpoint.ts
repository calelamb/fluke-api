import ipaddr from 'ipaddr.js';

const BLOCKED_IP_RANGES = new Set([
  'broadcast',
  'carrierGradeNat',
  'linkLocal',
  'loopback',
  'multicast',
  'private',
  'reserved',
  'uniqueLocal',
  'unspecified',
]);

export function objectStorageEndpointIssue(endpoint: string): string | null {
  const parsed = new URL(endpoint);
  const hostname = parsed.hostname.replace(/^\[|\]$/gu, '').toLowerCase();
  if (parsed.protocol !== 'https:') return 'endpoint must use HTTPS';
  if (parsed.username || parsed.password) return 'endpoint must not contain credentials';
  if (parsed.pathname !== '/' || parsed.search || parsed.hash) {
    return 'endpoint must not contain a path, query, or fragment';
  }
  if (
    hostname === 'localhost'
    || hostname.endsWith('.localhost')
    || hostname.endsWith('.local')
    || hostname.endsWith('.internal')
  ) {
    return 'endpoint must not use a local hostname';
  }
  if (ipaddr.isValid(hostname) && BLOCKED_IP_RANGES.has(ipaddr.process(hostname).range())) {
    return 'endpoint must not use a private, local, multicast, or reserved address';
  }
  return null;
}
