// Acceptance 2 (spec 001 §5.4): as the app role with app.tenant_id = A, tenant B's
// rows are invisible on every tenant-scoped table; with app.tenant_id unset,
// queries return EMPTY (fail closed), never an error.
import postgres from 'postgres';
import { beforeAll, describe, expect, it } from 'vitest';
import { APP_URL, OWNER_URL, TENANT_TABLES } from './urls.js';

let talon: string;
let acme: string;
let acmeJobId: string;

beforeAll(async () => {
  const owner = postgres(OWNER_URL, { max: 1, onnotice: () => {} });
  const tenants = await owner`select id, slug from tenants`;
  talon = tenants.find((t) => t['slug'] === 'talon')?.['id'] as string;
  acme = tenants.find((t) => t['slug'] === 'acme')?.['id'] as string;
  const [job] = await owner`select id from jobs where tenant_id = ${acme}`;
  acmeJobId = job?.['id'] as string;
  // sanity: rows exist for BOTH tenants in every tenant-scoped table, so an
  // empty result below means "filtered", never "nothing was seeded"
  for (const table of TENANT_TABLES) {
    for (const tenant of [talon, acme]) {
      const [row] = await owner`select count(*)::int as n from ${owner(table)} where tenant_id = ${tenant}`;
      expect(row?.['n'], `${table} seeded for tenant`).toBeGreaterThan(0);
    }
  }
  await owner.end();
});

function appClient(tenantId?: string) {
  const sql = postgres(APP_URL, { max: 1, onnotice: () => {} });
  const ready = tenantId
    ? sql`select set_config('app.tenant_id', ${tenantId}, false)`
    : Promise.resolve();
  return { sql, ready };
}

describe('RLS tenant isolation (talon_app role)', () => {
  it('tenant A sees its own rows and zero of tenant B, on every tenant-scoped table', async () => {
    const { sql, ready } = appClient(talon);
    await ready;
    try {
      for (const table of TENANT_TABLES) {
        const [own] = await sql`select count(*)::int as n from ${sql(table)}`;
        const [other] = await sql`select count(*)::int as n from ${sql(table)} where tenant_id = ${acme}`;
        expect(own?.['n'], `${table}: own rows visible`).toBeGreaterThan(0);
        expect(other?.['n'], `${table}: tenant B invisible`).toBe(0);
      }
      // fetching tenant B's job by primary key returns nothing (the 404 backstop)
      expect(await sql`select id from jobs where id = ${acmeJobId}`).toHaveLength(0);
      // tenants table: only the tenant's own row
      const tenants = await sql`select id from tenants`;
      expect(tenants.map((t) => t['id'])).toEqual([talon]);
    } finally {
      await sql.end();
    }
  });

  it('tenant B sees only its own rows', async () => {
    const { sql, ready } = appClient(acme);
    await ready;
    try {
      const jobs = await sql`select req_code from jobs`;
      expect(jobs.map((j) => j['req_code'])).toEqual(['ACM-001']);
      const [talonRows] = await sql`select count(*)::int as n from applications where tenant_id = ${talon}`;
      expect(talonRows?.['n']).toBe(0);
    } finally {
      await sql.end();
    }
  });

  it('with app.tenant_id unset every table returns empty — fails closed, no error', async () => {
    const { sql } = appClient();
    try {
      for (const table of [...TENANT_TABLES, 'tenants']) {
        const rows = await sql`select * from ${sql(table)} limit 5`;
        expect(rows, `${table}: fails closed when unset`).toHaveLength(0);
      }
    } finally {
      await sql.end();
    }
  });

  it('with check blocks writing a row into another tenant', async () => {
    const { sql, ready } = appClient(talon);
    await ready;
    try {
      await expect(
        sql`insert into candidates (id, tenant_id, name)
            values (gen_random_uuid(), ${acme}, 'Sneaky Insert')`,
      ).rejects.toMatchObject({ code: '42501' }); // new row violates row-level security policy
    } finally {
      await sql.end();
    }
  });
});
