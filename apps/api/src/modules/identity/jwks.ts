/**
 * RS256 verification against a remote JWKS. Cognito's tokens are signed with a
 * key pair we never hold, so this is the only way to establish that a token the
 * SDK handed us is the one the pool actually issued.
 *
 * Same discipline as `jwt.ts`, for the same reasons: the algorithm is pinned and
 * never read from the token, and not one claim is read before the signature
 * verifies. `JwtError` is shared with `jwt.ts` so both verifiers hand the
 * provider the same failure vocabulary.
 *
 * Hand-rolled over `node:crypto` rather than adding `jose` or `aws-jwt-verify`:
 * Node 22 imports a JWK directly (`createPublicKey({ format: 'jwk' })`) and
 * verifies RSASSA-PKCS1-v1_5/SHA-256 natively, so a library would contribute a
 * cache and a claim-checking loop — both of which we would still have to write
 * our own version of, because the rules that matter here (60s leeway on `exp`,
 * none on a future `iat`, `token_use` pinning) are Talon's, not a library's.
 *
 * This file is NOT scaffolding. When the pre-token-generation Lambda lands and
 * Cognito's own token becomes the bearer token, this is the verifier the request
 * chain runs on every request; only its `audience`/`token_use` arguments change.
 */
import { createPublicKey, createVerify, type KeyObject } from 'node:crypto';
import { JwtError, nowSeconds } from './jwt.js';

/** The subset of a JWKS entry we accept. Anything else is refused, not ignored. */
interface JwksEntry {
  kty?: unknown;
  use?: unknown;
  alg?: unknown;
  kid?: unknown;
  n?: unknown;
  e?: unknown;
}

export interface JwksVerifierOptions {
  jwksUri: string;
  issuer: string;
  audience: string;
  /** Cognito stamps `id`, `access` or `refresh`. Pinned so one cannot pass as another. */
  tokenUse: 'id' | 'access';
  /** Applied to `exp`. */
  expLeewaySeconds: number;
  /**
   * Applied to a FUTURE `iat`, and required rather than defaulted so the caller
   * has to think about it.
   *
   * `jwt.ts` forgives nothing here and is right to: it verifies tokens this
   * process signed, so the signing clock and the verifying clock are the same
   * clock and any skew at all is a forgery signal. This verifier reads tokens
   * signed by AWS. Two independent clocks always disagree a little — measured
   * at 2s against us-east-1 on a developer machine — so zero leeway here means
   * every sign-in fails on any host whose clock lags Cognito's by one second.
   * That is not a security property, it is an outage.
   *
   * Bounded, not dropped: a token minted minutes in the future is still refused,
   * because accepting it would extend its real lifetime past `exp`.
   */
  iatLeewaySeconds: number;
  /**
   * Explicit override. Normally unset: the fetch is resolved from
   * `globalThis` at call time, so intercepting the network the way the suite
   * does (CLAUDE.md §6) needs no injection and no construction ordering.
   */
  fetchImpl?: typeof globalThis.fetch;
  now?: () => number;
}

/**
 * A cold cache costs one HTTPS round trip; a warm one costs nothing. Cognito
 * publishes two keys per pool and rotates rarely, so a miss means either a
 * rotation or a forged `kid`. Both are handled the same way — refetch once —
 * with a floor between refetches so a stream of invented `kid`s cannot turn a
 * token endpoint into a request amplifier against Cognito.
 */
const REFETCH_FLOOR_MS = 60_000;

export class JwksVerifier {
  readonly #options: JwksVerifierOptions;
  readonly #fetch: typeof globalThis.fetch;
  readonly #now: () => number;
  #keys = new Map<string, KeyObject>();
  #lastLoadedAt = 0;

  constructor(options: JwksVerifierOptions) {
    this.#options = options;
    // Late-bound on purpose. Capturing `globalThis.fetch` here would freeze
    // whatever was installed at construction time, which makes a network stub
    // depend on the order two unrelated things happen in — the kind of coupling
    // that produces a suite that passes only when the files run in one order.
    this.#fetch = options.fetchImpl ?? ((...args) => globalThis.fetch(...args));
    this.#now = options.now ?? nowSeconds;
  }

