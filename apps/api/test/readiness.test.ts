import { asValue, createContainer, InjectionMode } from 'awilix';
import Fastify from 'fastify';
import postgres from 'postgres';
import { afterEach, describe, expect, it } from 'vitest';
import type { Cradle } from '../src/context.js';
import { publicRoutes } from '../src/public-routes.js';

const apps: ReturnType<typeof Fastify>[] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

async function appWithDatabase(url: string) {
  const app = Fastify({ logger: false });
  apps.push(app);
  const sql = postgres(url, { connect_timeout: 1, max: 1, onnotice: () => {} });
  app.addHook('onClose', async () => sql.end({ timeout: 0 }));
  const container = createContainer<Cradle>({ injectionMode: InjectionMode.PROXY });
  container.register({ sql: asValue(sql) });
  app.decorate('container', container);
  await app.register(publicRoutes, { prefix: '/v1' });
  return app;
}

describe('readiness', () => {
  it('returns 503 when the database cannot be reached', async () => {
    const app = await appWithDatabase('postgres://invalid:invalid@127.0.0.1:1/invalid');
    const response = await app.inject('/v1/readyz');
    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({ ok: false });
  });

  it('keeps liveness independent of the database', async () => {
    const app = await appWithDatabase('postgres://invalid:invalid@127.0.0.1:1/invalid');
    const response = await app.inject('/v1/healthz');
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ok: true });
  });
});
