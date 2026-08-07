// Acceptance 1 (spec 001 §5.4): the seed writes history whose DERIVED values match
// the reference screens. Runs as the owner — this checks arithmetic, not isolation.
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { OWNER_URL } from './urls.js';

let sql: postgres.Sql;
let eng204: string;

beforeAll(async () => {
  sql = postgres(OWNER_URL, { max: 1, onnotice: () => {} });
  const [job] = await sql`select id from jobs where req_code = 'ENG-204'`;
  eng204 = job?.['id'] as string;
  expect(eng204).toBeTruthy();
});

afterAll(async () => {
  await sql.end();
});

async function daysInStage(candidateName: string) {
  const [row] = await sql`
    select floor(extract(epoch from (now() - a.stage_entered_at)) / 86400)::int as days,
           js.canonical, js.sla_days
    from applications a
    join candidates c on c.id = a.candidate_id
    join job_stages js on js.id = a.current_stage_id
    where c.name = ${candidateName} and a.job_id = ${eng204}`;
  return row as { days: number; canonical: string; sla_days: number | null } | undefined;
}

describe('ENG-204 derived metrics match the reference kanban', () => {
  it('Ana Petrova reads "3d in Onsite"', async () => {
    const ana = await daysInStage('Ana Petrova');
    expect(ana).toMatchObject({ canonical: 'onsite', days: 3 });
  });

  it('Elena Ruiz reads "Stalled 8d in stage" (8d in Screen, over the 5d SLA)', async () => {
    const elena = await daysInStage('Elena Ruiz');
    expect(elena).toMatchObject({ canonical: 'screen', days: 8 });
    expect(elena!.sla_days).not.toBeNull();
    expect(elena!.days).toBeGreaterThan(elena!.sla_days!);
  });

  it('Screen column reads "42% pass" (16 of 38 applications ever reached Screen)', async () => {
    const [row] = await sql`
      with total as (select count(*)::int as n from applications where job_id = ${eng204}),
      reached as (
        select count(distinct st.application_id)::int as n
        from stage_transitions st
        join job_stages js on js.id = st.to_stage_id
        where js.job_id = ${eng204} and js.canonical = 'screen')
      select total.n as total, reached.n as reached,
             round(100.0 * reached.n / total.n)::int as pct
      from total, reached`;
    expect(row).toMatchObject({ total: 38, reached: 16, pct: 42 });
  });

  it('Screen column reads "median 4d" (median dwell over completed Screen exits)', async () => {
    const [row] = await sql`
      select percentile_cont(0.5) within group (
               order by extract(epoch from (nxt.occurred_at - ent.occurred_at))
             )::float8 as median_seconds
      from stage_transitions ent
      join job_stages js on js.id = ent.to_stage_id
        and js.canonical = 'screen' and js.job_id = ${eng204}
      join stage_transitions nxt on nxt.application_id = ent.application_id
        and nxt.from_stage_id = ent.to_stage_id`;
    expect(row?.['median_seconds']).toBe(4 * 86400);
  });

  it('board columns hold exactly the pictured cards: 4/2/1/1 + 1 hired', async () => {
    const rows = await sql`
      select js.canonical, count(*)::int as n
      from applications a
      join job_stages js on js.id = a.current_stage_id
      where a.job_id = ${eng204} and a.status in ('active', 'hired')
      group by js.canonical`;
    const counts = Object.fromEntries(rows.map((r) => [r['canonical'], r['n']]));
    expect(counts).toEqual({ applied: 4, screen: 2, onsite: 1, offer: 1, hired: 1 });
  });
});

describe('jobs list counts and history consistency', () => {
  it('per-job totals and in-process counts match the seed contract', async () => {
    const rows = await sql`
      select j.req_code,
             count(*) filter (where a.status = 'active')::int as in_process,
             count(a.id)::int as total
      from jobs j
      left join applications a on a.job_id = j.id
      group by j.req_code`;
    const byReq = Object.fromEntries(rows.map((r) => [r['req_code'], { inProcess: r['in_process'], total: r['total'] }]));
    expect(byReq).toEqual({
      // ENG-204 in-process is 8, matching the pictured kanban (the jobs-list "18 in
      // process" contradicts the board's own cards; deviation documented in the seed).
      'ENG-204': { inProcess: 8, total: 38 },
      'ENG-209': { inProcess: 8, total: 21 },
      'ENG-198': { inProcess: 3, total: 12 },
      'DES-114': { inProcess: 20, total: 54 },
      'PPL-031': { inProcess: 19, total: 67 },
      'SAL-076': { inProcess: 6, total: 9 },
      'ACM-001': { inProcess: 2, total: 3 },
    });
  });

  it('stage_entered_at and current_stage_id agree with the transition log for every application', async () => {
    const [row] = await sql`
      select count(*)::int as drift
      from applications a
      join lateral (
        select occurred_at, to_stage_id from stage_transitions st
        where st.application_id = a.id
        order by occurred_at desc limit 1
      ) last on true
      where a.stage_entered_at <> last.occurred_at or a.current_stage_id <> last.to_stage_id`;
    expect(row?.['drift']).toBe(0);
  });
});
