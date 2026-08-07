// Reviewer finding 7: composite foreign keys, so referential integrity cannot cross
// a tenant or a job.
//
// The reason this needs its own suite rather than leaning on rls.test.ts: FK
// validation runs as the table owner and BYPASSES row-level security. A plain
// `references job_stages (id)` is satisfied by ANY stage row in the table, including
// one belonging to a different job or a different tenant that the writer cannot even
// see. RLS is a read/write filter, not an integrity constraint. The composite FKs
// close that gap in the schema, and these tests are what prove it — each one fails
// with 23503 (foreign_key_violation) instead of quietly inserting a corrupt row.
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { APP_URL, OWNER_URL } from './urls.js';

let owner: postgres.Sql;
let app: postgres.Sql;

const ids = {
  talon: '',
  acme: '',
  eng204: '',
  eng209: '',
  acmeJob: '',
  eng204Applied: '',
  eng209Applied: '',
  acmeApplied: '',
  acmeCandidate: '',
  talonUser: '',
  acmeUser: '',
  talonTemplate: '',
  talonApplication: '',
  acmeApplication: '',
};

/** Sentinel that rolls a probe transaction back so the seeded fixture is never mutated. */
class Rollback extends Error {}

async function inRolledBackTx(
  sql: postgres.Sql,
  fn: (tx: postgres.TransactionSql) => Promise<unknown>,
): Promise<void> {
  try {
    await sql.begin(async (tx) => {
      await fn(tx);
      throw new Rollback();
    });
  } catch (err) {
    if (!(err instanceof Rollback)) throw err;
  }
}

const FK_VIOLATION = { code: '23503' };

beforeAll(async () => {
  owner = postgres(OWNER_URL, { max: 1, onnotice: () => {} });
  app = postgres(APP_URL, { max: 1, onnotice: () => {} });

  const tenants = await owner`select id, slug from tenants`;
  ids.talon = tenants.find((t) => t['slug'] === 'talon')?.['id'] as string;
  ids.acme = tenants.find((t) => t['slug'] === 'acme')?.['id'] as string;

  const jobs = await owner`select id, req_code, tenant_id from jobs`;
  ids.eng204 = jobs.find((j) => j['req_code'] === 'ENG-204')?.['id'] as string;
  ids.eng209 = jobs.find((j) => j['req_code'] === 'ENG-209')?.['id'] as string;
  ids.acmeJob = jobs.find((j) => j['req_code'] === 'ACM-001')?.['id'] as string;

  const stage = async (jobId: string) =>
    (await owner`select id from job_stages where job_id = ${jobId} and canonical = 'applied'`)[0]?.[
      'id'
    ] as string;
  ids.eng204Applied = await stage(ids.eng204);
  ids.eng209Applied = await stage(ids.eng209);
  ids.acmeApplied = await stage(ids.acmeJob);

  ids.acmeCandidate = (await owner`select id from candidates where tenant_id = ${ids.acme} limit 1`)[0]?.['id'] as string;
  ids.talonUser = (await owner`select id from users where tenant_id = ${ids.talon} limit 1`)[0]?.['id'] as string;
  ids.acmeUser = (await owner`select id from users where tenant_id = ${ids.acme} limit 1`)[0]?.['id'] as string;
  ids.talonTemplate = (await owner`select id from stage_templates where tenant_id = ${ids.talon} limit 1`)[0]?.['id'] as string;
  ids.talonApplication = (await owner`select id from applications where tenant_id = ${ids.talon} limit 1`)[0]?.['id'] as string;
  ids.acmeApplication = (await owner`select id from applications where tenant_id = ${ids.acme} limit 1`)[0]?.['id'] as string;

  for (const [key, value] of Object.entries(ids)) {
    expect(value, `fixture id ${key} resolved`).toBeTruthy();
  }
});

afterAll(async () => {
  await owner.end();
  await app.end();
});

/**
 * A brand-new candidate inside the probe transaction. Reusing a seeded candidate
 * would trip applications' unique (tenant_id, candidate_id, job_id) before the FK
 * triggers ever fire, and the test would pass for the wrong reason.
 */
async function freshCandidate(tx: postgres.TransactionSql, tenantId: string): Promise<string> {
  const [row] = await tx`
    insert into candidates (id, tenant_id, name, email)
    values (gen_random_uuid(), ${tenantId}, 'FK Probe', ${`fk.probe.${Math.random()}@example.com`})
    returning id`;
  return row?.['id'] as string;
}

