import { ERROR_TYPES } from '@talon/contracts';
import { NextResponse } from 'next/server';

/**
 * Origin guard for the auth Route Handlers.
 *
 * Next's built-in CSRF origin check covers Server Actions only, never Route
 * Handlers, and there is no middleware here. `SameSite=Lax` protects the routes
 * that *send* the cookie — a cross-site POST does not carry it — but sign-in runs
 * the other way: it **sets** a cookie, which SameSite does not restrict. Since
 * `Request.json()` parses a body whatever its Content-Type, a cross-site
 * `<form enctype="text/plain">` is a simple request, takes no preflight, and would
 * hand the victim's browser a session cookie for the attacker's account. Their
 * work would then land in the attacker's tenant, and every stage_transitions and
 * audit_log row would attribute to the wrong one.
 *
 * Requiring `content-type: application/json` is not a substitute: that only works
 * as a side effect of CORS preflight, which is a different mechanism with
 * different edges. This checks the thing we actually care about.
 */
export function isSameOrigin(request: Request): boolean {
  // Sent by every current browser and not settable from script.
  const site = request.headers.get('sec-fetch-site');
  if (site !== null) return site === 'same-origin';

  // Fallback for clients that omit it. No Origin on a state-changing request is
  // not a pass — it is a request we cannot vouch for.
  const origin = request.headers.get('origin');
  if (origin === null) return false;
  const expected = process.env['APP_ORIGIN'] ?? new URL(request.url).origin;
  return origin === expected;
}

export const crossOriginRejected = (): Response =>
  NextResponse.json(
    { type: ERROR_TYPES.UNAUTHENTICATED, title: 'Cross-origin request rejected', status: 403 },
    { status: 403, headers: { 'content-type': 'application/problem+json' } },
  );
