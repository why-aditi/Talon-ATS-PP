// Migration 0010 (spec 008 §4, §6). Two tenant-scoped tables whose correctness lives
// entirely in their policies, grants and composite foreign keys.
//
// They are deliberately NOT in TENANT_TABLES: that sweep needs seeded rows to mean
// anything, and the seed writes no async jobs because nothing imports during seeding —
// an entry there would pass vacuously. This file inserts its own rows for both tenants
// instead, which is the same trade `outbox.test.ts` records and the same reason.
//
// The composite-FK assertions are the load-bearing ones. `jobs_async.params` holds a
// list of ids that a worker acts on LATER, on a different connection; if a row could
// name another tenant's user or reference another tenant's candidate, RLS would not be
// what stops it — FK validation bypasses RLS (non-negotiable #10).
import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { APP_URL, OWNER_URL } from './urls.js';

let sql: postgres.Sql;
let owner: postgres.Sql;
let talon: string;
let acme: string;
let talonUser: string;
let acmeUser: string;
let talonJob: string;
let acmeJob: string;

beforeAll(async () => {
  owner = postgres(OWNER_URL, { max: 1, onnotice: () => {} });
  const tenants = await owner`select id, slug from tenants order by slug`;
  talon = tenants.find((t) => t['slug'] === 'talon')?.['id'] as string;
  acme = tenants.find((t) => t['slug'] !== 'talon')?.['id'] as string;

  const [tu] = await owner`select id from users where tenant_id = ${talon} limit 1`;
  const [au] = await owner`select id from users where tenant_id = ${acme} limit 1`;
  talonUser = tu?.['id'] as string;
  acmeUser = au?.['id'] as string;

  talonJob = randomUUID();
  acmeJob = randomUUID();

  // Seeded as the owner so the app role's own visibility is what the tests measure.
  await owner`
    insert into jobs_async (id, tenant_id, kind, status, params, created_by)
    values (${talonJob}, ${talon}, 'import', 'pending', '{"file":"a.csv"}'::jsonb, ${talonUser}),
           (${acmeJob},  ${acme},  'import', 'pending', '{"file":"b.csv"}'::jsonb, ${acmeUser})`;

  await owner`
    insert into import_rows (tenant_id, job_id, row_index, row_hash, status)
    values (${talon}, ${talonJob}, 0, 'hash-talon', 'committed'),
           (${acme},  ${acmeJob},  0, 'hash-acme',  'committed')`;

  sql = postgres(APP_URL, { max: 1, onnotice: () => {} });
  await sql`select set_config('app.tenant_id', ${talon}, false)`;
});

afterAll(async () => {
  await owner`delete from import_rows`;
  await owner`delete from jobs_async`;
  await Promise.all([sql.end(), owner.end()]);
});

describe('tenant isolation', () => {
  it('shows only this tenant’s async jobs', async () => {
    const rows = await sql<{ tenant_id: string }[]>`select tenant_id from jobs_async`;
    expect(rows.length).toBeGreaterThan(0);
    expect([...new Set(rows.map((r) => r.tenant_id))]).toEqual([talon]);
  });

  it('shows only this tenant’s import rows', async () => {
    const rows = await sql<{ tenant_id: string }[]>`select tenant_id from import_rows`;
    expect(rows.length).toBeGreaterThan(0);
    expect([...new Set(rows.map((r) => r.tenant_id))]).toEqual([talon]);
  });

  it('fails closed with no tenant context — empty, not an error', async () => {
    const bare = postgres(APP_URL, { max: 1, onnotice: () => {} });
    try {
      expect(await bare`select 1 from jobs_async`).toHaveLength(0);
      expect(await bare`select 1 from import_rows`).toHaveLength(0);
    } finally {
      await bare.end();
    }
  });

  it('cannot write a row for another tenant even with the context set', async () => {
    // The `with check` half of the policy. Without it a caller could insert rows it
    // would then be unable to see — invisible cross-tenant writes.
    await expect(
      sql`insert into jobs_async (id, tenant_id, kind, status, params, created_by)
          values (${randomUUID()}, ${acme}, 'import', 'pending', '{}'::jsonb, ${acmeUser})`,
    ).rejects.toThrow(/row-level security/i);
  });
});

describe('composite foreign keys (non-negotiable #10)', () => {
  it('refuses an async job created_by another tenant’s user', async () => {
    // A plain `references users (id)` would ACCEPT this: FK validation bypasses RLS,
    // so the acme user row is perfectly visible to the constraint. Only the pair
    // (tenant_id, created_by) makes it impossible.
    await expect(
      owner`insert into jobs_async (id, tenant_id, kind, status, params, created_by)
            values (${randomUUID()}, ${talon}, 'import', 'pending', '{}'::jsonb, ${acmeUser})`,
    ).rejects.toThrow(/jobs_async_creator_fk/);
  });

  it('refuses an import row pointing at another tenant’s job', async () => {
    await expect(
      owner`insert into import_rows (tenant_id, job_id, row_index, row_hash, status)
            values (${talon}, ${acmeJob}, 99, 'x', 'committed')`,
    ).rejects.toThrow(/import_rows_job_fk/);
  });

  it('refuses an import row pointing at another tenant’s candidate', async () => {
    const [c] = await owner`select id from candidates where tenant_id = ${acme} limit 1`;
    await expect(
      owner`insert into import_rows (tenant_id, job_id, row_index, row_hash, status, candidate_id)
            values (${talon}, ${talonJob}, 98, 'y', 'committed', ${c?.['id'] as string})`,
    ).rejects.toThrow(/import_rows_candidate_fk/);
  });
});

describe('idempotency', () => {
  it('refuses a second row at the same index — the resume key', async () => {
    // This is what makes a crashed commit resumable rather than duplicating: the
    // committer inserts before it acts, and the second attempt collides here.
    await expect(
      owner`insert into import_rows (tenant_id, job_id, row_index, row_hash, status)
            values (${talon}, ${talonJob}, 0, 'different-hash', 'committed')`,
    ).rejects.toThrow(/import_rows_pkey/);
  });

  it('refuses the same natural key twice in one file', async () => {
    await expect(
      owner`insert into import_rows (tenant_id, job_id, row_index, row_hash, status)
            values (${talon}, ${talonJob}, 1, 'hash-talon', 'committed')`,
    ).rejects.toThrow(/import_rows_tenant_id_job_id_row_hash_key/);
  });
});

describe('append-only', () => {
  it('grants the app role no update or delete on import_rows', async () => {
    // A committed row states that work happened. A correction is a new import, not a
    // rewrite — the treatment stage_transitions and audit_log get, for the same reason.
    const grants = await owner<{ privilege_type: string }[]>`
      select privilege_type from information_schema.role_table_grants
      where table_name = 'import_rows' and grantee = 'talon_app'
      order by privilege_type`;
    expect(grants.map((g) => g.privilege_type)).toEqual(['INSERT', 'SELECT']);
  });
});
