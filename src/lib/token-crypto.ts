import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const ALGORITHM = 'aes-256-gcm';
const AUTH_TAG_BYTES = 16;
const ENCRYPTION_KEY_BYTES = 32;
const IV_BYTES = 12;
const TOKEN_VERSION = '1';
const TOKEN_VERSION_AAD = Buffer.from([1]);
const BASE64URL = /^[A-Za-z0-9_-]+$/u;

export class TokenCryptoError extends Error {
  public readonly code = 'TOKEN_CRYPTO_INVALID';

  public constructor() {
    super('Encrypted token data is invalid.');
    this.name = 'TokenCryptoError';
  }
}

function decodeComponent(value: string, expectedBytes?: number): Buffer {
  if (!BASE64URL.test(value)) {
    throw new TokenCryptoError();
  }

  const decoded = Buffer.from(value, 'base64url');
  if (decoded.toString('base64url') !== value || (expectedBytes !== undefined && decoded.length !== expectedBytes)) {
    throw new TokenCryptoError();
  }

  return decoded;
}

export function decodeTokenEncryptionKey(encodedKey: string): Buffer {
  return decodeComponent(encodedKey, ENCRYPTION_KEY_BYTES);
}

export class TokenCrypto {
  readonly #encryptionKey: Buffer;

  public constructor(encryptionKey: Uint8Array) {
    if (encryptionKey.byteLength !== ENCRYPTION_KEY_BYTES) {
      throw new TokenCryptoError();
    }
    this.#encryptionKey = Buffer.from(encryptionKey);
  }

  public encryptToken(token: string): string {
    if (token.length === 0) {
      throw new TokenCryptoError();
    }

    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv(ALGORITHM, this.#encryptionKey, iv, { authTagLength: AUTH_TAG_BYTES });
    cipher.setAAD(TOKEN_VERSION_AAD);
    const ciphertext = Buffer.concat([cipher.update(token, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();

    return [TOKEN_VERSION, iv.toString('base64url'), tag.toString('base64url'), ciphertext.toString('base64url')].join('.');
  }

  public decryptToken(envelope: string): string {
    try {
      const parts = envelope.split('.');
      if (parts.length !== 4 || parts[0] !== TOKEN_VERSION) {
        throw new TokenCryptoError();
      }

      const iv = decodeComponent(parts[1] ?? '', IV_BYTES);
      const tag = decodeComponent(parts[2] ?? '', AUTH_TAG_BYTES);
      const ciphertext = decodeComponent(parts[3] ?? '');
      const decipher = createDecipheriv(ALGORITHM, this.#encryptionKey, iv, { authTagLength: AUTH_TAG_BYTES });
      decipher.setAAD(TOKEN_VERSION_AAD);
      decipher.setAuthTag(tag);
      return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
    } catch (error: unknown) {
      if (error instanceof TokenCryptoError) {
        throw error;
      }
      throw new TokenCryptoError();
    }
  }
}
