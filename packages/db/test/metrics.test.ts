// Acceptance 1 (spec 001 §5.4): the seed writes history whose DERIVED values match
// the reference screens. Runs as the owner — this checks arithmetic, not isolation.
//
// ENG-204 holds exactly the nine pictured candidates (open question 5, answered
// 2026-08-07: the board is the truth). Every assertion below is computed from
// stage_transitions rows, not from a denormalized column, so a seed that set only
// the current stage would fail here rather than in a screenshot diff three specs later.
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

describe('ENG-204 cards match 03-pipeline-kanban', () => {
  // Every "Nd in stage" string on the reference board, derived from stage_entered_at.
  const cards: [name: string, canonical: string, days: number][] = [
    ['Tess Bianchi', 'applied', 4],
    ['Omar Haddad', 'applied', 3],
    ['Jordan Cole', 'applied', 2],
    ['Priya Nair', 'applied', 1],
    ['Elena Ruiz', 'screen', 8],
    ['Marcus Webb', 'screen', 5],
    ['Ana Petrova', 'onsite', 3],
    ['Sofia Lindqvist', 'offer', 1],
    ['David Kim', 'hired', 0],
  ];

  it.each(cards)('%s reads "%sd in stage" in %s', async (name, canonical, days) => {
    expect(await daysInStage(name)).toMatchObject({ canonical, days });
  });

  it('Elena Ruiz is stalled — 8d in Screen against a 5d SLA', async () => {
    const elena = await daysInStage('Elena Ruiz');
    expect(elena!.sla_days).not.toBeNull();
    expect(elena!.days).toBeGreaterThan(elena!.sla_days!);
  });

  it('the board holds exactly the nine pictured candidates and no filler', async () => {
    const [row] = await sql`select count(*)::int as n from applications where job_id = ${eng204}`;
    expect(row?.['n']).toBe(9);
  });

  it('columns hold exactly the pictured cards: 4/2/1/1 + 1 hired', async () => {
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

describe('ENG-204 column medians match 03-pipeline-kanban exactly', () => {
  /** Median dwell in a stage, over applications that have LEFT it. */
  async function medianDwellDays(canonical: string) {
    const [row] = await sql`
      select percentile_cont(0.5) within group (
               order by extract(epoch from (nxt.occurred_at - ent.occurred_at))
             )::float8 as median_seconds
      from stage_transitions ent
      join job_stages js on js.id = ent.to_stage_id
        and js.canonical = ${canonical} and js.job_id = ${eng204}
      join stage_transitions nxt on nxt.application_id = ent.application_id
        and nxt.from_stage_id = ent.to_stage_id`;
    const seconds = row?.['median_seconds'] as number | null;
    return seconds === null ? null : seconds / 86400;
  }

  // "median 2d" / "median 4d" / "median 6d" / "median 3d" on the reference board.
  it.each([
    ['applied', 2],
    ['screen', 4],
    ['onsite', 6],
    ['offer', 3],
  ])('%s column reads "median %sd"', async (canonical, days) => {
    expect(await medianDwellDays(canonical as string)).toBe(days);
  });
});

describe('ENG-204 funnel — the pictured population, not the pictured percentages', () => {
  /**
   * SCREEN-VS-SCREEN CONTRADICTION, recorded rather than papered over.
   *
   * 03-pipeline-kanban shows 100% / 42% / 21% / 8% pass. Those are exactly the ratios
   * of a 38-application population: 16/38 = 42%, 8/38 = 21%, 3/38 = 8%. 38 is also the
   * "38 active" cell for ENG-204 on 02-jobs-list. So the funnel bar agrees with the
   * jobs list and disagrees with the nine cards drawn beside it on its own screen —
   * two internally consistent readings of the same job.
   *
   * Spec 001 open question 5 resolved this toward the board: nine candidates, no
   * filler. The percentages that population actually produces are asserted below.
   * The previous seed manufactured 29 invisible applications to make 42/21/8 come
   * out; those rows appeared on no screen and would have surfaced in every later
   * candidate list, count and export.
   */
  it('pass rates are 100/56/33/22 over the nine seeded applications', async () => {
    const rows = await sql`
      with total as (select count(*)::int as n from applications where job_id = ${eng204})
      select js.canonical,
             count(distinct st.application_id)::int as reached,
             round(100.0 * count(distinct st.application_id) / total.n)::int as pct
      from stage_transitions st
      join job_stages js on js.id = st.to_stage_id
      cross join total
      where js.job_id = ${eng204}
      group by js.canonical, total.n`;
    const pct = Object.fromEntries(rows.map((r) => [r['canonical'], r['pct']]));
    const reached = Object.fromEntries(rows.map((r) => [r['canonical'], r['reached']]));

    expect(reached).toEqual({ applied: 9, screen: 5, onsite: 3, offer: 2, hired: 1 });
    expect(pct).toEqual({ applied: 100, screen: 56, onsite: 33, offer: 22, hired: 11 });
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
      // ENG-204 reads from the board, not from 02-jobs-list's "18 in process / 38
      // active" — see the funnel contradiction above.
      'ENG-204': { inProcess: 8, total: 9 },
      // The other five are exactly the 02-jobs-list numbers.
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

  it('every seeded candidate has a distinct email — the slug used to collapse them', async () => {
    const [row] = await sql`
      select count(*)::int as total,
             count(distinct email)::int as distinct_emails,
             count(*) filter (where email is null)::int as missing
      from candidates`;
    expect(row?.['missing']).toBe(0);
    expect(row?.['distinct_emails']).toBe(row?.['total']);
  });

  it('no candidate is named like generated filler', async () => {
    // "DES-114 Candidate 7" and "Alex Morgan 12" leak into every later list and export.
    const rows = await sql`
      select name from candidates
      where name ~ '[0-9]' or name ~* '(candidate|filler|test)'`;
    expect(rows.map((r) => r['name'])).toEqual([]);
  });
});
