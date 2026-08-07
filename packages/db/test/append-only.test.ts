// Acceptance 5: stage_transitions (and audit_log) are append-only for the app
// role — UPDATE and DELETE are not granted, so they fail with 42501 even with a
// valid tenant context. A correction is a new row (CLAUDE.md §4.4).
import postgres from 'postgres';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { APP_URL, OWNER_URL } from './urls.js';

let sql: postgres.Sql;

beforeAll(async () => {
  const owner = postgres(OWNER_URL, { max: 1, onnotice: () => {} });
  const [tenant] = await owner`select id from tenants where slug = 'talon'`;
  await owner.end();
  sql = postgres(APP_URL, { max: 1, onnotice: () => {} });
  await sql`select set_config('app.tenant_id', ${tenant?.['id'] as string}, false)`;
});

afterAll(async () => {
  await sql.end();
});

it('UPDATE on stage_transitions is denied for the app role', async () => {
  await expect(sql`update stage_transitions set reason = 'rewritten history'`).rejects.toMatchObject({
    code: '42501',
  });
});

it('DELETE on stage_transitions is denied for the app role', async () => {
  await expect(sql`delete from stage_transitions`).rejects.toMatchObject({ code: '42501' });
});

it('UPDATE and DELETE on audit_log are denied for the app role', async () => {
  await expect(sql`update audit_log set action = 'nothing happened'`).rejects.toMatchObject({ code: '42501' });
  await expect(sql`delete from audit_log`).rejects.toMatchObject({ code: '42501' });
});

it('contrast: the app role CAN update a mutable table (grants, not a broken role)', async () => {
  // touches no rows; proves the failure above is the revoked grant, not a dead role
  await expect(sql`update applications set version = version where false`).resolves.toBeDefined();
});