  async verify(token: string): Promise<Record<string, unknown>> {
    const parts = token.split('.');
    if (parts.length !== 3) throw new JwtError('malformed', 'expected three segments');
    const [headerPart, payloadPart, signaturePart] = parts as [string, string, string];
    if (!headerPart || !payloadPart || !signaturePart) {
      throw new JwtError('malformed', 'empty segment');
    }

    const header = decodeSegment(headerPart);
    // Pinned, not negotiated: `alg: none` and an HS256 token signed with the
    // public modulus both die here, before any key lookup.
    if (header['alg'] !== 'RS256') throw new JwtError('unsupported_algorithm', String(header['alg']));
    if (header['typ'] !== undefined && header['typ'] !== 'JWT') {
      throw new JwtError('malformed', 'unexpected typ');
    }
    if (header['crit'] !== undefined) throw new JwtError('malformed', 'crit is not supported');
    const kid = header['kid'];
    if (typeof kid !== 'string' || kid === '') throw new JwtError('malformed', 'missing kid');

    const key = await this.#keyFor(kid);
    const signature = Buffer.from(signaturePart, 'base64url');
    const ok = createVerify('RSA-SHA256')
      .update(`${headerPart}.${payloadPart}`, 'utf8')
      .verify(key, signature);
    if (!ok) throw new JwtError('bad_signature');

    // Only now is anything in the token data.
    const claims = decodeSegment(payloadPart);

    if (claims['iss'] !== this.#options.issuer) throw new JwtError('wrong_issuer');
    // String equality only — an array `aud` would let one token satisfy two
    // audiences, and `token_use` is the second half of the same guard: without
    // it a Cognito *access* token, which carries the same `aud`-ish shape but no
    // email, would be accepted where an id token is expected.
    if (claims['aud'] !== this.#options.audience) throw new JwtError('wrong_audience');
    if (claims['token_use'] !== this.#options.tokenUse) {
      throw new JwtError('wrong_audience', `token_use is ${String(claims['token_use'])}`);
    }

    const now = this.#now();
    const exp = claims['exp'];
    const iat = claims['iat'];
    if (typeof exp !== 'number' || !Number.isFinite(exp)) throw new JwtError('malformed', 'exp');
    if (typeof iat !== 'number' || !Number.isFinite(iat)) throw new JwtError('malformed', 'iat');
    // Spec 001 §9 edge case 9, adjusted for a remote signer — see
    // `iatLeewaySeconds`. Both bounds are finite; neither is skipped.
    if (now > exp + this.#options.expLeewaySeconds) throw new JwtError('expired');
    if (iat > now + this.#options.iatLeewaySeconds) throw new JwtError('not_yet_valid');

    return claims;
  }

  async #keyFor(kid: string): Promise<KeyObject> {
    const cached = this.#keys.get(kid);
    if (cached) return cached;
    // The floor is keyed on the last *successful* load. Throttling on attempts
    // instead would turn one key-server outage into a minute of `bad_signature`
    // — a 401 telling users to re-login, which cannot help — because a failed
    // refresh leaves the cache empty and every following call takes this branch.
    // "We have never loaded keys" and "this kid is not published" are different
    // answers and must not collapse into the same one.
    const sinceLast = Date.now() - this.#lastLoadedAt;
    if (this.#lastLoadedAt !== 0 && sinceLast < REFETCH_FLOOR_MS) {
      throw new JwtError('bad_signature', `no key for kid ${kid}`);
    }
    await this.#refresh();
    const key = this.#keys.get(kid);
    if (!key) throw new JwtError('bad_signature', `no key for kid ${kid}`);
    return key;
  }

  async #refresh(): Promise<void> {

    const response = await this.#fetch(this.#options.jwksUri, {
      headers: { accept: 'application/json' },
    });
    if (!response.ok) {
      // Not a JwtError: the token may be perfectly good and the key server down.
      // Presenting that as "your token is invalid" sends the user to re-login,
      // which cannot help. It surfaces as a 500, which is what it is.
      throw new Error(`JWKS fetch failed: ${response.status} ${this.#options.jwksUri}`);
    }
    const body: unknown = await response.json();
    const keys = (body as { keys?: unknown }).keys;
    if (!Array.isArray(keys)) throw new Error('JWKS response has no keys array');

    const next = new Map<string, KeyObject>();
    for (const entry of keys as JwksEntry[]) {
      // Skip anything that is not an RS256 signing key. An EC key or a
      // `use: enc` entry is not a thing to guess at — and importing only
      // `{ kty, n, e }`, rather than the whole entry, means a field we did not
      // inspect cannot influence how the key is built.
      if (typeof entry.kid !== 'string' || entry.kty !== 'RSA') continue;
      if (entry.alg !== undefined && entry.alg !== 'RS256') continue;
      if (entry.use !== undefined && entry.use !== 'sig') continue;
      if (typeof entry.n !== 'string' || typeof entry.e !== 'string') continue;
      next.set(
        entry.kid,
        createPublicKey({ key: { kty: 'RSA', n: entry.n, e: entry.e }, format: 'jwk' }),
      );
    }
    this.#keys = next;
    // Last thing, and only on success: every early return above is a throw, so
    // reaching here means we hold keys. A failed fetch leaves the previous value
    // untouched and the next call is allowed to retry immediately.
    this.#lastLoadedAt = Date.now();
  }
}

function decodeSegment(segment: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(segment, 'base64url').toString('utf8'));
  } catch {
    throw new JwtError('malformed', 'undecodable segment');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new JwtError('malformed', 'segment is not a JSON object');
  }
  return parsed as Record<string, unknown>;
}
