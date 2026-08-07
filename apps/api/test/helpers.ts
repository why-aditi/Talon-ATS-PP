/**
 * Shared harness: an app wired to the test database, seeded people who can
 * actually sign in, and the ids the isolation suite needs.
 */
import type { AwilixContainer } from 'awilix';
import type { FastifyInstance } from 'fastify';
import postgres from 'postgres';
import { buildApp } from '../src/app.js';
import { loadConfig, type ApiConfig } from '../src/config.js';
import { buildContainer } from '../src/container.js';
import type { Cradle } from '../src/context.js';
import { APP_URL, OWNER_URL } from './urls.js';

/** Long enough for NewPasswordSchema; identical for everyone in the suite. */
export const TEST_PASSWORD = 'correct-horse-battery-staple';

export function testConfig(overrides: { poolMax?: number } = {}): ApiConfig {
  return loadConfig({
    API_DATABASE_URL: APP_URL,
    API_DB_POOL_MAX: String(overrides.poolMax ?? 5),
    // Not the published default: the suite should fail if the fallback is ever
    // load-bearing in a way a real deployment would not tolerate.
    TALON_JWT_SECRET: 'test-signing-key-not-the-published-default',
  });
}

export interface TestApp {
  app: FastifyInstance;
  container: AwilixContainer<Cradle>;
  close(): Promise<void>;
}

export async function startApp(overrides: { poolMax?: number } = {}): Promise<TestApp> {
  const config = testConfig(overrides);
  const container = buildContainer(config);
  const app = await buildApp({ config, container });
  return {
    app,
    container,
    async close() {
      await app.close();
      await container.cradle.sql.end();
    },
  };
}

export interface Person {
  id: string;
  email: string;
  name: string;
  role: string;
}

export interface Fixtures {
  talon: { tenantId: string; recruiter: Person; member: Person; jobId: string; jobReqCode: string };
  acme: { tenantId: string; admin: Person; jobId: string };
}

/** Reads the seeded ids as the owner. Fixtures are setup, not the thing tested. */
export async function loadFixtures(): Promise<Fixtures> {
  const sql = postgres(OWNER_URL, { max: 1, onnotice: () => {} });
  try {
    const people = await sql<Person[]>`
      select id, email, name, role from users
      where email in ('maya@taloninc.com', 'lin@taloninc.com', 'beth@acme.test')`;
    const find = (email: string): Person => {
      const person = people.find((p) => p.email === email);
      if (!person) throw new Error(`seed is missing ${email}`);
      return person;
    };
    const [talonTenant] = await sql<{ id: string }[]>`select id from tenants where slug = 'talon'`;
    const [acmeTenant] = await sql<{ id: string }[]>`select id from tenants where slug = 'acme'`;
    // ENG-204 is the job with a comp band — the one acceptance 4 turns on.
    const [talonJob] = await sql<{ id: string; req_code: string }[]>`
      select id, req_code from jobs where req_code = 'ENG-204'`;
    const [acmeJob] = await sql<{ id: string }[]>`select id from jobs where req_code = 'ACM-001'`;
    if (!talonTenant || !acmeTenant || !talonJob || !acmeJob) throw new Error('seed is incomplete');
    return {
      talon: {
        tenantId: talonTenant.id,
        recruiter: find('maya@taloninc.com'),
        member: find('lin@taloninc.com'),
        jobId: talonJob.id,
        jobReqCode: talonJob.req_code,
      },
      acme: { tenantId: acmeTenant.id, admin: find('beth@acme.test'), jobId: acmeJob.id },
    };
  } finally {
    await sql.end();
  }
}

/**
 * Gives a seeded person a local credential. The seed writes `users` rows only —
 * credentials live in the identity provider's own store, which in AWS is not
 * this database at all.
 */
export async function provision(test: TestApp, person: Person): Promise<void> {
  await test.container.cradle.identityService.provisionCredential({
    sub: person.id,
    email: person.email,
    password: TEST_PASSWORD,
  });
}

export interface Session {
  accessToken: string;
  refreshToken: string;
}

/** Provisions if needed, then signs in over HTTP — the real public route. */
export async function signIn(test: TestApp, person: Person): Promise<Session> {
  await provision(test, person);
  const response = await test.app.inject({
    method: 'POST',
    url: '/v1/auth/sign-in',
    payload: { email: person.email, password: TEST_PASSWORD },
  });
  if (response.statusCode !== 200) {
    throw new Error(`sign-in for ${person.email} failed: ${response.statusCode} ${response.body}`);
  }
  const body = response.json<Session>();
  return { accessToken: body.accessToken, refreshToken: body.refreshToken };
}

export const bearer = (session: Session): Record<string, string> => ({
  authorization: `Bearer ${session.accessToken}`,
});