/** Insert an application, overriding whichever column the test is probing. */
async function insertApplication(
  tx: postgres.TransactionSql,
  o: { tenantId: string; candidateId?: string; jobId: string; stageId: string; referredById?: string | null },
) {
  const candidateId = o.candidateId ?? (await freshCandidate(tx, o.tenantId));
  await tx`
    insert into applications
      (id, tenant_id, candidate_id, job_id, current_stage_id, stage_entered_at, board_rank,
       source, referred_by_id, status)
    values
      (gen_random_uuid(), ${o.tenantId}, ${candidateId}, ${o.jobId}, ${o.stageId}, now(), 'zzz',
       'test', ${o.referredById ?? null}, 'active')`;
}

describe('a job stage cannot come from a different job', () => {
  it("rejects an application on ENG-204 whose current_stage_id belongs to ENG-209", async () => {
    await expect(
      inRolledBackTx(owner, (tx) =>
        insertApplication(tx, {
          tenantId: ids.talon,
          jobId: ids.eng204,
          // Same tenant, real stage row, wrong job — the exact write a stage-move bug
          // makes. Without applications (job_id, current_stage_id) → job_stages
          // (job_id, id) this inserts happily and the card renders on the wrong board.
          stageId: ids.eng209Applied,
        }),
      ),
    ).rejects.toMatchObject(FK_VIOLATION);
  });

  it('accepts the same application when the stage belongs to the job (positive control)', async () => {
    // Proves the rejection above is the composite FK and not some unrelated
    // constraint on the row we are building.
    await expect(
      inRolledBackTx(owner, (tx) =>
        insertApplication(tx, {
          tenantId: ids.talon,
          jobId: ids.eng204,
          stageId: ids.eng204Applied,
        }),
      ),
    ).resolves.toBeUndefined();
  });
});

describe('a parent row cannot come from a different tenant', () => {
  it('rejects an application pointing at another tenant\'s job', async () => {
    await expect(
      inRolledBackTx(owner, (tx) =>
        insertApplication(tx, {
          tenantId: ids.talon,
          jobId: ids.acmeJob,
          stageId: ids.acmeApplied,
        }),
      ),
    ).rejects.toMatchObject(FK_VIOLATION);
  });

  it("rejects an application pointing at another tenant's candidate", async () => {
    await expect(
      inRolledBackTx(owner, (tx) =>
        insertApplication(tx, {
          tenantId: ids.talon,
          candidateId: ids.acmeCandidate,
          jobId: ids.eng204,
          stageId: ids.eng204Applied,
        }),
      ),
    ).rejects.toMatchObject(FK_VIOLATION);
  });

  it("rejects an application referred by another tenant's user", async () => {
    await expect(
      inRolledBackTx(owner, (tx) =>
        insertApplication(tx, {
          tenantId: ids.talon,
          jobId: ids.eng204,
          stageId: ids.eng204Applied,
          referredById: ids.acmeUser,
        }),
      ),
    ).rejects.toMatchObject(FK_VIOLATION);
  });

  it("rejects a job whose recruiter belongs to another tenant", async () => {
    await expect(
      inRolledBackTx(
        owner,
        (tx) => tx`
          insert into jobs (id, tenant_id, req_code, title, department, location, currency,
                            status, recruiter_id, stage_template_id)
          values (gen_random_uuid(), ${ids.talon}, 'XTN-001', 'Cross-tenant recruiter',
                  'Engineering', 'Remote', 'USD', 'active', ${ids.acmeUser}, ${ids.talonTemplate})`,
      ),
    ).rejects.toMatchObject(FK_VIOLATION);
  });

  it("rejects a job_stage attached to another tenant's job", async () => {
    await expect(
      inRolledBackTx(
        owner,
        (tx) => tx`
          insert into job_stages (id, tenant_id, job_id, name, position, canonical)
          values (gen_random_uuid(), ${ids.talon}, ${ids.acmeJob}, 'Smuggled', 99, 'screen')`,
      ),
    ).rejects.toMatchObject(FK_VIOLATION);
  });

  it("rejects a stage_transition against another tenant's application", async () => {
    await expect(
      inRolledBackTx(
        owner,
        (tx) => tx`
          insert into stage_transitions (tenant_id, application_id, to_stage_id, occurred_at)
          values (${ids.talon}, ${ids.acmeApplication}, ${ids.eng204Applied}, now())`,
      ),
    ).rejects.toMatchObject(FK_VIOLATION);
  });

  it("rejects a stage_transition whose to_stage_id is another tenant's stage", async () => {
    await expect(
      inRolledBackTx(
        owner,
        (tx) => tx`
          insert into stage_transitions (tenant_id, application_id, to_stage_id, occurred_at)
          values (${ids.talon}, ${ids.talonApplication}, ${ids.acmeApplied}, now())`,
      ),
    ).rejects.toMatchObject(FK_VIOLATION);
  });
});

