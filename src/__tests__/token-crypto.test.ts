import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import { decodeTokenEncryptionKey, TokenCrypto, TokenCryptoError } from '../lib/token-crypto.js';

describe('TokenCrypto', () => {
  it('round-trips a refresh token in a versioned AES-256-GCM envelope', () => {
    const crypto = new TokenCrypto(randomBytes(32));
    const ciphertext = crypto.encryptToken('refresh-token-value');

    expect(ciphertext.split('.')).toHaveLength(4);
    expect(ciphertext.startsWith('1.')).toBe(true);
    expect(ciphertext).not.toContain('refresh-token-value');
    expect(crypto.decryptToken(ciphertext)).toBe('refresh-token-value');
  });

  it('uses a fresh 96-bit IV for every encryption', () => {
    const crypto = new TokenCrypto(Buffer.alloc(32, 7));
    const first = crypto.encryptToken('same-token');
    const second = crypto.encryptToken('same-token');

    expect(first).not.toBe(second);
    expect(Buffer.from(first.split('.')[1] ?? '', 'base64url')).toHaveLength(12);
    expect(Buffer.from(second.split('.')[1] ?? '', 'base64url')).toHaveLength(12);
  });

  it.each(['', ' ', '\n\t'])('rejects an empty or whitespace-only plaintext token', (token) => {
    expect(() => new TokenCrypto(Buffer.alloc(32, 7)).encryptToken(token)).toThrow(TokenCryptoError);
  });

  it.each([
    '2.a.b.c',
    '1.only-three.parts',
    '1.***.dGFn.Y2lwaGVydGV4dA',
    '1.aXY.dGFn.***',
  ])('rejects malformed or unsupported envelopes: %s', (ciphertext) => {
    const crypto = new TokenCrypto(Buffer.alloc(32, 1));
    expect(() => crypto.decryptToken(ciphertext)).toThrow(TokenCryptoError);
  });

  it('rejects tampering and a different key without exposing the token', () => {
    const first = new TokenCrypto(Buffer.alloc(32, 1));
    const second = new TokenCrypto(Buffer.alloc(32, 2));
    const encrypted = first.encryptToken('never-print-this-refresh-token');
    const parts = encrypted.split('.');
    const ciphertext = Buffer.from(parts[3] ?? '', 'base64url');
    ciphertext[0] = (ciphertext[0] ?? 0) ^ 1;
    const tampered = [parts[0], parts[1], parts[2], ciphertext.toString('base64url')].join('.');

    for (const operation of [
      () => first.decryptToken(tampered),
      () => second.decryptToken(encrypted),
    ]) {
      try {
        operation();
        throw new Error('expected decryption to fail');
      } catch (error: unknown) {
        expect(error).toBeInstanceOf(TokenCryptoError);
        expect(String(error)).not.toContain('never-print-this-refresh-token');
      }
    }
  });

  it('decodes canonical padded standard base64 emitted by openssl rand -base64 32', () => {
    const raw = Buffer.alloc(32, 251);
    const opensslFormat = raw.toString('base64');
    expect(opensslFormat).toContain('+');
    expect(opensslFormat.endsWith('=')).toBe(true);
    expect(decodeTokenEncryptionKey(opensslFormat)).toEqual(raw);
  });

  it('rejects malformed, noncanonical, URL-safe, unpadded, and wrong-length key encodings', () => {
    const canonical = Buffer.alloc(32, 251).toString('base64');
    const invalid = [
      '',
      Buffer.alloc(31).toString('base64'),
      canonical.replace(/=$/u, ''),
      Buffer.alloc(32, 251).toString('base64url'),
      ` ${canonical}`,
      `${canonical}\n`,
      'not base64!',
    ];
    for (const encoded of invalid) {
      expect(() => decodeTokenEncryptionKey(encoded)).toThrow(TokenCryptoError);
    }
  });
});
