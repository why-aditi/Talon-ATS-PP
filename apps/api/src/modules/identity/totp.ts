/**
 * RFC 6238 TOTP (SHA-1, 30s step, 6 digits) — what every authenticator app
 * implements, and what Cognito's software-token MFA is.
 *
 * Real, not stubbed: a stub that returns true is indistinguishable from a
 * backdoor, and one that returns false makes MFA untestable. `verifyTotp` for an
 * identity with no enrolled secret is false, always — that check lives in the
 * provider, which is the only place that knows whether a secret exists.
 */
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'; // RFC 4648 base32
const STEP_SECONDS = 30;
const DIGITS = 6;

function base32Encode(buffer: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of buffer) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET.charAt((value >>> (bits - 5)) & 31);
      bits -= 5;
    }
  }
  if (bits > 0) out += ALPHABET.charAt((value << (5 - bits)) & 31);
  return out;
}

function base32Decode(secret: string): Buffer | null {
  let bits = 0;
  let value = 0;
  const bytes: number[] = [];
  for (const char of secret.replace(/=+$/, '').toUpperCase()) {
    const index = ALPHABET.indexOf(char);
    if (index < 0) return null;
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return bytes.length > 0 ? Buffer.from(bytes) : null;
}

/** 160 bits, the RFC 4226 recommendation for HMAC-SHA1. */
export function generateTotpSecret(): string {
  return base32Encode(randomBytes(20));
}

export function totpUri(secret: string, options: { issuer: string; account: string }): string {
  const label = `${encodeURIComponent(options.issuer)}:${encodeURIComponent(options.account)}`;
  const params = new URLSearchParams({
    secret,
    issuer: options.issuer,
    algorithm: 'SHA1',
    digits: String(DIGITS),
    period: String(STEP_SECONDS),
  });
  return `otpauth://totp/${label}?${params.toString()}`;
}

function codeAt(key: Buffer, counter: number): string {
  const message = Buffer.alloc(8);
  message.writeBigUInt64BE(BigInt(counter));
  const digest = createHmac('sha1', key).update(message).digest();
  const offset = (digest[digest.length - 1] as number) & 0x0f;
  const binary =
    (((digest[offset] as number) & 0x7f) << 24) |
    ((digest[offset + 1] as number) << 16) |
    ((digest[offset + 2] as number) << 8) |
    (digest[offset + 3] as number);
  return String(binary % 10 ** DIGITS).padStart(DIGITS, '0');
}

export interface VerifyTotpOptions {
  /** Epoch seconds. */
  now?: number;
  /** Steps of tolerance either side, for clock drift between phone and server. */
  window?: number;
}

export function verifyTotpCode(secret: string, code: string, options: VerifyTotpOptions = {}): boolean {
  if (!/^\d{6}$/.test(code)) return false;
  const key = base32Decode(secret);
  if (!key) return false;
  const counter = Math.floor((options.now ?? Math.floor(Date.now() / 1000)) / STEP_SECONDS);
  const window = options.window ?? 1;
  const candidate = Buffer.from(code, 'utf8');
  let matched = false;
  // No early return: every candidate step is compared so the answer takes the
  // same time whichever step matched.
  for (let drift = -window; drift <= window; drift += 1) {
    const expected = Buffer.from(codeAt(key, counter + drift), 'utf8');
    if (expected.length === candidate.length && timingSafeEqual(expected, candidate)) matched = true;
  }
  return matched;
}
