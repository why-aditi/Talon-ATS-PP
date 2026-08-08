/**
 * The migration surface, run by an owner that is NOT a superuser and does NOT
 * hold BYPASSRLS — i.e. the RDS/Aurora master-user shape.
 *
 * Why this file exists at all. Every other suite in this repo migrates as
 * `talon`, which is `rolsuper` + `rolbypassrls`, so `force row level security`
 * never applies to it and every `security definer` function in the schema reads
 * and writes as if no policy existed. That made a whole class of defect
 * invisible: a definer function is exempt from FORCE only when its owner can
 * bypass RLS, and on a managed instance the owner cannot. The blindness was the
 * real defect — 0003's own header already predicted the failure ("the Aurora
 * role in spec 002 must carry BYPASSRLS or own an exception policy") and nothing
 * could prove which of the two we had.
 *
 * So: build the hostile shape on purpose. A separate role, `nosuperuser
 * nobypassrls`, owning a separate database, with the real migrations applied by
 * it, and then the real calls the api makes — as `talon_app`, through the
 * definer functions — asserted end to end.
 *
 * Reading back: the succeeded row is read as `talon_app` under its own tenant,
 * which needs no privilege at all. The FAILED row carries a null tenant and is
 * readable by nobody through RLS (deliberately — spec 002 §12.3 defers the
 * system-row reader), so that one assertion connects as the cluster superuser.
 * The superuser observes; it never writes. The write is what is under test.
 */
import { afterAll, beforeAll, expect, it } from 'vitest';
import postgres from 'postgres';
import { uuidv7 } from 'uuidv7';
import { migrate } from '../src/migrate.js';
import { MAINTENANCE_URL, OWNER_URL, TEST_DATABASE_NAME } from './urls.js';

/**
 * Loopback-only, and worthless as a secret in the same way `talon_app`'s local
 * password is: this role exists for the length of this file, on a database this
 * file creates and drops, on the developer's own machine.
 */
const NOSUPER_ROLE = 'talon_nosuper_owner';
const NOSUPER_PASSWORD = 'talon_nosuper_owner';
const NOSUPER_DATABASE = `${TEST_DATABASE_NAME}_nosuper`;

function urlFor(user: string, password: string, database: string): string {
  const url = new URL(OWNER_URL);
  url.username = user;
  url.password = password;
  url.pathname = `/${database}`;
  return url.toString();
}

const NOSUPER_URL = urlFor(NOSUPER_ROLE, NOSUPER_PASSWORD, NOSUPER_DATABASE);
const APP_PASSWORD = process.env['TALON_APP_PASSWORD'] ?? 'talon_app';
const APP_ON_NOSUPER_URL = urlFor('talon_app', APP_PASSWORD, NOSUPER_DATABASE);
const SUPERUSER_ON_NOSUPER_URL = (() => {
  const url = new URL(OWNER_URL);
  url.pathname = `/${NOSUPER_DATABASE}`;
  return url.toString();
})();

const tenantA = uuidv7();
const tenantB = uuidv7();
const actorA = uuidv7();
const emailA = `nosuper-a-${actorA.slice(0, 8)}@taloninc.com`;

let admin: postgres.Sql;
let owner: postgres.Sql;
let app: postgres.Sql;
let superuser: postgres.Sql;

interface AuditRow {
  tenant_id: string | null;
  actor_id: string | null;
  action: string;
  entity_type: string;
  after: { outcome?: string; email?: string; reason?: string };
  ip: string | null;
  request_id: string | null;
}

const AUDIT_COLUMNS = `tenant_id, actor_id, action, entity_type, after, host(ip) as ip, request_id`;

