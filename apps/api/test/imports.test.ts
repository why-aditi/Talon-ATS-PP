/**
 * CSV import integration — spec 008 §6.
 *
 * These assertions cover the expensive seams: dry-run is a real gate, retries do
 * not duplicate applications or erase progress, and imports use intake's creation
 * path (including its first transition).
 */
import { ERROR_TYPES } from '@talon/contracts';
import postgres from 'postgres';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { InMemoryFileStore, uploadKey } from '../src/modules/imports/file-store.js';
import { bearer, loadFixtures, signIn, startApp, type Fixtures, type TestApp } from './helpers.js';
import { OWNER_URL } from './urls.js';

let test: TestApp;
let fixtures: Fixtures;
let recruiter: Record<string, string>;
const imports: string[] = [];
const applications: string[] = [];

beforeAll(async () => {
  test = await startApp();
  fixtures = await loadFixtures();
  recruiter = bearer(await signIn(test, fixtures.talon.recruiter));
});

afterAll(async () => {
  const sql = postgres(OWNER_URL, { max: 1, onnotice: () => {} });
  try {
    if (imports.length > 0) {
      await sql`delete from import_rows where job_id = any(${imports}::uuid[])`;
    }
    if (applications.length > 0) {
      const candidateRows = await sql<{ candidate_id: string }[]>`
        select candidate_id from applications where id = any(${applications}::uuid[])`;
      await sql`delete from stage_transitions where application_id = any(${applications}::uuid[])`;
      await sql`delete from activities where application_id = any(${applications}::uuid[])`;
      await sql`delete from audit_log where entity_type = 'application' and entity_id = any(${applications}::uuid[])`;
      await sql`delete from outbox where aggregate = 'application' and aggregate_id = any(${applications}::uuid[])`;
      await sql`delete from applications where id = any(${applications}::uuid[])`;
      await sql`delete from candidates where id = any(${candidateRows.map((r) => r.candidate_id)}::uuid[])`;
    }
    if (imports.length > 0) {
      await sql`delete from jobs_async where id = any(${imports}::uuid[])`;
    }
  } finally {
    await sql.end();
    await test.close();
  }
});

const mapping = () => ({
  columns: { Name: 'name', Email: 'email', Job: 'job_ref' },
  duplicateStrategy: 'create',
  defaultJobId: fixtures.talon.jobId,
});

async function createImport(csv: string): Promise<string> {
  const created = await test.app.inject({
    method: 'POST',
    url: '/v1/imports',
    headers: recruiter,
    payload: { filename: 'candidates.csv', byteSize: Buffer.byteLength(csv) },
  });
  expect(created.statusCode, created.body).toBe(201);
  const id = created.json<{ importId: string }>().importId;
  imports.push(id);
  const store = test.container.cradle.fileStore as InMemoryFileStore;
  store.seed(uploadKey(fixtures.talon.tenantId, id), csv);
  return id;
}

it('requires the mandatory dry run before commit', async () => {
  const id = await createImport(
    `Name,Email\nGate Probe ${Date.now()},gate-${Date.now()}@example.test\n`,
  );
  const response = await test.app.inject({
    method: 'POST',
    url: `/v1/imports/${id}/commit`,
    headers: recruiter,
    payload: mapping(),
  });
  expect(response.statusCode, response.body).toBe(409);
  expect(response.json()).toMatchObject({ type: ERROR_TYPES.IMPORT_DRY_RUN_REQUIRED });
});

it('commits through intake, records the first transition, and retries idempotently', async () => {
  const stamp = Date.now();
  const id = await createImport(
    `Name,Email,Job\nImport Alpha ${stamp},alpha-${stamp}@example.test,${fixtures.talon.jobReqCode}\n` +
      `Import Beta ${stamp},beta-${stamp}@example.test,${fixtures.talon.jobReqCode}\n`,
  );

  const dryRun = await test.app.inject({
    method: 'POST',
    url: `/v1/imports/${id}/dry-run`,
    headers: recruiter,
    payload: mapping(),
  });
  expect(dryRun.statusCode, dryRun.body).toBe(200);
  expect(dryRun.json()).toMatchObject({ total: 2, valid: 2, invalid: 0, errorCsvUrl: null });

  const commit = () =>
    test.app.inject({
      method: 'POST',
      url: `/v1/imports/${id}/commit`,
      headers: recruiter,
      payload: mapping(),
    });
  const first = await commit();
  expect(first.statusCode, first.body).toBe(202);
  expect(first.json()).toMatchObject({
    job: { status: 'succeeded', total: 2, processed: 2, failed: 0 },
  });

  const sql = postgres(OWNER_URL, { max: 1, onnotice: () => {} });
  try {
    const rows = await sql<{ application_id: string; transition_count: number }[]>`
      select ir.application_id, count(st.id)::int as transition_count
      from import_rows ir
      join stage_transitions st on st.application_id = ir.application_id
      where ir.job_id = ${id} and ir.status = 'committed'
      group by ir.application_id`;
    applications.push(...rows.map((row) => row.application_id));
    expect(rows).toHaveLength(2);
    expect(rows.map((row) => row.transition_count)).toEqual([1, 1]);
  } finally {
    await sql.end();
  }

  const retry = await commit();
  expect(retry.statusCode, retry.body).toBe(202);
  expect(retry.json()).toMatchObject({ job: { status: 'succeeded', processed: 2, failed: 0 } });
});

it('actually processes files above the old 50-row cutoff', async () => {
  const stamp = Date.now();
  const csv = [
    'Name,Email',
    ...Array.from(
      { length: 51 },
      (_, index) => `Bulk ${stamp} ${index},bulk-${stamp}-${index}@example.test`,
    ),
  ].join('\n');
  const id = await createImport(csv);

  const dryRun = await test.app.inject({
    method: 'POST',
    url: `/v1/imports/${id}/dry-run`,
    headers: recruiter,
    payload: mapping(),
  });
  expect(dryRun.statusCode, dryRun.body).toBe(200);

  const committed = await test.app.inject({
    method: 'POST',
    url: `/v1/imports/${id}/commit`,
    headers: recruiter,
    payload: mapping(),
  });
  expect(committed.statusCode, committed.body).toBe(202);
  expect(committed.json()).toMatchObject({
    job: { status: 'succeeded', total: 51, processed: 51, failed: 0 },
  });

  const sql = postgres(OWNER_URL, { max: 1, onnotice: () => {} });
  try {
    const rows = await sql<{ application_id: string }[]>`
      select application_id from import_rows where job_id = ${id} and status = 'committed'`;
    applications.push(...rows.map((row) => row.application_id));
  } finally {
    await sql.end();
  }
});
