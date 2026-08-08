// Spec 002 / migration 0004: users.external_id and the retyped auth_user_by_sub.
//
// This is the lookup the whole request chain hangs off (spec 001 §6.3) and it runs
// on attacker-controlled input before any tenant context exists, so the assertions
// here are about two things: that an external subject and a local subject resolve
// to the right row and only the right row, and that nothing a hostile token can
// carry makes it raise.
//
// Runs against the dedicated test database (test/urls.ts), never the dev one.
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migrate } from '../src/migrate.js';
import { APP_URL, OWNER_URL } from './urls.js';

const EXTERNAL_SUB = '9f1c2b7e-3d4a-4c55-8e21-0a7b6d5c4e3f'; // a Cognito-shaped sub
const owner = postgres(OWNER_URL, { max: 1, onnotice: () => {} });

/** A seeded Talon user, given an external identity for the duration of this file. */
let cognitoUser: { id: string; email: string };
/** A seeded user left as a local-provider user (external_id null). */
let localUser: { id: string; email: string };

beforeAll(async () => {
  const [maya] = await owner<{ id: string; email: string }[]>`
    select id, email from users where email = 'maya@taloninc.com'`;
  const [sam] = await owner<{ id: string; email: string }[]>`
    select id, email from users where email = 'sam@taloninc.com'`;
  cognitoUser = maya as { id: string; email: string };
  localUser = sam as { id: string; email: string };
  await owner`update users set external_id = ${EXTERNAL_SUB} where id = ${cognitoUser.id}`;
});

afterAll(async () => {
  // Leave the seed as the seed found it: every seeded user is a local-provider
  // user, and the migration round-trip below drops the column out from under it.
  await owner`update users set external_id = null where id = ${cognitoUser.id}`;
  await owner.end();
});

describe('auth_user_by_sub — subject resolution', () => {
  it('resolves a user by its external_id', async () => {
    const rows = await owner`select * from auth_user_by_sub(${EXTERNAL_SUB})`;
    expect(rows).toHaveLength(1);
    expect(rows[0]?.['id']).toBe(cognitoUser.id);
    expect(rows[0]?.['email']).toBe(cognitoUser.email);
    // The bootstrap contract: tenant and role come back so the chain can set
    // app.tenant_id, and no password material does.
    expect(rows[0]?.['tenant_id']).toBeTruthy();
    expect(rows[0]).not.toHaveProperty('password_hash');
  });

  it('does NOT resolve that user by its raw users.id', async () => {
    // The load-bearing assertion of this migration. If users.id still resolved a
    // user who has an external identity, that user would have two valid token
    // subjects and revoking the identity at the IdP would change nothing.
    expect(await owner`select * from auth_user_by_sub(${cognitoUser.id})`).toHaveLength(0);
  });

  it('still resolves a local-provider user (external_id null) by its users.id', async () => {
    const rows = await owner`select * from auth_user_by_sub(${localUser.id})`;
    expect(rows).toHaveLength(1);
    expect(rows[0]?.['email']).toBe(localUser.email);
  });

  it('matches external_id case-sensitively (text, not citext)', async () => {
    expect(await owner`select * from auth_user_by_sub(${EXTERNAL_SUB.toUpperCase()})`).toHaveLength(
      0,
    );
  });

  it('returns zero rows for an unknown but well-formed subject', async () => {
    expect(
      await owner`select * from auth_user_by_sub(${'00000000-0000-4000-8000-000000000000'})`,
    ).toHaveLength(0);
  });

  it('is callable by talon_app with no app.tenant_id set, and reads past RLS', async () => {
    // Two properties at once: the grant reaches the app role, and the function is
    // security definer so it sees a users row the app role's own policy hides.
    const app = postgres(APP_URL, { max: 1, onnotice: () => {} });
    try {
      const direct = await app`select id from users where id = ${cognitoUser.id}`;
      expect(direct, 'RLS hides users with no tenant context').toHaveLength(0);
      const viaFn = await app`select id from auth_user_by_sub(${EXTERNAL_SUB})`;
      expect(viaFn).toHaveLength(1);
    } finally {
      await app.end();
    }
  });

  it('grants execute to talon_app only — not to public', async () => {
    const [row] = await owner`
      select has_function_privilege('talon_app', 'public.auth_user_by_sub(text)', 'execute') as app,
             has_function_privilege('public', 'public.auth_user_by_sub(text)', 'execute') as pub`;
    expect(row?.['app']).toBe(true);
    expect(row?.['pub']).toBe(false);
  });
});

