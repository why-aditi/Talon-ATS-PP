/**
 * JwksVerifier — RS256 against a remote key set. No database, no AWS.
 *
 * This is the file that will still matter after the pre-token-generation Lambda
 * lands: at that point Cognito's own token becomes the bearer token and this
 * verifier runs on every authenticated request. It is tested harder than the
 * adapter around it for exactly that reason.
 */
import { createSign, generateKeyPairSync, type KeyObject } from 'node:crypto';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { JwtError } from '../src/modules/identity/jwt.js';
import { JwksVerifier } from '../src/modules/identity/jwks.js';

const ISSUER = 'https://cognito-idp.us-east-1.amazonaws.com/us-east-1_test';
const JWKS_URI = `${ISSUER}/.well-known/jwks.json`;
const AUDIENCE = 'test-client-id';
const NOW = 1_800_000_000;

const b64 = (value: unknown): string =>
  Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');

interface Keypair {
  kid: string;
  privateKey: KeyObject;
  publicKey: KeyObject;
}

function keypair(kid: string): Keypair {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  return { kid, privateKey, publicKey };
}

function jwkFor(key: Keypair, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { ...key.publicKey.export({ format: 'jwk' }), kid: key.kid, alg: 'RS256', use: 'sig', ...extra };
}

function sign(
  key: Keypair,
  claims: Record<string, unknown>,
  header: Record<string, unknown> = {},
): string {
  const input = `${b64({ alg: 'RS256', typ: 'JWT', kid: key.kid, ...header })}.${b64(claims)}`;
  return `${input}.${createSign('RSA-SHA256').update(input, 'utf8').sign(key.privateKey).toString('base64url')}`;
}

const goodClaims = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  sub: '11111111-1111-4111-8111-111111111111',
  email: 'maya@taloninc.com',
  iss: ISSUER,
  aud: AUDIENCE,
  token_use: 'id',
  iat: NOW - 10,
  exp: NOW + 3600,
  ...overrides,
});

let primary: Keypair;
let fetches: string[];
let served: Record<string, unknown>[];
let respond: () => Response;

function verifier(): JwksVerifier {
  return new JwksVerifier({
    jwksUri: JWKS_URI,
    issuer: ISSUER,
    audience: AUDIENCE,
    tokenUse: 'id',
    expLeewaySeconds: 60,
    iatLeewaySeconds: 60,
    now: () => NOW,
    // The one place this suite injects rather than intercepting: these are unit
    // tests of the verifier itself, and `cognito-provider.test.ts` is where the
    // real `globalThis.fetch` boundary gets exercised.
    fetchImpl: (async (input: Parameters<typeof globalThis.fetch>[0]) => {
      fetches.push(String(input));
      return respond();
    }) as typeof globalThis.fetch,
  });
}

