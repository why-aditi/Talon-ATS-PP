/**
 * A problem thrown by a DIFFERENT copy of errors.ts must still render as itself.
 *
 * The regression: `render` gated on `instanceof HttpProblem`. The server runs
 * `tsx` over `src/` while workspace packages resolve to `dist/`, so two copies of
 * the class existed and the check silently returned false — every 401 from
 * sign-in left as an opaque 500, and the logger being off meant nothing recorded
 * why. Testing this with the local class would pass against the broken code, so
 * these cases fake the second realm instead.
 */
import { expect, it } from 'vitest';
import { HttpProblem, isHttpProblem } from '../src/errors.js';

/** Structurally identical, deliberately NOT the imported class — a second realm. */
class ForeignHttpProblem extends Error {
  constructor(
    readonly status: number,
    readonly type: string,
    readonly title: string,
    readonly detail?: string,
    readonly headers?: Record<string, string>,
  ) {
    super(detail ?? title);
    this.name = 'HttpProblem';
    Object.defineProperty(this, Symbol.for('talon.httpProblem'), { value: true });
  }
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
  // It must never reach a response body or a log line.
  const problem = new HttpProblem(429, 'urn:talon:error:rate-limited', 'Too many requests');
  expect(Object.keys(problem)).not.toContain('Symbol(talon.httpProblem)');
  expect(JSON.stringify({ ...problem })).not.toContain('httpProblem');
});
