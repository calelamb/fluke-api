import { decodeJwt, decodeProtectedHeader, exportJWK, exportPKCS8, generateKeyPair, SignJWT, type JWK } from 'jose';
import { beforeAll, describe, expect, it, vi } from 'vitest';

import {
  AppleAuthError,
  AppleAuthService,
  type AppleAuthConfig,
  type AppleFetch,
} from '../services/apple-auth.js';

const NOW = new Date('2026-07-17T12:00:00.000Z');
const CLIENT_ID = 'app.fluke.Fluke';
const SUBJECT = 'apple-user-123';
let applePrivateKey: Awaited<ReturnType<typeof generateKeyPair>>['privateKey'];
let applePublicJwk: JWK;
let clientPrivateKeyPem: string;

beforeAll(async () => {
  const appleKeys = await generateKeyPair('RS256', { extractable: true });
  applePrivateKey = appleKeys.privateKey;
  applePublicJwk = { ...await exportJWK(appleKeys.publicKey), kid: 'apple-key', alg: 'RS256', use: 'sig' };
  const clientKeys = await generateKeyPair('ES256', { extractable: true });
  clientPrivateKeyPem = await exportPKCS8(clientKeys.privateKey);
});

function config(overrides: Partial<AppleAuthConfig> = {}): AppleAuthConfig {
  return {
    clientId: CLIENT_ID,
    teamId: '86RBV2JZ8F',
    keyId: 'APPLEKEY01',
    privateKeyPem: clientPrivateKeyPem,
    fetchTimeoutMs: 5_000,
    ...overrides,
  };
}

async function identityToken(overrides: {
  audience?: string;
  expiresAt?: number;
  issuer?: string;
  nonce?: string;
  subject?: string;
} = {}): Promise<string> {
  const issuedAt = Math.floor(NOW.getTime() / 1_000);
  return new SignJWT({ nonce: overrides.nonce ?? 'client-nonce' })
    .setProtectedHeader({ alg: 'RS256', kid: 'apple-key' })
    .setIssuer(overrides.issuer ?? 'https://appleid.apple.com')
    .setAudience(overrides.audience ?? CLIENT_ID)
    .setSubject(overrides.subject ?? SUBJECT)
    .setIssuedAt(issuedAt)
    .setExpirationTime(overrides.expiresAt ?? issuedAt + 300)
    .sign(applePrivateKey);
}

function jwksForAppleKey(): (protectedHeader: { kid?: string }) => Promise<JWK> {
  return async (protectedHeader) => {
    if (protectedHeader.kid !== 'apple-key') {
      throw new Error('unknown key');
    }
    return applePublicJwk;
  };
}

function service(fetchImplementation?: AppleFetch): AppleAuthService {
  return new AppleAuthService(config(), {
    fetch: fetchImplementation,
    jwks: jwksForAppleKey(),
    now: () => NOW,
  });
}

describe('AppleAuthService identity verification', () => {
  it('accepts a signed token with exact issuer, audience, nonce, expiry, and subject', async () => {
    await expect(service().verifyAppleIdentityToken(await identityToken(), 'client-nonce'))
      .resolves.toMatchObject({ subject: SUBJECT });
  });

  it.each([
    ['wrong nonce', { nonce: 'other' }, 'client-nonce'],
    ['wrong audience', { audience: 'app.other' }, 'client-nonce'],
    ['wrong issuer', { issuer: 'https://attacker.example' }, 'client-nonce'],
    ['expired token', { expiresAt: Math.floor(NOW.getTime() / 1_000) - 1 }, 'client-nonce'],
    ['blank subject', { subject: '' }, 'client-nonce'],
  ] as const)('rejects %s with a sanitized stable error', async (_label, overrides, expectedNonce) => {
    const token = await identityToken(overrides);
    try {
      await service().verifyAppleIdentityToken(token, expectedNonce);
      throw new Error('expected verification to fail');
    } catch (error: unknown) {
      expect(error).toMatchObject({ code: 'APPLE_TOKEN_INVALID' });
      expect(String(error)).not.toContain(token);
      expect(String(error)).not.toContain(SUBJECT);
    }
  });

  it('rejects an empty expected nonce before JWT verification', async () => {
    await expect(service().verifyAppleIdentityToken(await identityToken(), ''))
      .rejects.toMatchObject({ code: 'APPLE_TOKEN_INVALID' });
  });
});

