import { expect, test } from 'vitest';
import { buildApp } from '../src/app.js';
import { PUBLIC_ROUTES } from '../src/route-manifest.js';

const key = (r: { method: string; url: string }) => `${r.method} ${r.url}`;

test('every route is tenant-scoped or explicitly public', async () => {
  const app = await buildApp();
  const protectedSet = new Set(app.protectedRoutes.map(key));
  for (const r of app.allRoutes) {
    if (PUBLIC_ROUTES.has(key(r))) continue;
    expect(
      protectedSet.has(key(r)),
      `${key(r)} is registered outside the authenticated scope and not in PUBLIC_ROUTES`,
    ).toBe(true);
  }
  await app.close();
});

test('every non-public route rejects unauthenticated requests with 401', async () => {
  // Structural check above proves where a route was registered; this proves the
  // authenticate hook actually rejects. Iterates every route on the app (not
  // just the ones known to be in the scope) so a rogue route also fails here —
  // it would answer 200 instead of 401.
  const app = await buildApp();
  for (const r of app.allRoutes) {
    if (PUBLIC_ROUTES.has(key(r))) continue;
    const res = await app.inject({
      method: r.method as 'GET',
      url: r.url.replace(/:[^/]+/g, '00000000-0000-0000-0000-000000000000'),
    });
    expect(res.statusCode, key(r)).toBe(401);
  }
  await app.close();
});

test('public routes respond without credentials', async () => {
  const app = await buildApp();
  for (const k of PUBLIC_ROUTES) {
    const [method, url] = k.split(' ') as [string, string];
    const res = await app.inject({ method: method as 'GET', url });
    expect(res.statusCode, k).toBeLessThan(400);
  }
  await app.close();
});