beforeEach(() => {
  primary = keypair('kid-1');
  fetches = [];
  served = [jwkFor(primary)];
  respond = () =>
    new Response(JSON.stringify({ keys: served }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
});

afterEach(() => {
  fetches = [];
});

it('verifies a well-formed token and returns its claims', async () => {
  const claims = await verifier().verify(sign(primary, goodClaims()));
  expect(claims['sub']).toBe('11111111-1111-4111-8111-111111111111');
  expect(claims['email']).toBe('maya@taloninc.com');
});

it('fetches the key set once and serves later tokens from cache', async () => {
  const subject = verifier();
  await subject.verify(sign(primary, goodClaims()));
  await subject.verify(sign(primary, goodClaims({ jti: 'second' })));
  expect(fetches).toEqual([JWKS_URI]);
});

it('a cold cache picks up a rotated key', async () => {
  const rotated = keypair('kid-2');
  served = [jwkFor(primary), jwkFor(rotated)];
  const claims = await verifier().verify(sign(rotated, goodClaims()));
  expect(claims['sub']).toBe('11111111-1111-4111-8111-111111111111');
  expect(fetches).toEqual([JWKS_URI]);
});

/**
 * The floor is the deliberate trade: an unknown `kid` is overwhelmingly a forged
 * one, so it is answered from cache rather than by hitting Cognito. The cost is
 * that a genuine rotation the cache has not seen takes up to REFETCH_FLOOR_MS to
 * heal — recorded here as a behaviour, not discovered later as an outage.
 */
it('refuses an unknown kid from cache until the refetch floor elapses, then heals', async () => {
  vi.useFakeTimers();
  try {
    const subject = verifier();
    await subject.verify(sign(primary, goodClaims()));
    expect(fetches).toHaveLength(1);

    const rotated = keypair('kid-2');
    served = [jwkFor(primary), jwkFor(rotated)];
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await expect(subject.verify(sign(rotated, goodClaims()))).rejects.toThrow(JwtError);
    }
    // Five misses, no extra traffic: an attacker inventing kids cannot turn the
    // token endpoint into a request amplifier against Cognito.
    expect(fetches).toHaveLength(1);

    vi.setSystemTime(Date.now() + 61_000);
    await expect(subject.verify(sign(rotated, goodClaims()))).resolves.toBeTruthy();
    expect(fetches).toHaveLength(2);
  } finally {
    vi.useRealTimers();
  }
});

it.each([
  ['alg none', { alg: 'none' }],
  ['HS256 downgrade', { alg: 'HS256' }],
  ['an unrecognised crit extension', { crit: ['exp'] }],
  ['an unexpected typ', { typ: 'at+jwt' }],
])('refuses a token with %s', async (_label, header) => {
  await expect(verifier().verify(sign(primary, goodClaims(), header))).rejects.toThrow(JwtError);
});

it('refuses a token with no kid before it looks up any key', async () => {
  const input = `${b64({ alg: 'RS256', typ: 'JWT' })}.${b64(goodClaims())}`;
  const token = `${input}.${createSign('RSA-SHA256').update(input, 'utf8').sign(primary.privateKey).toString('base64url')}`;
  await expect(verifier().verify(token)).rejects.toThrow(JwtError);
  expect(fetches).toHaveLength(0);
});

it('refuses a token signed by a key the pool does not publish', async () => {
  const impostor = { ...keypair('kid-1') };
  await expect(verifier().verify(sign(impostor, goodClaims()))).rejects.toMatchObject({
    failure: 'bad_signature',
  });
});

it('refuses a tampered payload', async () => {
  const token = sign(primary, goodClaims());
  const [header, , signature] = token.split('.') as [string, string, string];
  const forged = `${header}.${b64(goodClaims({ email: 'attacker@evil.test' }))}.${signature}`;
  await expect(verifier().verify(forged)).rejects.toMatchObject({ failure: 'bad_signature' });
});

it.each([
  ['a foreign issuer', { iss: 'https://cognito-idp.us-east-1.amazonaws.com/us-east-1_other' }, 'wrong_issuer'],
  ['a foreign audience', { aud: 'someone-elses-client' }, 'wrong_audience'],
  ['an array audience', { aud: [AUDIENCE] }, 'wrong_audience'],
  ['an access token where an id token is expected', { token_use: 'access' }, 'wrong_audience'],
  ['no token_use at all', { token_use: undefined }, 'wrong_audience'],
])('refuses %s', async (_label, overrides, failure) => {
  await expect(verifier().verify(sign(primary, goodClaims(overrides)))).rejects.toMatchObject({
    failure,
  });
});

/**
 * The leeway on a future `iat` is the difference between this verifier and
 * `jwt.ts`, and it is not a relaxation for convenience: Cognito's signing clock
 * measured 2s ahead of a developer machine, and with zero leeway every sign-in
 * on that machine 401s with `token-not-yet-valid`. Bounded on both sides so a
 * token minted minutes ahead is still refused.
 */
it('forgives bounded clock skew in both directions (§9 edge case 9, remote signer)', async () => {
  const subject = verifier();
  await expect(subject.verify(sign(primary, goodClaims({ exp: NOW - 30 })))).resolves.toBeTruthy();
  await expect(subject.verify(sign(primary, goodClaims({ exp: NOW - 61 })))).rejects.toMatchObject({
    failure: 'expired',
  });
  // The exact case the live Cognito run hit.
  await expect(subject.verify(sign(primary, goodClaims({ iat: NOW + 2 })))).resolves.toBeTruthy();
  await expect(subject.verify(sign(primary, goodClaims({ iat: NOW + 60 })))).resolves.toBeTruthy();
  await expect(subject.verify(sign(primary, goodClaims({ iat: NOW + 61 })))).rejects.toMatchObject({
    failure: 'not_yet_valid',
  });
});

it.each([
  ['a non-numeric exp', { exp: 'soon' }],
  ['a missing iat', { iat: undefined }],
])('refuses %s', async (_label, overrides) => {
  await expect(verifier().verify(sign(primary, goodClaims(overrides)))).rejects.toMatchObject({
    failure: 'malformed',
  });
});

it.each([
  ['two segments', 'aaa.bbb'],
  ['an empty segment', 'aaa..ccc'],
  ['undecodable base64', '!!!.!!!.!!!'],
])('refuses a structurally broken token (%s)', async (_label, token) => {
  await expect(verifier().verify(token)).rejects.toThrow(JwtError);
});

it('ignores key-set entries that are not RS256 signing keys', async () => {
  const encryption = keypair('kid-enc');
  served = [
    { kty: 'EC', kid: 'kid-ec', crv: 'P-256', x: 'a', y: 'b' },
    jwkFor(encryption, { use: 'enc' }),
    jwkFor(primary),
  ];
  await expect(verifier().verify(sign(primary, goodClaims()))).resolves.toBeTruthy();
  await expect(verifier().verify(sign(encryption, goodClaims()))).rejects.toThrow(JwtError);
});

it('a key server outage is a server error, not "your token is invalid"', async () => {
  respond = () => new Response('nope', { status: 503 });
  // Not a JwtError: telling the user to sign in again cannot fix a 503, and the
  // provider only translates JwtError into a 401.
  await expect(verifier().verify(sign(primary, goodClaims()))).rejects.not.toBeInstanceOf(JwtError);
});

it('an outage stays a server error on the calls that follow it', async () => {
  // The refetch floor is keyed on the last SUCCESSFUL load. Keyed on the last
  // attempt instead, one 503 leaves the cache empty and every call for the next
  // minute answers "no key for kid" — a 401 telling users to re-login, which
  // cannot help. Once this verifier runs per-request (after the Lambda swap),
  // that turns a brief key-server blip into a fleet-wide re-login storm.
  respond = () => new Response('nope', { status: 503 });
  const v = verifier();
  const token = sign(primary, goodClaims());

  await expect(v.verify(token)).rejects.not.toBeInstanceOf(JwtError);
  await expect(v.verify(token)).rejects.not.toBeInstanceOf(JwtError);
});

it('a key set with no keys array is a server error too', async () => {
  respond = () =>
    new Response(JSON.stringify({ message: 'hello' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  await expect(verifier().verify(sign(primary, goodClaims()))).rejects.not.toBeInstanceOf(JwtError);
});
