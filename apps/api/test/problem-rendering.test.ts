/**
 * A problem thrown by a DIFFERENT copy of errors.ts must still render as itself.
 *
 * The regression: `render` gated on `instanceof HttpProblem`, and every failed
 * sign-in against a dev server left as an opaque 500 with the `audit_log` row
 * recording `internal` for a request the caller was told was
 * `invalid-credentials`. Whether two copies of the module were genuinely loaded
 * was never established — `branded-error.ts` records what is known and what is
 * not, and deliberately does not assert a mechanism. What IS established is that
 * a class-identity check answers false in that situation and a brand does not,
 * so these cases fake a second realm rather than using the local class, which
 * would have passed against the broken code too.
 *
 * The last two cases are the ones that would have caught the reported bug: they
 * assert the RESPONSE, through the real error handler, not the predicate.
 */
import { fastify } from 'fastify';
import { expect, it } from 'vitest';
import { HttpProblem, isHttpProblem, problemErrorHandler } from '../src/errors.js';
import { IdentityFailure, isIdentityFailure } from '../src/modules/identity/provider.js';
import { JwtError, isJwtError } from '../src/modules/identity/jwt.js';

/** Structurally identical, deliberately NOT the imported class — a second realm. */
class ForeignHttpProblem extends Error {
  constructor(
    readonly status: number,
    readonly type: string,
    readonly title: string,
    readonly detail?: string,
    readonly extensions?: Record<string, unknown>,
    readonly headers?: Record<string, string>,
  ) {
    super(detail ?? title);
    this.name = 'HttpProblem';
    Object.defineProperty(this, Symbol.for('talon.httpProblem'), { value: true });
  }
}

/** The real handler, on a bare app: no database, no hooks, just rendering. */
async function appThrowing(error: unknown) {
  const app = fastify({ exposeHeadRoutes: false, logger: false });
  app.setErrorHandler(problemErrorHandler);
  app.get('/boom', async () => {
    throw error;
  });
  await app.ready();
  return app;
}

it('recognises a problem from another copy of the module', () => {
  const foreign = new ForeignHttpProblem(401, 'urn:talon:error:invalid-credentials', 'Unauthorized');
  // `instanceof` is false here — that is the whole point of the brand.
  expect(foreign instanceof HttpProblem).toBe(false);
  expect(isHttpProblem(foreign)).toBe(true);
});

it('still recognises one from this copy', () => {
  expect(isHttpProblem(new HttpProblem(404, 'urn:talon:error:not-found', 'Not found'))).toBe(true);
});

it('does not mistake a plain error, or a shape that merely looks similar, for a problem', () => {
  expect(isHttpProblem(new Error('boom'))).toBe(false);
  expect(isHttpProblem({ status: 401, type: 'x', title: 'y' })).toBe(false);
  expect(isHttpProblem(null)).toBe(false);
  expect(isHttpProblem('nope')).toBe(false);
});

it('keeps the brand off anything that serializes or enumerates', () => {
  // It must never reach a response body or a log line. Asserted on the property
  // descriptor and on a spread copy: `Object.keys` and `JSON.stringify` skip
  // symbol keys unconditionally, so asserting through those would pass even with
  // the brand made enumerable, or removed altogether.
  const problem = new HttpProblem(429, 'urn:talon:error:rate-limited', 'Too many requests');
  const brand = Symbol.for('talon.httpProblem');
  const descriptor = Object.getOwnPropertyDescriptor(problem, brand);
  expect(descriptor).toBeDefined();
  expect(descriptor?.enumerable).toBe(false);
  expect(descriptor?.writable).toBe(false);
  // A spread copies enumerable own properties INCLUDING symbol-keyed ones, so
  // this is the assertion that fails if `enumerable` is ever flipped.
  expect(Object.getOwnPropertySymbols({ ...problem })).not.toContain(brand);
  expect(Object.keys(problem)).not.toContain('Symbol(talon.httpProblem)');
});

it('brands the other two errors on the auth chain the same way', () => {
  // `IdentityFailure` and `JwtError` are checked by predicate for the same
  // reason `HttpProblem` is: `asProblem` returns anything that fails the check
  // unchanged, and an unmapped provider failure is a 500 where a 401 belongs.
  expect(isIdentityFailure(new IdentityFailure('invalid_credentials'))).toBe(true);
  expect(isJwtError(new JwtError('expired'))).toBe(true);
  expect(isIdentityFailure(new Error('boom'))).toBe(false);
  expect(isJwtError(new Error('boom'))).toBe(false);
  // Neither brand answers for the other, and neither answers for a problem.
  expect(isIdentityFailure(new JwtError('expired'))).toBe(false);
  expect(isHttpProblem(new IdentityFailure('invalid_credentials'))).toBe(false);
  for (const error of [new IdentityFailure('rate_limited', 'slow down', 5), new JwtError('expired')]) {
    expect(Object.getOwnPropertySymbols({ ...error })).toHaveLength(0);
  }
});

it('renders a cross-realm 401 as a 401, not a 500', async () => {
  // The regression itself, at the layer it was reported on: the response.
  const app = await appThrowing(
    new ForeignHttpProblem(
      401,
      'urn:talon:error:invalid-credentials',
      'Invalid credentials',
      'Those credentials do not match an account.',
    ),
  );
  try {
    const res = await app.inject({ method: 'GET', url: '/boom' });
    expect(res.statusCode).toBe(401);
    expect(res.headers['content-type']).toContain('application/problem+json');
    expect(res.json()).toMatchObject({
      type: 'urn:talon:error:invalid-credentials',
      title: 'Invalid credentials',
      status: 401,
      detail: 'Those credentials do not match an account.',
      instance: '/boom',
    });
    // A 401 without a challenge is not a 401 anyone can act on.
    expect(res.headers['www-authenticate']).toBe('Bearer');
  } finally {
    await app.close();
  }
});

it('keeps Retry-After on a cross-realm 429', async () => {
  // `problemErrorHandler` checks the brand a SECOND time to decide whether the
  // error carries headers. That call is what puts the backoff on the wire, and
  // nothing else exercises it.
  const app = await appThrowing(
    new ForeignHttpProblem(
      429,
      'urn:talon:error:rate-limited',
      'Too many requests',
      'The identity provider is throttling this deployment.',
      { retryAfter: 5 },
      { 'Retry-After': '5' },
    ),
  );
  try {
    const res = await app.inject({ method: 'GET', url: '/boom' });
    expect(res.statusCode).toBe(429);
    expect(res.headers['retry-after']).toBe('5');
    // In the body as well: `Retry-After` is not CORS-safelisted, so a browser
    // cannot read the header without an explicit expose-headers.
    expect(res.json()).toMatchObject({ status: 429, retryAfter: 5 });
  } finally {
    await app.close();
  }
});

it('still renders an unrecognised error as a 500 with nothing of its own in it', async () => {
  const app = await appThrowing(new Error('secret internal detail'));
  try {
    const res = await app.inject({ method: 'GET', url: '/boom' });
    expect(res.statusCode).toBe(500);
    expect(res.headers['content-type']).toContain('application/problem+json');
    expect(res.json()).toMatchObject({ type: 'urn:talon:error:internal', status: 500 });
    expect(res.body).not.toContain('secret internal detail');
  } finally {
    await app.close();
  }
});
