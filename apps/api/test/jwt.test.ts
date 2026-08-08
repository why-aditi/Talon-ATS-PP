/**
 * Unit tests for the local provider's JWT machinery. No database.
 */
import { afterEach, expect, it, vi } from 'vitest';
import { JwtError, nowSeconds, signJwt, verifyJwt } from '../src/modules/identity/jwt.js';

const SECRET = 'unit-test-secret';
const BASE = {
  secret: SECRET,
  issuer: 'talon-local',
  audience: 'talon-api',
  expLeewaySeconds: 60,
};

const claimsAt = (iat: number, ttl = 3600) => ({
  sub: '019fdc64-a4dc-7490-9338-430ba75dce40',
  email: 'maya@taloninc.com',
  tenant_id: '019fdc64-a4dc-7490-9338-430a7ac7a3b6',
  role: 'recruiter',
  iss: 'talon-local',
  aud: 'talon-api',
  iat,
  exp: iat + ttl,
  jti: 'jti-1',
});

const failure = (fn: () => unknown): string => {
  try {
    fn();
  } catch (err) {
    if (err instanceof JwtError) return err.failure;
    throw err;
  }
  throw new Error('expected verification to fail');
};

afterEach(() => {
  vi.useRealTimers();
});

it('round-trips the §6.2 claim shape', () => {
  const now = nowSeconds();
  expect(verifyJwt(signJwt(claimsAt(now), SECRET), BASE)).toMatchObject(claimsAt(now));
});

it('rejects a tampered payload', () => {
  const token = signJwt(claimsAt(nowSeconds()), SECRET);
  const [header, , signature] = token.split('.') as [string, string, string];
  const forged = Buffer.from(JSON.stringify({ ...claimsAt(nowSeconds()), role: 'admin' })).toString(
    'base64url',
  );
  expect(failure(() => verifyJwt(`${header}.${forged}.${signature}`, BASE))).toBe('bad_signature');
});

it('rejects alg: none and algorithm substitution', () => {
  const claims = claimsAt(nowSeconds());
  const unsigned = `${Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url')}.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.`;
  expect(failure(() => verifyJwt(unsigned, BASE))).toBe('malformed');

  const hs512 = `${Buffer.from(JSON.stringify({ alg: 'HS512', typ: 'JWT' })).toString('base64url')}.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.sig`;
  expect(failure(() => verifyJwt(hs512, BASE))).toBe('unsupported_algorithm');
});

it.each([
  ['two segments', 'a.b'],
  ['four segments', 'a.b.c.d'],
  ['empty', ''],
])('rejects a malformed token (%s)', (_label, token) => {
  expect(failure(() => verifyJwt(token, BASE))).toBe('malformed');
});

it('rejects the wrong issuer and the wrong audience', () => {
  const now = nowSeconds();
  expect(
    failure(() => verifyJwt(signJwt({ ...claimsAt(now), iss: 'someone-else' }, SECRET), BASE)),
  ).toBe('wrong_issuer');
  expect(
    failure(() => verifyJwt(signJwt({ ...claimsAt(now), aud: 'talon-refresh' }, SECRET), BASE)),
  ).toBe('wrong_audience');
  // An array audience would let one token satisfy both audiences.
  expect(
    failure(() =>
      verifyJwt(signJwt({ ...claimsAt(now), aud: ['talon-api', 'talon-refresh'] }, SECRET), BASE),
    ),
  ).toBe('wrong_audience');
});

// ── §9 edge case 9 ─────────────────────────────────────────────────────────

it('forgives up to 60s of clock skew on exp and not a second more', () => {
  const now = nowSeconds();
  const token = signJwt(claimsAt(now - 3600), SECRET); // expired exactly now
  expect(() => verifyJwt(token, { ...BASE, now: now + 59 })).not.toThrow();
  expect(() => verifyJwt(token, { ...BASE, now: now + 60 })).not.toThrow();
  expect(failure(() => verifyJwt(token, { ...BASE, now: now + 61 }))).toBe('expired');
});

it('forgives nothing on an iat in the future', () => {
  const now = nowSeconds();
  const token = signJwt(claimsAt(now + 1), SECRET);
  expect(failure(() => verifyJwt(token, { ...BASE, now }))).toBe('not_yet_valid');
  expect(() => verifyJwt(token, { ...BASE, now: now + 1 })).not.toThrow();
});

it('token lifetimes are unaffected by a DST transition', () => {
  // Token times are epoch seconds — UTC by construction. This fails only if
  // someone reintroduces local-time arithmetic into signing or verification.
  // 2026-03-08T06:59:00Z is one minute before US Eastern springs forward.
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-03-08T06:59:00Z'));
  const issued = nowSeconds();
  const token = signJwt(claimsAt(issued), SECRET);

  // Two minutes later on the wall clock, an hour later in New York.
  vi.setSystemTime(new Date('2026-03-08T07:01:00Z'));
  const claims = verifyJwt(token, BASE);
  expect(claims['exp']).toBe(issued + 3600);
  expect(nowSeconds() - issued).toBe(120);

  // And it expires 3600s after issue, not 3600s ± an hour.
  expect(() => verifyJwt(token, { ...BASE, now: issued + 3660 })).not.toThrow();
  expect(failure(() => verifyJwt(token, { ...BASE, now: issued + 3661 }))).toBe('expired');
});