beforeAll(async () => {
  admin = postgres(MAINTENANCE_URL, { max: 1, onnotice: () => {} });

  await admin.unsafe(`drop database if exists "${NOSUPER_DATABASE}" with (force)`);
  // NOCREATEROLE as well as NOSUPERUSER/NOBYPASSRLS: the RDS master user can
  // create roles, but a migration that needed to would be violating CLAUDE.md
  // §4.11 anyway, so the tighter shape is the honest one to test against.
  await admin.unsafe(`do $$
    begin
      if not exists (select from pg_roles where rolname = '${NOSUPER_ROLE}') then
        create role ${NOSUPER_ROLE} login;
      end if;
    end $$`);
  await admin.unsafe(
    `alter role ${NOSUPER_ROLE} login nosuperuser nobypassrls nocreaterole nocreatedb ` +
      `password '${NOSUPER_PASSWORD}'`,
  );
  await admin.unsafe(`create database "${NOSUPER_DATABASE}" owner ${NOSUPER_ROLE}`);

  // ensureAppRole() would ALTER ROLE talon_app if TALON_APP_PASSWORD were set
  // explicitly, and this owner has no CREATEROLE — which is the point of the
  // file. talon_app already exists cluster-wide from the main global setup, so
  // the branch that runs here is the no-op one.
  const configured = process.env['TALON_APP_PASSWORD'];
  delete process.env['TALON_APP_PASSWORD'];
  try {
    await migrate('up', NOSUPER_URL);
  } finally {
    if (configured !== undefined) process.env['TALON_APP_PASSWORD'] = configured;
  }

  owner = postgres(NOSUPER_URL, { max: 1, onnotice: () => {} });
  // Fixtures written by the owner THROUGH the tenant policy, not around it:
  // `app.tenant_id` is set first and the rows satisfy the WITH CHECK. A
  // non-bypassing owner has no other way in, which is itself worth pinning.
  for (const [tenantId, slug] of [
    [tenantA, 'nosuper-a'],
    [tenantB, 'nosuper-b'],
  ] as const) {
    await owner`select set_config('app.tenant_id', ${tenantId}, false)`;
    await owner`insert into tenants (id, name, slug) values (${tenantId}, ${slug}, ${slug})`;
  }
  await owner`select set_config('app.tenant_id', ${tenantA}, false)`;
  await owner`insert into users (id, tenant_id, email, name, role)
              values (${actorA}, ${tenantA}, ${emailA}, 'Nosuper A', 'recruiter')`;
  await owner`select set_config('app.tenant_id', '', false)`;

  app = postgres(APP_ON_NOSUPER_URL, { max: 1, onnotice: () => {} });
  superuser = postgres(SUPERUSER_ON_NOSUPER_URL, { max: 1, onnotice: () => {} });
});

afterAll(async () => {
  await Promise.all([owner?.end(), app?.end(), superuser?.end()]);
  await admin?.unsafe(`drop database if exists "${NOSUPER_DATABASE}" with (force)`);
  // Best effort: the role owns nothing outside the database just dropped, but a
  // leftover login role on a loopback dev cluster is not worth failing a suite.
  try {
    await admin?.unsafe(`drop role if exists ${NOSUPER_ROLE}`);
  } catch {
    /* ignore */
  }
  await admin?.end();
});

it('the migration role really is nosuperuser nobypassrls, and owns the schema', async () => {
  // If this ever passes vacuously — a superuser owner sneaking back in — every
  // other assertion in this file becomes decoration.
  const [role] = await owner<{ rolsuper: boolean; rolbypassrls: boolean }[]>`
    select rolsuper, rolbypassrls from pg_roles where rolname = current_user`;
  expect(role).toEqual({ rolsuper: false, rolbypassrls: false });
  const [table] = await owner<{ owner: string }[]>`
    select pg_get_userbyid(relowner) as owner from pg_class where oid = 'audit_log'::regclass`;
  expect(table?.owner).toBe(NOSUPER_ROLE);
});

it('a FAILED sign-in is recorded — the null-tenant row the trail depends on', async () => {
  // The row that stops the audit trail becoming an account-enumeration oracle:
  // a wrong password for a real address and one for an address nobody owns must
  // produce the same shape. It carries a null tenant, so under `force row level
  // security` its WITH CHECK is NULL and only an exempt writer can produce it.
  await app`select audit_sign_in('failed'::text, ${'about:blank#invalid-credentials'}::text,
              ${emailA}::text, null::uuid, null::uuid, '127.0.0.1'::text, 'req-failed'::text)`;

  const rows = await superuser.unsafe<AuditRow[]>(
    `select ${AUDIT_COLUMNS} from audit_log where request_id = 'req-failed'`,
  );
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ tenant_id: null, actor_id: null, action: 'auth.sign_in.failed' });
  expect(rows[0]?.after).toEqual({
    outcome: 'failed',
    email: emailA,
    reason: 'about:blank#invalid-credentials',
  });
  expect(rows[0]?.ip).toBe('127.0.0.1');
});