describe('the app role gets the same guarantee, on rows RLS hides from it', () => {
  it('cannot attach its own application to a stage it cannot even see', async () => {
    // This is the case that motivates the whole finding. talon_app under
    // app.tenant_id = talon cannot SELECT acme's job_stages row — but FK validation
    // is not subject to RLS, so a single-column FK would have accepted this id and
    // written a cross-tenant pointer into a table the policy believes it protects.
    const hidden = await app.begin(async (tx) => {
      await tx`select set_config('app.tenant_id', ${ids.talon}, true)`;
      return tx`select id from job_stages where id = ${ids.acmeApplied}`;
    });
    expect(hidden, 'RLS hides the target row from the writer').toHaveLength(0);

    await expect(
      inRolledBackTx(app, async (tx) => {
        await tx`select set_config('app.tenant_id', ${ids.talon}, true)`;
        await insertApplication(tx, {
          tenantId: ids.talon,
          jobId: ids.eng204,
          stageId: ids.acmeApplied,
        });
      }),
    ).rejects.toMatchObject(FK_VIOLATION);
  });
});

// Reviewer finding 1: CLAUDE.md §4.9 — cents are meaningless without a currency,
// and "hide it in the UI" is not a constraint. ARCHITECTURE §5 omits this column.
describe('comp expectation cents cannot exist without a currency', () => {
  it('rejects comp_expectation_min_cents with a null currency', async () => {
    await expect(
      inRolledBackTx(owner, async (tx) => {
        const candidateId = await freshCandidate(tx, ids.talon);
        await tx`
          insert into applications
            (id, tenant_id, candidate_id, job_id, current_stage_id, stage_entered_at,
             board_rank, source, status, comp_expectation_min_cents)
          values (gen_random_uuid(), ${ids.talon}, ${candidateId}, ${ids.eng204},
                  ${ids.eng204Applied}, now(), 'zzz', 'test', 'active', 21000000)`;
      }),
    ).rejects.toMatchObject({ code: '23514' }); // check_violation
  });

  it('accepts comp expectation cents when the currency is stated', async () => {
    await expect(
      inRolledBackTx(owner, async (tx) => {
        const candidateId = await freshCandidate(tx, ids.talon);
        await tx`
          insert into applications
            (id, tenant_id, candidate_id, job_id, current_stage_id, stage_entered_at,
             board_rank, source, status, comp_expectation_min_cents,
             comp_expectation_max_cents, comp_expectation_currency)
          values (gen_random_uuid(), ${ids.talon}, ${candidateId}, ${ids.eng204},
                  ${ids.eng204Applied}, now(), 'zzz', 'test', 'active', 21000000, 23000000, 'EUR')`;
      }),
    ).resolves.toBeUndefined();
  });
});

// Reviewer finding 8: jobs.currency lost its `default 'USD'`, so a caller that forgets
// the currency fails loudly instead of silently inheriting dollars.
describe('jobs.currency has no default', () => {
  it('rejects a job inserted without a currency', async () => {
    await expect(
      inRolledBackTx(
        owner,
        (tx) => tx`
          insert into jobs (id, tenant_id, req_code, title, department, location,
                            status, recruiter_id, stage_template_id)
          values (gen_random_uuid(), ${ids.talon}, 'XTN-002', 'No currency stated',
                  'Engineering', 'Remote', 'active', ${ids.talonUser}, ${ids.talonTemplate})`,
      ),
    ).rejects.toMatchObject({ code: '23502' }); // not_null_violation
  });
});
