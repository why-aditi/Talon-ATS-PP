// Routes allowed to exist outside the authenticated scope. Adding to this set is
// a one-line diff a reviewer cannot miss — that is the point (ARCHITECTURE §4.1).
export const PUBLIC_ROUTES: ReadonlySet<string> = new Set([
  'GET /v1/healthz',
  'GET /v1/readyz',
  // You cannot present a token to the endpoint that issues one.
  'POST /v1/auth/sign-in',
  'POST /v1/auth/refresh',
]);
