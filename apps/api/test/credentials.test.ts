/**
 * Unit tests for password hashing and TOTP. No database.
 */
import { expect, it } from 'vitest';
import { hashPassword, verifyPassword } from '../src/modules/identity/password.js';
import { generateTotpSecret, totpUri, verifyTotpCode } from '../src/modules/identity/totp.js';
import { createHmac } from 'node:crypto';

// ── passwords ──────────────────────────────────────────────────────────────

it('verifies a correct password and rejects a wrong one', async () => {
  const stored = await hashPassword('correct-horse-battery-staple');
  expect(await verifyPassword('correct-horse-battery-staple', stored)).toBe(true);
  expect(await verifyPassword('correct-horse-battery-stapl', stored)).toBe(false);
  expect(await verifyPassword('', stored)).toBe(false);
});

it('never stores the password, and salts every hash', async () => {
  const a = await hashPassword('same password');
  const b = await hashPassword('same password');
  expect(a).not.toBe(b);
  expect(a).not.toContain('same password');
  expect(a.startsWith('scrypt$N=16384,r=8,p=1$')).toBe(true);
});

it.each([
  ['empty', ''],
  ['no scheme', 'N=16384,r=8,p=1$c2FsdA==$aGFzaA=='],
  ['wrong scheme', 'bcrypt$N=1$c2FsdA==$aGFzaA=='],
  ['truncated', 'scrypt$N=16384,r=8,p=1$c2FsdA=='],
  ['non-numeric parameters', 'scrypt$N=x,r=8,p=1$c2FsdA==$aGFzaA=='],
])('a corrupt stored hash (%s) fails closed rather than throwing', async (_label, stored) => {
  await expect(verifyPassword('anything', stored)).resolves.toBe(false);
});

// ── TOTP ───────────────────────────────────────────────────────────────────

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function base32Decode(secret: string): Buffer {
  let bits = 0;
  let value = 0;
  const bytes: number[] = [];
  for (const char of secret) {
    value = (value << 5) | ALPHABET.indexOf(char);
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}

/** An independent implementation, so the test is not the code under test. */
function expectedCode(secret: string, atSeconds: number): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(atSeconds / 30)));
  const digest = createHmac('sha1', base32Decode(secret)).update(counter).digest();
  const offset = (digest[digest.length - 1] as number) & 0x0f;
  const binary =
    (((digest[offset] as number) & 0x7f) << 24) |
    ((digest[offset + 1] as number) << 16) |
    ((digest[offset + 2] as number) << 8) |
    (digest[offset + 3] as number);
  return String(binary % 1_000_000).padStart(6, '0');
}

it('accepts the current code and one step of drift either side', () => {
  const secret = generateTotpSecret();
  const now = 1_800_000_000;
  expect(verifyTotpCode(secret, expectedCode(secret, now), { now })).toBe(true);
  expect(verifyTotpCode(secret, expectedCode(secret, now - 30), { now })).toBe(true);
  expect(verifyTotpCode(secret, expectedCode(secret, now + 30), { now })).toBe(true);
  expect(verifyTotpCode(secret, expectedCode(secret, now + 120), { now })).toBe(false);
});

it.each(['', '000', '0000000', 'abcdef', '12345 '])(
  'rejects a malformed code (%s)',
  (code) => {
    expect(verifyTotpCode(generateTotpSecret(), code)).toBe(false);
  },
);

it('rejects a code against an unusable secret rather than throwing', () => {
  expect(verifyTotpCode('not base32 !!', '123456')).toBe(false);
  expect(verifyTotpCode('', '123456')).toBe(false);
});

it('produces an enrolment URI an authenticator app can read', () => {
  const secret = generateTotpSecret();
  const uri = new URL(totpUri(secret, { issuer: 'talon-local', account: 'maya@taloninc.com' }));
  expect(uri.protocol).toBe('otpauth:');
  expect(uri.searchParams.get('secret')).toBe(secret);
  expect(uri.searchParams.get('digits')).toBe('6');
  expect(uri.searchParams.get('period')).toBe('30');
});

it('secrets are 160 bits and unique per call', () => {
  const secrets = new Set(Array.from({ length: 20 }, () => generateTotpSecret()));
  expect(secrets.size).toBe(20);
  for (const secret of secrets) expect(base32Decode(secret)).toHaveLength(20);
});
