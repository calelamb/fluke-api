import {
  createRemoteJWKSet,
  importPKCS8,
  jwtVerify,
  SignJWT,
  type JWTVerifyGetKey,
  type JWTPayload,
} from 'jose';
import { z } from 'zod';

const APPLE_ISSUER = 'https://appleid.apple.com';
const APPLE_JWKS_URL = new URL(`${APPLE_ISSUER}/auth/keys`);
const APPLE_REVOKE_URL = `${APPLE_ISSUER}/auth/revoke`;
const APPLE_TOKEN_URL = `${APPLE_ISSUER}/auth/token`;
const CLIENT_SECRET_LIFETIME_SECONDS = 180 * 24 * 60 * 60;
const MAX_CREDENTIAL_LENGTH = 16_384;
const MAX_FETCH_TIMEOUT_MS = 10_000;

const tokenResponseSchema = z.object({
  access_token: z.string().min(1).max(MAX_CREDENTIAL_LENGTH),
  expires_in: z.number().int().positive(),
  id_token: z.string().min(1).max(MAX_CREDENTIAL_LENGTH),
  refresh_token: z.string().min(1).max(MAX_CREDENTIAL_LENGTH),
  token_type: z.literal('Bearer'),
}).strict();

export interface AppleAuthConfig {
  readonly clientId: string;
  readonly fetchTimeoutMs?: number;
  readonly keyId: string;
  readonly privateKeyPem: string;
  readonly teamId: string;
}

export type AppleFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export interface AppleAuthDependencies {
  readonly fetch?: AppleFetch;
  readonly jwks?: JWTVerifyGetKey;
  readonly now?: () => Date;
}

export interface VerifiedAppleIdentity {
  readonly email?: string;
  readonly emailVerified?: boolean;
  readonly subject: string;
}

export interface AppleTokenSet {
  readonly accessToken: string;
  readonly expiresIn: number;
  readonly identityToken: string;
  readonly refreshToken: string;
  readonly subject: string;
}

export type AppleAuthErrorCode =
  | 'APPLE_CONFIG_INVALID'
  | 'APPLE_CREDENTIAL_INVALID'
  | 'APPLE_TOKEN_INVALID'
  | 'APPLE_UPSTREAM_UNAVAILABLE';

export class AppleAuthError extends Error {
  public constructor(public readonly code: AppleAuthErrorCode) {
    super(code === 'APPLE_UPSTREAM_UNAVAILABLE'
      ? 'Apple authentication is temporarily unavailable.'
      : 'Apple authentication could not be completed.');
    this.name = 'AppleAuthError';
  }
}

function requireBoundedCredential(value: string): string {
  if (value.length === 0 || value.length > MAX_CREDENTIAL_LENGTH || value.trim() !== value) {
    throw new AppleAuthError('APPLE_CREDENTIAL_INVALID');
  }
  return value;
}

function validateConfig(config: AppleAuthConfig): Required<AppleAuthConfig> {
  const fetchTimeoutMs = config.fetchTimeoutMs ?? 5_000;
  const requiredValues = [config.clientId, config.keyId, config.privateKeyPem, config.teamId];
  if (requiredValues.some((value) => value.trim().length === 0)
    || !Number.isInteger(fetchTimeoutMs)
    || fetchTimeoutMs < 1
    || fetchTimeoutMs > MAX_FETCH_TIMEOUT_MS) {
    throw new AppleAuthError('APPLE_CONFIG_INVALID');
  }

  return { ...config, fetchTimeoutMs };
}

function identityFromPayload(payload: JWTPayload): VerifiedAppleIdentity {
  if (typeof payload.sub !== 'string' || payload.sub.length === 0) {
    throw new AppleAuthError('APPLE_TOKEN_INVALID');
  }

  return {
    ...(typeof payload.email === 'string' ? { email: payload.email } : {}),
    ...(typeof payload.email_verified === 'boolean' ? { emailVerified: payload.email_verified } : {}),
    subject: payload.sub,
  };
}

export class AppleAuthService {
  readonly #config: Required<AppleAuthConfig>;
  readonly #fetch: AppleFetch;
  readonly #jwks: JWTVerifyGetKey;
  readonly #now: () => Date;

