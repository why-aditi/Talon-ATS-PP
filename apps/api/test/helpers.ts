/**
 * Shared harness: an app wired to the test database and to a fake Cognito, seeded
 * people who can actually sign in, and the ids the isolation suite needs.
 *
 * Since `LocalIdentityProvider` was removed (spec 002 open question 1) every
 * signed-in test in this suite authenticates against `CognitoStub` — the network
 * stub is the only path to a token, so it is started here rather than in each
 * file that happens to need one.
 */
import { asValue, type AwilixContainer } from 'awilix';
import type { FastifyInstance } from 'fastify';
import postgres from 'postgres';
import { buildApp } from '../src/app.js';
import { loadConfig, type ApiConfig } from '../src/config.js';
import { buildContainer } from '../src/container.js';
import type { Cradle } from '../src/context.js';
import { CognitoStub } from './cognito-stub.js';
import { APP_URL, OWNER_URL } from './urls.js';

/** Long enough for NewPasswordSchema; identical for everyone in the suite. */
export const TEST_PASSWORD = 'correct-horse-battery-staple';

/**
 * One fake pool per worker, reference-counted.
 *
 * `CognitoStub.start()` mutates process env and `globalThis.fetch`, and restores
 * what it found on `stop()`. Two overlapping stubs would restore each other's
 * values in the wrong order, so files that build several apps (route-manifest
 * builds three) share this one and the last `close()` tears it down.
 */
const stub = new CognitoStub();
let stubUsers = 0;

async function acquireStub(): Promise<CognitoStub> {
  if (stubUsers === 0) await stub.start();
  stubUsers += 1;
  return stub;
}

async function releaseStub(): Promise<void> {
  stubUsers -= 1;
  if (stubUsers === 0) await stub.stop();
}

export function testConfig(overrides: { poolMax?: number } = {}): ApiConfig {
  return loadConfig({
    API_DATABASE_URL: APP_URL,
    API_DB_POOL_MAX: String(overrides.poolMax ?? 5),
    // Not the published constant: `loadConfig` refuses that one outright, and
    // the suite should be signing tokens with a key a real deployment could use.
    TALON_JWT_SECRET: 'test-signing-key-not-the-published-default',
    COGNITO_REGION: stub.region,
    COGNITO_USER_POOL_ID: stub.userPoolId,
    COGNITO_CLIENT_ID: stub.clientId,
  });
}

export interface TestApp {
  app: FastifyInstance;
  container: AwilixContainer<Cradle>;
  /** The fake Cognito this app is pointed at. Exposed so a test can mint an id token
   *  for the federated sign-in path, which has no other way to obtain one. */
  stub: CognitoStub;
  close(): Promise<void>;
}

export interface StartAppOptions {
  poolMax?: number;
  /**
   * Called once per statement the api actually sends. This is how "one query,
   * not N+1" is asserted: an N+1 shows up here as N+1 calls.
   */
  onQuery?: (query: string) => void;
}

export async function startApp(overrides: StartAppOptions = {}): Promise<TestApp> {
  const cognito = await acquireStub();
  const config = testConfig(overrides);
  const container = buildContainer(config);
  const { onQuery } = overrides;
  if (onQuery) {
    // The pool buildContainer made is lazy and has never connected; ending it
    // costs nothing and leaves exactly one pool for close() to tear down.
    await container.cradle.sql.end();
    container.register({
      sql: asValue(
        postgres(config.databaseUrl, {
          max: config.poolMax,
          onnotice: () => {},
          debug: (_connection, query) => onQuery(query),
        }),
      ),
    });
  }
  const app = await buildApp({ config, container });
  return {
    app,
    container,
    stub: cognito,
    async close() {
      await app.close();
      await container.cradle.sql.end();
      await releaseStub();
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
  talon: {
    tenantId: string;
    recruiter: Person;
    member: Person;
    jobId: string;
    jobReqCode: string;
    /** A real ENG-204 application and one of its stages, so the board routes can be
     *  addressed by a hostile tenant with a body that passes validation. */
    applicationId: string;
    stageId: string;
    nextStageId: string;
    stageTemplateId: string;
  };
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
    const [talonApplication] = await sql<{ id: string; current_stage_id: string }[]>`
      select a.id, a.current_stage_id from applications a
      join job_stages js on js.id = a.current_stage_id
      where a.job_id = ${talonJob?.id ?? null} and js.canonical = 'applied'
      order by a.board_rank collate "C" limit 1`;
    const [talonNextStage] = await sql<{ id: string }[]>`
      select id from job_stages where job_id = ${talonJob?.id ?? null} and canonical = 'screen'`;
    // Tenant A's pipeline. The POST /v1/jobs hostile case names it, so the
    // attacker sends a body that VALIDATES and is refused on tenancy alone.
    const [talonTemplate] = await sql<{ id: string }[]>`
      select id from stage_templates where tenant_id = ${talonTenant?.id ?? null} limit 1`;
    if (
      !talonTenant || !acmeTenant || !talonJob || !acmeJob || !talonApplication || !talonNextStage ||
      !talonTemplate
    ) {
      throw new Error('seed is incomplete');
    }
    return {
      talon: {
        tenantId: talonTenant.id,
        recruiter: find('maya@taloninc.com'),
        member: find('lin@taloninc.com'),
        jobId: talonJob.id,
        jobReqCode: talonJob.req_code,
        applicationId: talonApplication.id,
        stageId: talonApplication.current_stage_id,
        nextStageId: talonNextStage.id,
        stageTemplateId: talonTemplate.id,
      },
      acme: { tenantId: acmeTenant.id, admin: find('beth@acme.test'), jobId: acmeJob.id },
    };
  } finally {
    await sql.end();
  }
}

/**
 * Provisions a seeded person the way `scripts/seed-identities.ts` does: create
 * the credential at the identity provider, then point `users.external_id` at the
 * subject it allocated.
 *
 * Both halves matter. Without the second, Cognito authenticates the person and
 * `auth_user_by_sub` resolves nobody — sign-in succeeds and the very next
 * request 401s. Returns the subject, because it is what the token's `sub` is and
 * therefore what a hand-minted token has to carry.
 */
export async function provision(test: TestApp, person: Person): Promise<string> {
  const { sub } = await test.container.cradle.identityService.provisionCredential({
    email: person.email,
    password: TEST_PASSWORD,
  });
  // The owner connection, because the api role cannot write `users` outside a
  // tenant transaction and must not be able to write this column at all.
  const sql = postgres(OWNER_URL, { max: 1, onnotice: () => {} });
  try {
    await sql`update users set external_id = ${sub} where id = ${person.id}::uuid`;
  } finally {
    await sql.end();
  }
  return sub;
}

export interface Session {
  accessToken: string;
  refreshToken: string;
  /** The identity provider's subject — the value in the access token's `sub`. */
  sub: string;
}

/** Provisions if needed, then signs in over HTTP — the real public route. */
export async function signIn(test: TestApp, person: Person): Promise<Session> {
  const sub = await provision(test, person);
  const response = await test.app.inject({
    method: 'POST',
    url: '/v1/auth/sign-in',
    payload: { email: person.email, password: TEST_PASSWORD },
  });
  if (response.statusCode !== 200) {
    throw new Error(`sign-in for ${person.email} failed: ${response.statusCode} ${response.body}`);
  }
  const body = response.json<{ accessToken: string; refreshToken: string }>();
  return { accessToken: body.accessToken, refreshToken: body.refreshToken, sub };
}

export const bearer = (session: Session): Record<string, string> => ({
  authorization: `Bearer ${session.accessToken}`,
});
