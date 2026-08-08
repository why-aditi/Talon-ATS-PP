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
import { createHash } from 'node:crypto';
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

export function testConfig(overrides: { poolMax?: number; jit?: string } = {}): ApiConfig {
  return loadConfig({
    API_DATABASE_URL: APP_URL,
    API_DB_POOL_MAX: String(overrides.poolMax ?? 5),
    // Absent by default, and that default is the assertion: every other file in
    // this suite runs with just-in-time provisioning OFF, so if turning it on
    // changed any existing behaviour those files would go red.
    ...(overrides.jit === undefined ? {} : { TALON_JIT_PROVISION: overrides.jit }),
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
  /** Raw `TALON_JIT_PROVISION` value. Omitted = the feature is off, as in production by default. */
  jit?: string;
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
      !talonTenant ||
      !acmeTenant ||
      !talonJob ||
      !acmeJob ||
      !talonApplication ||
      !talonNextStage ||
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
async function provision(test: TestApp, person: Person): Promise<string> {
  const { sub } = await test.container.cradle.identityService.provisionCredential({
    email: person.email,
    password: TEST_PASSWORD,
  });
  // The owner connection, because the api role cannot write `users` outside a
  // tenant transaction and must not be able to write this column at all.
  const sql = postgres(OWNER_URL, { max: 1, onnotice: () => {} });
  try {
    const updated = await sql`
      update users set external_id = ${sub} where id = ${person.id}::uuid returning id`;
    // An UPDATE matching nothing is not an error in SQL, and the symptom arrives
    // much later as a 401 from a route that looks unrelated. Say it here instead.
    if (updated.length !== 1) {
      throw new Error(
        `provision: ${person.email} (${person.id}) matched ${updated.length} rows, expected 1`,
      );
    }
  } finally {
    await sql.end();
  }
  return sub;
}

/**
 * A user this file alone owns.
 *
 * WHY THIS EXISTS. Nine suites authenticated as the same two seeded people, and
 * signing in is a WRITE: `provision` sets `users.external_id`, `auth-chain`
 * sets `tokens_valid_after`, and a role could be changed as easily. Suites were
 * mutating a row other suites depended on, and vitest does not fix the file order,
 * so which suite saw which state varied run to run.
 *
 * WHAT IS NOT CLAIMED. This is not a diagnosis of a specific observed flake, and
 * an earlier version of this comment asserted one that the code contradicts. For
 * the record, so nobody re-derives them:
 *
 *   - Files do NOT run in parallel. `vitest.config.ts` sets
 *     `fileParallelism: false`.
 *   - Re-provisioning does NOT churn the subject. `createUser` catches
 *     `UsernameExistsException`, re-reads via `AdminGetUser` and returns the
 *     ORIGINAL sub, so a second `signIn` for the same person writes the value
 *     `external_id` already held.
 *   - A second app in one file does NOT get an empty stub. `stub` above is a
 *     module-level singleton, reference-counted, and `stop()` does not clear its
 *     user map.
 *
 * So the mechanism behind the reported flake is UNKNOWN. What this removes is the
 * shared mutable identity that made a mechanism possible at all; if a suite still
 * goes red and green with no code change, this is not the cause and the search
 * should start elsewhere.
 *
 * `label` is the test file. Deriving the id and address from it means a crashed
 * run leaves rows that name their owner instead of rows to guess at, and that a
 * file reuses its row rather than accumulating one per run. It does NOT prevent
 * collisions — two files choosing the SAME label would share a row, which is the
 * very thing this exists to stop. Labels are unique by inspection.
 */
export async function dedicatedUser(
  test: TestApp,
  label: string,
  options: { role?: string; tenantId: string } & { name?: string },
): Promise<{ person: Person; session: Session }> {
  const slug = label
    .replace(/[^a-z0-9]/gi, '')
    .toLowerCase()
    .slice(0, 20);
  // Hex, from a digest of the label: a UUID has no room for words, and slicing the
  // label straight in produced `ffffffff-auth-...`, which Postgres rejects outright.
  // The leading `ffffffff` still marks it as test-made and sorts it after every
  // UUIDv7 the seed produced.
  const hex = createHash('sha256').update(label).digest('hex');
  const id = `ffffffff-${hex.slice(0, 4)}-4000-8000-${hex.slice(4, 16)}`;
  // The digest goes in the ADDRESS too, not just the id. `users.email` is citext
  // and globally unique (0001), and the slug is lossy — it strips punctuation,
  // folds case and truncates at 20 — so two labels can share a slug while holding
  // different ids. That combination raises a unique violation on email instead of
  // taking the `on conflict (id)` branch below, and it raises inside a `beforeAll`.
  // The slug stays in front so the row is still readable at a glance.
  const email = `${slug}-${hex.slice(0, 8)}@dedicated.test`;
  const role = options.role ?? 'recruiter';

  const sql = postgres(OWNER_URL, { max: 1, onnotice: () => {} });
  try {
    // Owner connection: the api role cannot write `users` outside a tenant
    // transaction, and must not be able to write `external_id` at all.
    await sql`
      insert into users (id, tenant_id, email, name, role, timezone)
      values (${id}::uuid, ${options.tenantId}::uuid, ${email},
              ${options.name ?? `Dedicated ${slug}`}, ${role}, 'UTC')
      on conflict (id) do update
        set role = excluded.role, tenant_id = excluded.tenant_id, name = excluded.name`;
  } finally {
    await sql.end();
  }

  const person: Person = { id, email, name: options.name ?? `Dedicated ${slug}`, role };
  return { person, session: await signIn(test, person) };
}

/**
 * Removes the row `dedicatedUser` created, when history allows it — which is
 * USUALLY NOT. Read this as "tidy up if possible", not as cleanup you can rely on.
 *
 * `dedicatedUser` completes a real sign-in, and a successful sign-in writes an
 * `audit_log` row whose `actor_id` is the new user. `audit_log` and
 * `stage_transitions` are append-only, and their FKs to `users` are exactly what
 * stops a delete from quietly orphaning history. So the delete raises for nearly
 * every caller by construction — `audit.test.ts` is the only one where it lands,
 * because its `afterAll` removes the authentication rows first. Everywhere else
 * this call is a no-op that reads like cleanup, and that is fine: forcing it would
 * mean deleting the history those tables exist to keep.
 *
 * Leaving the row costs nothing. `seed()` truncates `users ... cascade` before
 * every run, so a survivor lives until the next `pnpm test` and no further.
 */
export async function removeDedicatedUser(person: Person): Promise<void> {
  const sql = postgres(OWNER_URL, { max: 1, onnotice: () => {} });
  try {
    await sql`delete from users where id = ${person.id}::uuid`;
  } catch (error) {
    // 23503 only — foreign_key_violation, the expected outcome above. A blanket
    // catch here would also swallow a dropped connection, a revoked grant or a
    // typo in the statement, and report all three as successful cleanup.
    if ((error as { code?: string }).code !== '23503') throw error;
  } finally {
    await sql.end();
  }
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

/**
 * Deletes jobs a test created, and their stages.
 *
 * The suite shares one seeded database, and `jobs-list.test.ts` asserts the
 * exact set of departments and their order. A test that creates a job and does
 * not remove it breaks assertions in another file — decided by which one vitest
 * happened to run first, which is the worst kind of failure to debug. The same
 * trap `isolation.test.ts` documents for the stage and rank cases.
 *
 * Stages first: `job_stages` has a composite FK on the job.
 */
export async function deleteJobs(ids: readonly string[]): Promise<void> {
  if (ids.length === 0) return;
  const sql = postgres(OWNER_URL, { max: 1, onnotice: () => {} });
  try {
    await sql`delete from job_stages where job_id = any(${ids as string[]}::uuid[])`;
    await sql`delete from jobs where id = any(${ids as string[]}::uuid[])`;
  } finally {
    await sql.end();
  }
}

/**
 * Removes applications a test created, with the rows that hang off them.
 *
 * `stage_transitions` is append-only for the APP role — there is no delete grant
 * — but this runs on the owner connection, which is the point: test data is
 * removed by the operator, not by the application, exactly as it would be in
 * production. Without it, `board.test.ts` counts an extra card on ENG-204 and
 * which file fails depends on vitest's run order.
 *
 * Candidates go too when nothing else references them: an orphan person left
 * behind would show up in any future candidate-list assertion.
 */
export async function deleteApplications(ids: readonly string[]): Promise<void> {
  if (ids.length === 0) return;
  const sql = postgres(OWNER_URL, { max: 1, onnotice: () => {} });
  try {
    const list = ids as string[];
    const candidates = await sql<{ candidate_id: string }[]>`
      select candidate_id from applications where id = any(${list}::uuid[])`;
    await sql`delete from stage_transitions where application_id = any(${list}::uuid[])`;
    await sql`delete from activities where application_id = any(${list}::uuid[])`;
    await sql`delete from audit_log where entity_type = 'application' and entity_id = any(${list}::uuid[])`;
    await sql`delete from outbox where aggregate = 'application' and aggregate_id = any(${list}::uuid[])`;
    await sql`delete from applications where id = any(${list}::uuid[])`;
    const orphans = candidates.map((c) => c.candidate_id);
    if (orphans.length > 0) {
      await sql`
        delete from candidates c
        where c.id = any(${orphans}::uuid[])
          and not exists (select 1 from applications a where a.candidate_id = c.id)`;
    }
  } finally {
    await sql.end();
  }
}