describe('AppleAuthService token endpoint', () => {
  it('exchanges a single-use code with the exact native client id and bounded signal', async () => {
    const endpointIdentityToken = await identityToken({ nonce: '' });
    const fetchMock = vi.fn<AppleFetch>(async () => new Response(JSON.stringify({
      access_token: 'access-value',
      expires_in: 3600,
      id_token: endpointIdentityToken,
      refresh_token: 'refresh-value',
      token_type: 'Bearer',
    }), { status: 200, headers: { 'content-type': 'application/json' } }));

    const result = await service(fetchMock).exchangeAppleAuthorizationCode('single-use-code', SUBJECT);

    expect(result).toMatchObject({ refreshToken: 'refresh-value', subject: SUBJECT });
    expect(fetchMock).toHaveBeenCalledWith(
      'https://appleid.apple.com/auth/token',
      expect.objectContaining({ method: 'POST', signal: expect.any(AbortSignal) }),
    );
    const body = String(fetchMock.mock.calls[0]?.[1]?.body);
    expect(body).toContain(`client_id=${CLIENT_ID}`);
    expect(body).toContain('grant_type=authorization_code');
    expect(body).toContain('code=single-use-code');
    expect(body).toContain('client_secret=');
    const clientSecret = new URLSearchParams(body).get('client_secret');
    expect(clientSecret).not.toBeNull();
    const claims = decodeJwt(clientSecret ?? '');
    expect(decodeProtectedHeader(clientSecret ?? '')).toMatchObject({ alg: 'ES256', kid: 'APPLEKEY01' });
    expect(claims).toMatchObject({ aud: 'https://appleid.apple.com', iss: '86RBV2JZ8F', sub: CLIENT_ID });
    expect(Number(claims.exp) - Number(claims.iat)).toBe(180 * 24 * 60 * 60);
  });

  it.each(['', ' padded-code ', 'x'.repeat(16_385)])('rejects an invalid authorization code without fetching', async (code) => {
    const fetchMock = vi.fn<AppleFetch>();
    await expect(service(fetchMock).exchangeAppleAuthorizationCode(code, SUBJECT))
      .rejects.toMatchObject({ code: 'APPLE_CREDENTIAL_INVALID' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects when the token response identity does not match the verified subject', async () => {
    const endpointIdentityToken = await identityToken({ nonce: '', subject: 'different-user' });
    const fetchMock: AppleFetch = async () => new Response(JSON.stringify({
      access_token: 'access-value', id_token: endpointIdentityToken, refresh_token: 'refresh-value', token_type: 'Bearer', expires_in: 3600,
    }), { status: 200 });

    await expect(service(fetchMock).exchangeAppleAuthorizationCode('code', SUBJECT))
      .rejects.toMatchObject({ code: 'APPLE_TOKEN_INVALID' });
  });

  it('revokes a refresh token using the Apple revoke endpoint', async () => {
    const fetchMock = vi.fn<AppleFetch>(async () => new Response(null, { status: 200 }));

    await service(fetchMock).revokeAppleRefreshToken('refresh-value');

    expect(fetchMock).toHaveBeenCalledWith(
      'https://appleid.apple.com/auth/revoke',
      expect.objectContaining({ method: 'POST', signal: expect.any(AbortSignal) }),
    );
    const body = String(fetchMock.mock.calls[0]?.[1]?.body);
    expect(body).toContain('token=refresh-value');
    expect(body).toContain('token_type_hint=refresh_token');
  });

  it('maps upstream rejection, malformed JSON, and aborts to sanitized errors', async () => {
    const failures: readonly AppleFetch[] = [
      async () => new Response('single-use-code refresh-value', { status: 400 }),
      async () => new Response('{not-json', { status: 200 }),
      async () => { throw new DOMException('single-use-code', 'AbortError'); },
    ];

    for (const fetchFailure of failures) {
      try {
        await service(fetchFailure).exchangeAppleAuthorizationCode('single-use-code', SUBJECT);
        throw new Error('expected endpoint failure');
      } catch (error: unknown) {
        expect(error).toBeInstanceOf(AppleAuthError);
        expect(error).toMatchObject({ code: 'APPLE_UPSTREAM_UNAVAILABLE' });
        expect(String(error)).not.toContain('single-use-code');
        expect(String(error)).not.toContain('refresh-value');
      }
    }
  });
});
