import { expect, test } from 'vitest';
import { ERROR_TYPES } from '@talon/contracts';
import { PUBLIC_ROUTES } from '../src/route-manifest.js';
import { startApp } from './helpers.js';

const key = (r: { method: string; url: string }) => `${r.method} ${r.url}`;

test('every route is tenant-scoped or explicitly public', async () => {
  const test = await startApp();
  const protectedSet = new Set(test.app.protectedRoutes.map(key));
  for (const r of test.app.allRoutes) {
    if (PUBLIC_ROUTES.has(key(r))) continue;
    expect(
      protectedSet.has(key(r)),
      `${key(r)} is registered outside the authenticated scope and not in PUBLIC_ROUTES`,
    ).toBe(true);
  }
  await test.close();
});

test('every non-public route rejects unauthenticated requests with 401', async () => {
  // Structural check above proves where a route was registered; this proves the
  // authenticate hook actually rejects. Iterates every route on the app (not
  // just the ones known to be in the scope) so a rogue route also fails here —
  // it would answer 200 instead of 401.
  const test = await startApp();
  for (const r of test.app.allRoutes) {
    if (PUBLIC_ROUTES.has(key(r))) continue;
    const res = await test.app.inject({
      method: r.method as 'GET',
      url: r.url.replace(/:[^/]+/g, '00000000-0000-0000-0000-000000000000'),
    });
    expect(res.statusCode, key(r)).toBe(401);
    expect(res.headers['content-type'], key(r)).toContain('application/problem+json');
    expect(res.json<{ type: string }>().type, key(r)).toBe(ERROR_TYPES.UNAUTHENTICATED);
    // A 401 a client cannot act on is a 401 nobody handles (RFC 9110 §11.6.1).
    expect(res.headers['www-authenticate'], key(r)).toBe('Bearer');
  }
  await test.close();
});

test('public routes are reachable without credentials', async () => {
  // Deliberately not "responds < 400": POST /v1/auth/sign-in with no body is a
  // 400, and that is the correct answer. What is being asserted is that no
  // public route is gated on a token.
  const test = await startApp();
  for (const k of PUBLIC_ROUTES) {
    const [method, url] = k.split(' ') as [string, string];
    const res = await test.app.inject({ method: method as 'GET', url });
    expect(res.statusCode, k).not.toBe(401);
    expect(res.statusCode, k).not.toBe(403);
  }
  await test.close();
});
