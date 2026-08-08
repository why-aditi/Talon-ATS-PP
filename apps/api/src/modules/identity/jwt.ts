/**
 * HS256 JWT sign/verify for Talon's OWN session tokens — the §6.2 bearer token.
 *
 * Hand-rolled over `node:crypto` rather than pulling in a JWT library: the whole
 * surface is one algorithm plus base64url, and the claim rules that actually
 * matter here — 60s leeway on `exp`, none on a future `iat` (§9 edge case 9),
 * and `tokens_valid_after` — have to be written by hand against any library
 * anyway. The two classic JWT vulnerabilities are both closed below: the
 * algorithm is pinned (never read from the token) and the signature is checked
 * before a single claim is read.
 *
 * This is the token WE mint and verify (`session.ts`). Cognito's own id tokens
 * are RS256 against a JWKS and go through `jwks.ts` instead — two verifiers,
 * because they answer to two different key authorities. When the
 * pre-token-generation Lambda lands and the bearer token becomes Cognito's, this
 * file goes with it.
 */
import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { brandError, isBrandedError } from '../../branded-error.js';

export type JwtFailure =
  | 'malformed'
  | 'unsupported_algorithm'
  | 'bad_signature'
  | 'expired'
  | 'not_yet_valid'
  | 'wrong_audience'
  | 'wrong_issuer';

const JWT_ERROR_BRAND = Symbol.for('talon.jwtError');

/**
 * Checked instead of `instanceof` — `branded-error.ts` carries the reasoning.
 * A false negative here rethrows a verification failure raw, and it reaches the
 * error handler as an unrecognised 500 rather than the 401 it is.
 */
export function isJwtError(error: unknown): error is JwtError {
  return isBrandedError(error, JWT_ERROR_BRAND);
}

export class JwtError extends Error {
  constructor(readonly failure: JwtFailure, detail?: string) {
    super(detail ?? failure);
    this.name = 'JwtError';
    brandError(this, JWT_ERROR_BRAND);
  }
}

const encode = (value: unknown): string =>
  Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');

const hmac = (input: string, secret: string): Buffer =>
  createHmac('sha256', secret).update(input, 'utf8').digest();

export const nowSeconds = (): number => Math.floor(Date.now() / 1000);

/** A fresh, unpredictable `jti` per token (§6.2). */
export const newJti = (): string => randomUUID();

export function signJwt(claims: Record<string, unknown>, secret: string): string {
  const signingInput = `${encode({ alg: 'HS256', typ: 'JWT' })}.${encode(claims)}`;
  return `${signingInput}.${hmac(signingInput, secret).toString('base64url')}`;
}

export interface VerifyOptions {
  secret: string;
  issuer: string;
  audience: string;
  /** Applied to `exp` only. Never to `iat`. */
  expLeewaySeconds: number;
  now?: number;
}

function decodeSegment(segment: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(Buffer.from(segment, 'base64url').toString('utf8'));
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new JwtError('malformed', 'segment is not a JSON object');
  }
  return parsed as Record<string, unknown>;
}

export function verifyJwt(token: string, options: VerifyOptions): Record<string, unknown> {
  const parts = token.split('.');
  if (parts.length !== 3) throw new JwtError('malformed', 'expected three segments');
  const [headerPart, payloadPart, signaturePart] = parts as [string, string, string];
  if (!headerPart || !payloadPart || !signaturePart) {
    throw new JwtError('malformed', 'empty segment');
  }

  let header: Record<string, unknown>;
  try {
    header = decodeSegment(headerPart);
  } catch (err) {
    throw isJwtError(err) ? err : new JwtError('malformed', 'undecodable header');
  }
  // Pinned, not negotiated. `alg: none` and RS256→HS256 confusion both die here.
  if (header['alg'] !== 'HS256') throw new JwtError('unsupported_algorithm', String(header['alg']));
  if (header['typ'] !== undefined && header['typ'] !== 'JWT') {
    throw new JwtError('malformed', 'unexpected typ');
  }
  // An extension we do not understand may change the meaning of the token.
  if (header['crit'] !== undefined) throw new JwtError('malformed', 'crit is not supported');

  const expected = hmac(`${headerPart}.${payloadPart}`, options.secret);
  const actual = Buffer.from(signaturePart, 'base64url');
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
    throw new JwtError('bad_signature');
  }

  // Only now is anything in the token data.
  let claims: Record<string, unknown>;
  try {
    claims = decodeSegment(payloadPart);
  } catch (err) {
    throw isJwtError(err) ? err : new JwtError('malformed', 'undecodable payload');
  }

  if (claims['iss'] !== options.issuer) throw new JwtError('wrong_issuer');
  // String equality only. An array `aud` would let one token satisfy two
  // audiences, which is exactly how a refresh token becomes a bearer token.
  if (claims['aud'] !== options.audience) throw new JwtError('wrong_audience');

  const now = options.now ?? nowSeconds();
  const exp = claims['exp'];
  const iat = claims['iat'];
  if (typeof exp !== 'number' || !Number.isFinite(exp)) throw new JwtError('malformed', 'exp');
  if (typeof iat !== 'number' || !Number.isFinite(iat)) throw new JwtError('malformed', 'iat');
  // §9 edge case 9: clock skew is forgiven on the way out (a token that just
  // expired against a slightly fast verifier clock still works for 60s) and not
  // on the way in (a token dated in the future is a signing-clock or forgery
  // problem, and accepting it extends the token's real lifetime).
  if (now > exp + options.expLeewaySeconds) throw new JwtError('expired');
  if (iat > now) throw new JwtError('not_yet_valid');

  return claims;
}
