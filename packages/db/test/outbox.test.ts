// Migration 0005 (spec 004 §3). The outbox is the one table whose correctness is
// entirely in its grants and its policy: the app writes events and must never be able
// to unwrite one, and the relay's poll must not be able to see across tenants when it
// runs as the app role by configuration accident.
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { APP_URL, OWNER_URL } from './urls.js';

let sql: postgres.Sql;
let owner: postgres.Sql;
let talon: string;
let acme: string;

beforeAll(async () => {
  owner = postgres(OWNER_URL, { max: 1, onnotice: () => {} });
  const tenants = await owner`select id, slug from tenants order by slug`;
  talon = tenants.find((t) => t['slug'] === 'talon')?.['id'] as string;
  acme = tenants.find((t) => t['slug'] !== 'talon')?.['id'] as string;

  // Seeded as the owner so the app role's own visibility is what the tests measure.
  await owner`
    insert into outbox (tenant_id, aggregate, aggregate_id, event_type, payload)
    values (${talon}, 'application', gen_random_uuid(), 'ApplicationStageChanged', '{"v":1}'::jsonb),
           (${acme},  'application', gen_random_uuid(), 'ApplicationStageChanged', '{"v":1}'::jsonb)`;

  sql = postgres(APP_URL, { max: 1, onnotice: () => {} });
  await sql`select set_config('app.tenant_id', ${talon}, false)`;
});

afterAll(async () => {
  await owner`delete from outbox`;
  await Promise.all([sql.end(), owner.end()]);
});

describe('tenant isolation', () => {
  it('shows only this tenant’s events', async () => {
    const rows = await sql<{ tenant_id: string }[]>`select tenant_id from outbox`;
    expect(rows.length).toBeGreaterThan(0);
    expect([...new Set(rows.map((r) => r.tenant_id))]).toEqual([talon]);
  });

  it('fails closed with no tenant context — empty, not an error', async () => {
    const bare = postgres(APP_URL, { max: 1, onnotice: () => {} });
    try {
      expect(await bare`select 1 from outbox`).toHaveLength(0);
    } finally {
      await bare.end();
    }
  });

  it('refuses an insert stamped with another tenant', async () => {
    // `with check` on the policy, not merely `using`: a write is the direction that
    // matters here, and a row written under the wrong tenant would be published.
    await expect(
      sql`insert into outbox (tenant_id, aggregate, aggregate_id, event_type, payload)
          values (${acme}, 'application', gen_random_uuid(), 'X', '{}'::jsonb)`,
    ).rejects.toMatchObject({ code: '42501' });
  });
});

describe('append-only for the app role', () => {
  it('can insert', async () => {
    const rows = await sql`
      insert into outbox (tenant_id, aggregate, aggregate_id, event_type, payload)
      values (${talon}, 'application', gen_random_uuid(), 'ApplicationStageChanged', '{"v":2}'::jsonb)
      returning id`;
    expect(rows).toHaveLength(1);
  });

  it('cannot update — not even to claim a row as published', async () => {
    // The relay stamps published_at, and it connects as its own role. If the app could
    // do it, a bug could mark an event delivered that was never sent.
    await expect(sql`update outbox set published_at = now()`).rejects.toMatchObject({ code: '42501' });
  });

  it('cannot delete', async () => {
    await expect(sql`delete from outbox`).rejects.toMatchObject({ code: '42501' });
  });
});

describe('shape the relay depends on', () => {
  it('orders by a monotonic id, so consumers can dedupe on it', async () => {
    const [col] = await owner`
      select data_type, column_default from information_schema.columns
      where table_name = 'outbox' and column_name = 'id'`;
    expect(col?.['data_type']).toBe('bigint');
    expect(String(col?.['column_default'])).toContain('nextval');
  });

  it('indexes the unpublished set partially, not the whole table', async () => {
    const rows = await owner<{ indexdef: string }[]>`
      select indexdef from pg_indexes where tablename = 'outbox'`;
    const unpublished = rows.find((r) => r.indexdef.includes('outbox_unpublished_idx'));
    // Partial: this table is append-mostly and unbounded, so an index over every
    // published row would grow forever for a query that never reads them.
    expect(unpublished?.indexdef).toContain('published_at IS NULL');
  });

  it('has no unique on (aggregate_id, event_type)', async () => {
    // One application produces many ApplicationStageChanged events over its life.
    // Deduplication is the consumer's job, keyed on id — a unique here would reject
    // the second legitimate move.
    const rows = await owner<{ indexdef: string }[]>`
      select indexdef from pg_indexes where tablename = 'outbox'`;
    expect(rows.filter((r) => r.indexdef.includes('UNIQUE') && r.indexdef.includes('aggregate_id'))).toHaveLength(0);
  });
});