it('a SUCCEEDED sign-in is recorded, and its own tenant can read it', async () => {
  await app`select audit_sign_in('succeeded'::text, null::text, ${emailA}::text,
              ${tenantA}::uuid, ${actorA}::uuid, '127.0.0.1'::text, 'req-ok'::text)`;

  // Read as talon_app under its own tenant: no superuser anywhere in this path.
  const rows = await app.begin(async (tx) => {
    await tx`select set_config('app.tenant_id', ${tenantA}, true)`;
    return tx.unsafe<AuditRow[]>(
      `select ${AUDIT_COLUMNS} from audit_log where request_id = 'req-ok'`,
    );
  });
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({
    tenant_id: tenantA,
    actor_id: actorA,
    action: 'auth.sign_in.succeeded',
    entity_type: 'authentication',
  });
  expect(rows[0]?.after).toEqual({ outcome: 'succeeded', email: emailA });
});

it('the request-chain bootstrap resolves a users row', async () => {
  // auth_user_by_sub runs on every authenticated request, before app.tenant_id
  // exists, and reads a table with `force row level security`. Zero rows here is
  // not a degraded lookup: it is every token 401ing as an unknown subject.
  const rows = await app<{ id: string; tenant_id: string }[]>`
    select id, tenant_id from auth_user_by_sub(${actorA}::text)`;
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ id: actorA, tenant_id: tenantA });
});

it('a succeeded row whose actor does not belong to the named tenant is refused', async () => {
  // The caller picks tenant_id and actor_id on the success path. Nothing else
  // checks they belong together, and the function is `security definer`, so
  // without this `talon_app` could write a forged sign-in into any tenant's
  // trail (reviewer finding 4).
  await expect(
    app`select audit_sign_in('succeeded'::text, null::text, ${emailA}::text,
          ${tenantB}::uuid, ${actorA}::uuid, null::text, 'req-forged'::text)`,
  ).rejects.toThrow(/does not belong/i);

  const rows = await superuser.unsafe(
    `select 1 from audit_log where request_id = 'req-forged'`,
  );
  expect(rows).toHaveLength(0);
});

it('the exemption admits the function and nothing else — talon_app cannot forge', async () => {
  // The whole risk of an exception policy: if what admits the definer can be
  // reproduced by the caller, the policy is a hole rather than a door. Every
  // marker the function sets is settable by anyone (custom GUCs always are), so
  // the marker alone must not be sufficient.
  // One rejection per transaction: the first 42501 aborts it, and a second
  // statement on an aborted transaction fails for a reason that has nothing to
  // do with what is being asserted.
  await expect(
    app.begin(async (tx) => {
      await tx`select set_config('talon.audit_sign_in', 'on', true)`;
      await tx`insert into audit_log (tenant_id, action, entity_type)
               values (null, 'auth.sign_in.failed', 'authentication')`;
    }),
  ).rejects.toThrow(/row-level security|violates/i);

  await app.begin(async (tx) => {
    await tx`select set_config('talon.auth_bootstrap', 'on', true)`;
    // Reading users with no tenant set is the bootstrap's privilege, not the
    // caller's — through the function only, one row, by exact key.
    const rows = await tx`select id from users`;
    expect(rows).toHaveLength(0);
  });

  // And a row aimed at another tenant is still refused with the caller's own
  // tenant legitimately set, marker and all: the ordinary tenant policy is the
  // only one it can satisfy.
  await expect(
    app.begin(async (tx) => {
      await tx`select set_config('app.tenant_id', ${tenantA}, true)`;
      await tx`select set_config('talon.audit_sign_in', 'on', true)`;
      await tx`insert into audit_log (tenant_id, action, entity_type)
               values (${tenantB}::uuid, 'auth.sign_in.succeeded', 'authentication')`;
    }),
  ).rejects.toThrow(/row-level security|violates/i);
});
