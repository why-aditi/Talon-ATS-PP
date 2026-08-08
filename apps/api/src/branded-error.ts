/**
 * Symbol brands for the errors that have to survive a `catch` written in another
 * file — `HttpProblem`, `IdentityFailure`, `JwtError`. Every one of them is on
 * the auth chain, where a predicate that answers false renders a 401 as a 500.
 *
 * `instanceof` compares class identity, so it answers false whenever the thrower
 * and the catcher hold different copies of the module that declares the class.
 * A `Symbol.for` key is registry-global, so a brand check answers the question
 * that was actually being asked — "is this one of ours" — rather than "was this
 * built by MY copy of the constructor".
 *
 * ── What we know about the incident that prompted this, and what we do not ──
 *
 * Every failed sign-in on a dev server returned an opaque 500 and wrote
 * `reason = urn:talon:error:internal` to `audit_log`, contradicting the response
 * the caller would have received had rendering worked.
 *
 * The commit that introduced this brand asserted the mechanism: two copies of
 * `errors.ts`, because "the server runs tsx over src/ while workspace packages
 * resolve to dist/". That explanation is WRONG for this file and has been
 * removed rather than repeated. `errors.ts` is not a workspace package: every
 * importer reaches it by relative path (`./errors.js`, `../../errors.js`),
 * `tsconfig.base.json` declares no `paths`, and nothing imports `apps/api/dist`.
 * That route to a second copy does not exist here.
 *
 * The real mechanism is NOT established. Evidence against two copies in one
 * process: `test/audit.test.ts` asserted the 401 and the `invalid-credentials`
 * audit reason through `app.inject()` before the fix, and passed — so in the
 * vitest process `instanceof` was answering true all along. Evidence about the
 * dev server is missing rather than contradictory, because its logger was off
 * (see `app.ts`) and the cause of every 5xx was discarded; a stale long-running
 * process, or a provider error that never mapped to an `IdentityFailure` at all,
 * fit the observations equally well. Nothing reproduces it today.
 *
 * So the brand is kept as a defence, not as a diagnosis: it costs three lines
 * and no measurable runtime, and a check that cannot be defeated by module
 * identity is strictly better than one that can — the same reasoning that
 * already has `cognito-provider.ts` matching AWS exceptions by name. The change
 * that will actually explain a recurrence is the logger, not this file.
 */

/**
 * Marks `target` as carrying `key`. Non-enumerable and non-writable, so the
 * brand never reaches a response body, a JSON log line, or a spread copy.
 */
export function brandError(target: object, key: symbol): void {
  Object.defineProperty(target, key, { value: true, enumerable: false, writable: false });
}

/** True when `value` carries `key`, whichever copy of a module branded it. */
export function isBrandedError(value: unknown, key: symbol): boolean {
  return typeof value === 'object' && value !== null && key in value;
}