describe('auth_user_by_sub — hostile input returns nothing and never raises', () => {
  const HOSTILE: [name: string, value: string][] = [
    ['sql injection', "'; drop table users; --"],
    ['empty string', ''],
    ['whitespace', '   '],
    ['10KB of noise', 'a'.repeat(10_240)],
    ['10KB of hyphens and hex', '0123456789abcdef-'.repeat(700)],
    ['uuid-shaped but not hex', 'zzzzzzzz-zzzz-zzzz-zzzz-zzzzzzzzzzzz'],
    ['braced uuid (Postgres accepts, we do not)', '{9f1c2b7e-3d4a-4c55-8e21-0a7b6d5c4e3f}'],
    ['unhyphenated uuid', '9f1c2b7e3d4a4c558e210a7b6d5c4e3f'],
    ['uuid with trailing junk', '9f1c2b7e-3d4a-4c55-8e21-0a7b6d5c4e3f; select 1'],
    ['free text', 'not a uuid at all'],
  ];

  for (const [name, value] of HOSTILE) {
    it(`returns zero rows for ${name}`, async () => {
      // Zero rows, not a thrown 22P02 — under the old uuid signature most of these
      // raised on the cast, which the API surfaces as a 500 on a hostile token.
      await expect(owner`select * from auth_user_by_sub(${value})`).resolves.toHaveLength(0);
    });
  }

  it('a null subject returns zero rows', async () => {
    await expect(owner`select * from auth_user_by_sub(${null})`).resolves.toHaveLength(0);
  });

  it('the injection attempt did not execute — users is still there', async () => {
    const [row] = await owner`select count(*)::int as n from users`;
    expect(row?.['n']).toBeGreaterThan(0);
  });
});

describe('users.external_id constraints', () => {
  it('rejects a duplicate external_id', async () => {
    await expect(
      owner`update users set external_id = ${EXTERNAL_SUB} where id = ${localUser.id}`,
    ).rejects.toThrow(/users_external_id_key/);
  });

  it('rejects an empty or whitespace-only external_id', async () => {
    for (const bad of ['', '   ']) {
      await expect(
        owner`update users set external_id = ${bad} where id = ${localUser.id}`,
      ).rejects.toThrow(/users_external_id_ck/);
    }
  });

  it('rejects an oversized external_id on the named check, not on the index', async () => {
    await expect(
      owner`update users set external_id = ${'a'.repeat(1025)} where id = ${localUser.id}`,
    ).rejects.toThrow(/users_external_id_ck/);
  });

  it('allows many nulls — every local-provider user has one', async () => {
    const [row] = await owner`select count(*)::int as n from users where external_id is null`;
    expect(row?.['n']).toBeGreaterThan(1);
  });
});

// Declared last on purpose: it takes the schema down to 0003 and back, so it must
// not run between the assertions above.
describe('0004 down → up', () => {
  async function subFn() {
    const rows = await owner<{ args: string; secdef: boolean; lang: string; cfg: string[] }[]>`
      select pg_get_function_arguments(p.oid) as args,
             p.prosecdef as secdef,
             l.lanname as lang,
             p.proconfig as cfg
      from pg_proc p
        join pg_namespace n on n.oid = p.pronamespace
        join pg_language l on l.oid = p.prolang
      where n.nspname = 'public' and p.proname = 'auth_user_by_sub'`;
    return rows;
  }

  async function externalIdColumn() {
    return owner`
      select 1 from information_schema.columns
      where table_name = 'users' and column_name = 'external_id'`;
  }

  it('down restores 0003’s uuid-typed function exactly, then up restores the text one', async () => {
    // `down` steps back exactly one migration, so everything stacked above 0004 has
    // to come off first. Asserted rather than looped: a down that quietly took two
    // would be worth knowing about here, in the file that tests reversibility.
    expect(await migrate('down', OWNER_URL)).toEqual(['0008_jobs_version']);
    expect(await migrate('down', OWNER_URL)).toEqual(['0007_definer_rls_exemption']);
    expect(await migrate('down', OWNER_URL)).toEqual(['0006_outbox']);
    expect(await migrate('down', OWNER_URL)).toEqual(['0005_audit_authentication']);
    expect(await migrate('down', OWNER_URL)).toEqual(['0004_users_external_id']);

    const [reverted] = await subFn();
    // Not merely "the down did not error": the exact previous signature is back,
    // still security definer, still sql, still search_path-pinned, still granted.
    expect(reverted?.['args']).toBe('p_sub uuid');
    expect(reverted?.['lang']).toBe('sql');
    expect(reverted?.['secdef']).toBe(true);
    expect(reverted?.['cfg']).toEqual(['search_path=pg_catalog, public']);
    const [privs] = await owner`
      select has_function_privilege('talon_app', 'public.auth_user_by_sub(uuid)', 'execute') as app,
             has_function_privilege('public', 'public.auth_user_by_sub(uuid)', 'execute') as pub`;
    expect(privs?.['app']).toBe(true);
    expect(privs?.['pub']).toBe(false);
    // And the uuid version works — a rollback must leave sign-in functional.
    expect(await owner`select * from auth_user_by_sub(${localUser.id}::uuid)`).toHaveLength(1);
    expect(await externalIdColumn()).toHaveLength(0);

    expect(await migrate('up', OWNER_URL)).toEqual([
      '0004_users_external_id',
      '0005_audit_authentication',
      '0006_outbox',
      '0007_definer_rls_exemption',
      '0008_jobs_version',
    ]);

    const [reapplied] = await subFn();
    expect(reapplied?.['args']).toBe('p_sub text');
    expect(reapplied?.['lang']).toBe('plpgsql');
    expect(reapplied?.['secdef']).toBe(true);
    expect(reapplied?.['cfg']).toEqual(['search_path=pg_catalog, public']);
    expect(await externalIdColumn()).toHaveLength(1);
    // external_id came back empty — the down migration's documented data loss.
    const [remaining] = await owner`select count(*)::int as n from users where external_id is not null`;
    expect(remaining?.['n']).toBe(0);
    expect(await owner`select * from auth_user_by_sub(${localUser.id})`).toHaveLength(1);
  });
});