  public constructor(config: AppleAuthConfig, dependencies: AppleAuthDependencies = {}) {
    this.#config = validateConfig(config);
    this.#fetch = dependencies.fetch ?? globalThis.fetch;
    this.#jwks = dependencies.jwks ?? createRemoteJWKSet(APPLE_JWKS_URL, {
      cacheMaxAge: 10 * 60_000,
      cooldownDuration: 30_000,
      timeoutDuration: 5_000,
    });
    this.#now = dependencies.now ?? (() => new Date());
  }

  public async verifyAppleIdentityToken(token: string, expectedNonce: string): Promise<VerifiedAppleIdentity> {
    try {
      requireBoundedCredential(token);
      requireBoundedCredential(expectedNonce);
      const payload = await this.#verifyToken(token);
      if (payload.nonce !== expectedNonce) {
        throw new AppleAuthError('APPLE_TOKEN_INVALID');
      }
      return identityFromPayload(payload);
    } catch (error: unknown) {
      if (error instanceof AppleAuthError) {
        throw error.code === 'APPLE_CREDENTIAL_INVALID'
          ? new AppleAuthError('APPLE_TOKEN_INVALID')
          : error;
      }
      throw new AppleAuthError('APPLE_TOKEN_INVALID');
    }
  }

  public async exchangeAppleAuthorizationCode(code: string, expectedSubject?: string): Promise<AppleTokenSet> {
    requireBoundedCredential(code);
    if (expectedSubject !== undefined) {
      requireBoundedCredential(expectedSubject);
    }

    const response = await this.#postForm(APPLE_TOKEN_URL, new URLSearchParams({
      client_id: this.#config.clientId,
      client_secret: await this.#createClientSecret(),
      code,
      grant_type: 'authorization_code',
    }));
    const parsed = await this.#parseTokenResponse(response);
    const endpointIdentity = await this.#verifyEndpointIdentityToken(parsed.id_token);
    if (expectedSubject !== undefined && endpointIdentity.subject !== expectedSubject) {
      throw new AppleAuthError('APPLE_TOKEN_INVALID');
    }

    return {
      accessToken: parsed.access_token,
      expiresIn: parsed.expires_in,
      identityToken: parsed.id_token,
      refreshToken: parsed.refresh_token,
      subject: endpointIdentity.subject,
    };
  }

  public async revokeAppleRefreshToken(refreshToken: string): Promise<void> {
    requireBoundedCredential(refreshToken);
    await this.#postForm(APPLE_REVOKE_URL, new URLSearchParams({
      client_id: this.#config.clientId,
      client_secret: await this.#createClientSecret(),
      token: refreshToken,
      token_type_hint: 'refresh_token',
    }));
  }

  async #verifyToken(token: string): Promise<JWTPayload> {
    const result = await jwtVerify(token, this.#jwks, {
      algorithms: ['RS256'],
      audience: this.#config.clientId,
      currentDate: this.#now(),
      issuer: APPLE_ISSUER,
    });
    return result.payload;
  }

  async #verifyEndpointIdentityToken(token: string): Promise<VerifiedAppleIdentity> {
    try {
      return identityFromPayload(await this.#verifyToken(token));
    } catch (error: unknown) {
      if (error instanceof AppleAuthError) {
        throw error;
      }
      throw new AppleAuthError('APPLE_TOKEN_INVALID');
    }
  }

  async #createClientSecret(): Promise<string> {
    try {
      const issuedAt = Math.floor(this.#now().getTime() / 1_000);
      const privateKey = await importPKCS8(this.#config.privateKeyPem, 'ES256');
      return new SignJWT({})
        .setProtectedHeader({ alg: 'ES256', kid: this.#config.keyId })
        .setIssuer(this.#config.teamId)
        .setSubject(this.#config.clientId)
        .setAudience(APPLE_ISSUER)
        .setIssuedAt(issuedAt)
        .setExpirationTime(issuedAt + CLIENT_SECRET_LIFETIME_SECONDS)
        .sign(privateKey);
    } catch {
      throw new AppleAuthError('APPLE_CONFIG_INVALID');
    }
  }

  async #postForm(url: string, body: URLSearchParams): Promise<Response> {
    try {
      const response = await this.#fetch(url, {
        body,
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        method: 'POST',
        signal: AbortSignal.timeout(this.#config.fetchTimeoutMs),
      });
      if (!response.ok) {
        throw new AppleAuthError('APPLE_UPSTREAM_UNAVAILABLE');
      }
      return response;
    } catch {
      throw new AppleAuthError('APPLE_UPSTREAM_UNAVAILABLE');
    }
  }

  async #parseTokenResponse(response: Response): Promise<z.infer<typeof tokenResponseSchema>> {
    try {
      return tokenResponseSchema.parse(await response.json());
    } catch {
      throw new AppleAuthError('APPLE_UPSTREAM_UNAVAILABLE');
    }
  }
}
