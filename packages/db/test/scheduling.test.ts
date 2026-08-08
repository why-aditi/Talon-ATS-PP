// Migration 0009 (spec 004 §5). What this suite is for: every guarantee the scheduling
// tables claim in their DDL is claimed in SQL, so it survives an application bug rather
// than depending on one not happening.
//
// These run as the OWNER, which bypasses RLS on purpose — a constraint that only holds
// for the app role is not a constraint, it is a filter. RLS itself is swept by
// rls.test.ts, which now covers all five tables (test/urls.ts).
import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { OWNER_URL } from './urls.js';

let owner: postgres.Sql;

const ids = {
  talon: '',
  acme: '',
  anaApplication: '',
  anaLoop: '',
  anaFirstRound: '',
  anaUnscheduledRound: '',
  petraApplication: '',
  petraLoop: '',
  petraRound: '',
  maya: '',
  beth: '',
};

/** Rolls a probe transaction back so the seeded fixture is never mutated. */
class Rollback extends Error {}

async function inRolledBackTx(fn: (tx: postgres.TransactionSql) => Promise<unknown>): Promise<void> {
  try {
    await owner.begin(async (tx) => {
      await fn(tx);
      throw new Rollback();
    });
  } catch (err) {
    if (!(err instanceof Rollback)) throw err;
  }
}

/** Asserts the write fails with a specific SQLSTATE, not merely "fails". */
async function rejectsWith(
  code: string,
  fn: (tx: postgres.TransactionSql) => Promise<unknown>,
): Promise<void> {
  let caught: unknown;
  try {
    await inRolledBackTx(fn);
  } catch (err) {
    caught = err;
  }
  expect((caught as { code?: string })?.code, `expected SQLSTATE ${code}`).toBe(code);
}

beforeAll(async () => {
  owner = postgres(OWNER_URL, { max: 1, onnotice: () => {} });
  const tenants = await owner<{ id: string; slug: string }[]>`select id, slug from tenants`;
  ids.talon = tenants.find((t) => t.slug === 'talon')?.id ?? '';
  ids.acme = tenants.find((t) => t.slug === 'acme')?.id ?? '';

  const [ana] = await owner<{ id: string; application_id: string }[]>`
    select id, application_id from interview_loops where tenant_id = ${ids.talon}`;
  ids.anaLoop = ana?.id ?? '';
  ids.anaApplication = ana?.application_id ?? '';
  const [firstRound] = await owner<{ id: string }[]>`
    select id from interview_rounds where loop_id = ${ids.anaLoop} order by position`;
  ids.anaFirstRound = firstRound?.id ?? '';
  // A round the seed left unplaced, so an insert against it is not shadowed by the
  // unique(round_id) that catches double-scheduling.
  const [unscheduled] = await owner<{ id: string }[]>`
    select r.id from interview_rounds r left join interviews i on i.round_id = r.id
    where r.loop_id = ${ids.anaLoop} and i.id is null order by r.position`;
  ids.anaUnscheduledRound = unscheduled?.id ?? '';

  const [petra] = await owner<{ id: string; application_id: string }[]>`
    select id, application_id from interview_loops where tenant_id = ${ids.acme}`;
  ids.petraLoop = petra?.id ?? '';
  ids.petraApplication = petra?.application_id ?? '';
  const [petraRound] = await owner<{ id: string }[]>`
    select id from interview_rounds where loop_id = ${ids.petraLoop}`;
  ids.petraRound = petraRound?.id ?? '';

  const [maya] = await owner<{ id: string }[]>`
    select id from users where tenant_id = ${ids.talon} and name = 'Maya Reyes'`;
  ids.maya = maya?.id ?? '';
  const [beth] = await owner<{ id: string }[]>`
    select id from users where tenant_id = ${ids.acme}`;
  ids.beth = beth?.id ?? '';

  for (const [key, value] of Object.entries(ids)) {
    expect(value, `fixture ${key}`).not.toBe('');
  }
});

afterAll(async () => {
  await owner?.end();
});

describe('the round template vs the scheduled instance', () => {
  it('a round with no interviews row is what "unscheduled" means', async () => {
    // The seed places two of Ana's four rounds. The other two must have no row at all —
    // not a row with a null start, which would make "unscheduled" two states.
    const rows = await owner<{ position: number; interview_id: string | null }[]>`
      select r.position, i.id as interview_id
      from interview_rounds r
      left join interviews i on i.round_id = r.id
      where r.loop_id = ${ids.anaLoop}
      order by r.position`;
    expect(rows.map((r) => r.interview_id !== null)).toEqual([true, true, false, false]);
  });

  it('a round cannot be scheduled twice — a re-solve must update in place', async () => {
    await rejectsWith('23505', (tx) => tx`
      insert into interviews (id, tenant_id, application_id, loop_id, round_id, kind,
                              duration_min, scheduled_start, scheduled_end, status)
      values (${randomUUID()}, ${ids.talon}, ${ids.anaApplication}, ${ids.anaLoop},
              ${ids.anaFirstRound}, 'coding', 60, now(), now() + interval '1 hour', 'confirmed')`);
  });
});

describe('composite foreign keys (non-negotiable #10)', () => {
  it('an interview cannot instantiate a round from a different loop', async () => {
    // The pin that matters: (loop_id, round_id) -> interview_rounds (loop_id, id).
    // Without it, Acme's round could be scheduled inside Talon's loop and every FK
    // would be satisfied, because FK validation bypasses RLS.
    const borrowed = randomUUID();
    await rejectsWith('23503', async (tx) => {
      await tx`
        insert into interview_rounds (id, tenant_id, loop_id, kind, duration_min, position)
        values (${borrowed}, ${ids.acme}, ${ids.petraLoop}, 'coding', 60, 9)`;
      await tx`
        insert into interviews (id, tenant_id, application_id, loop_id, round_id, kind,
                                duration_min, scheduled_start, scheduled_end, status)
        values (${randomUUID()}, ${ids.talon}, ${ids.anaApplication}, ${ids.anaLoop},
                ${borrowed}, 'coding', 60, now(), now() + interval '1 hour', 'confirmed')`;
    });
  });

  it('an interview cannot belong to a different application than its loop', async () => {
    await rejectsWith('23503', (tx) => tx`
      insert into interviews (id, tenant_id, application_id, loop_id, round_id, kind,
                              duration_min, scheduled_start, scheduled_end, status)
      values (${randomUUID()}, ${ids.talon}, ${ids.petraApplication}, ${ids.anaLoop},
              ${ids.anaUnscheduledRound}, 'coding', 60, now(), now() + interval '1 hour', 'confirmed')`);
  });

  it('a panelist on a round cannot be another tenant\'s user', async () => {
    // Ana's loop, staffed by Acme's admin. The interesting failure: without the
    // composite FK this inserts cleanly and then leaks a name into Talon's grid.
    await rejectsWith('23503', (tx) => tx`
      insert into interview_round_panelists (tenant_id, round_id, user_id)
      values (${ids.talon}, ${ids.anaFirstRound}, ${ids.beth})`);
  });

  it('a loop cannot be held by another tenant\'s user', async () => {
    await rejectsWith('23503', (tx) => tx`
      update interview_loops set status = 'held', held_by = ${ids.beth},
        hold_expires_at = now() + interval '24 hours'
      where id = ${ids.anaLoop}`);
  });
});

describe('hold state cannot be half-written (spec 004 §9)', () => {
  it('a holder without an expiry is rejected', async () => {
    await rejectsWith('23514', (tx) => tx`
      update interview_loops set held_by = ${ids.maya} where id = ${ids.anaLoop}`);
  });

  it('an expiry without a holder is rejected', async () => {
    await rejectsWith('23514', (tx) => tx`
      update interview_loops set hold_expires_at = now() + interval '24 hours'
      where id = ${ids.anaLoop}`);
  });

  it('status held with nobody holding it is rejected — edge case 4 needs a name', async () => {
    await rejectsWith('23514', (tx) => tx`
      update interview_loops set status = 'held' where id = ${ids.anaLoop}`);
  });

  it('a well-formed hold is accepted', async () => {
    await inRolledBackTx(async (tx) => {
      const rows = await tx`
        update interview_loops set status = 'held', held_by = ${ids.maya},
          hold_expires_at = now() + interval '24 hours'
        where id = ${ids.anaLoop} returning id`;
      expect(rows).toHaveLength(1);
    });
  });
});

describe('the solver grid is a schema constraint, not a convention', () => {
  it('a duration off the 15-minute grid is rejected', async () => {
    // A 50-minute round cannot be placed exactly on the bitmap the solver builds
    // (spec 004 §7), so it would silently round. Refused at the column instead.
    await rejectsWith('23514', (tx) => tx`
      insert into interview_rounds (id, tenant_id, loop_id, kind, duration_min, position)
      values (${randomUUID()}, ${ids.talon}, ${ids.anaLoop}, 'values', 50, 9)`);
  });

  it('an off-grid duration is rejected on the INSTANCE too, not just the template', async () => {
    // The instance is the row a placement writes (§7a), so it is the one that can carry a
    // duration nothing checked. 50 minutes has no exact position on the 15-minute bitmap:
    // without this it inserts cleanly and misplaces a slot somewhere far from here.
    const insert = (tx: postgres.TransactionSql, durationMin: number) => tx`
      insert into interviews (id, tenant_id, application_id, loop_id, round_id, kind,
                              duration_min, scheduled_start, scheduled_end, status)
      values (${randomUUID()}, ${ids.talon}, ${ids.anaApplication}, ${ids.anaLoop},
              ${ids.anaUnscheduledRound}, 'values', ${durationMin}, now(),
              now() + make_interval(mins => ${durationMin}), 'confirmed')
      returning id`;

    await rejectsWith('23514', (tx) => insert(tx, 50));

    // The positive control. `rejectsWith` only pins the SQLSTATE, and every check on this
    // table shares 23514 — without this, the test above would still pass if the row were
    // being refused for some unrelated reason and the grid check had never been added.
    await inRolledBackTx(async (tx) => {
      expect(await insert(tx, 45)).toHaveLength(1);
    });
  });

  it('two rounds cannot occupy the same position in a loop', async () => {
    await rejectsWith('23505', (tx) => tx`
      insert into interview_rounds (id, tenant_id, loop_id, kind, duration_min, position)
      values (${randomUUID()}, ${ids.talon}, ${ids.anaLoop}, 'values', 45, 0)`);
  });
});

describe('a committed interview always has a time', () => {
  it('confirmed with no scheduled_start is rejected', async () => {
    // The state that lets a candidate be told to show up at nothing.
    await rejectsWith('23514', (tx) => tx`
      update interviews set status = 'confirmed', scheduled_start = null, scheduled_end = null
      where loop_id = ${ids.anaLoop}`);
  });

  it('an end before its start is rejected', async () => {
    await rejectsWith('23514', (tx) => tx`
      update interviews set scheduled_end = scheduled_start - interval '1 hour'
      where loop_id = ${ids.anaLoop}`);
  });

  it('unscheduled with no time is fine', async () => {
    await inRolledBackTx(async (tx) => {
      const rows = await tx`
        update interviews set status = 'unscheduled', scheduled_start = null, scheduled_end = null
        where loop_id = ${ids.anaLoop} returning id`;
      expect(rows.length).toBeGreaterThan(0);
    });
  });
});

describe('manual placement override (spec 004 §7a)', () => {
  it('defaults to no override and no acknowledged blocker', async () => {
    // The default has to be false rather than null: every seeded row predates §7a, and
    // "we do not know whether a human forced this" is not a state the audit trail may have.
    const rows = await owner<{ manual_override: boolean; acknowledged_blocker: unknown }[]>`
      select manual_override, acknowledged_blocker from interviews where loop_id = ${ids.anaLoop}`;
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.manual_override).toBe(false);
      expect(row.acknowledged_blocker).toBeNull();
    }
  });

  it('a blocker payload round-trips as the structured union the solver emits', async () => {
    // Stored whole and read back whole — that is the reason it is jsonb and not a table.
    const blocker = {
      reason: 'panelist_busy',
      roundId: ids.anaFirstRound,
      roundKind: 'coding',
      atUtc: '2026-03-12T17:00:00.000Z',
      busyPanelists: [{ id: ids.maya, name: 'Maya Reyes' }],
    };
    await inRolledBackTx(async (tx) => {
      const [row] = await tx<{ manual_override: boolean; acknowledged_blocker: unknown }[]>`
        update interviews
          set manual_override = true, acknowledged_blocker = ${tx.json(blocker)}
        where round_id = ${ids.anaFirstRound}
        returning manual_override, acknowledged_blocker`;
      expect(row?.manual_override).toBe(true);
      expect(row?.acknowledged_blocker).toEqual(blocker);
    });
  });

  it('an acknowledged blocker without an override is rejected', async () => {
    // Mirrors the contract's refine: a blocker only exists because someone overrode it.
    // Without this, a row can claim a human was warned when nothing recorded them acting.
    await rejectsWith('23514', (tx) => tx`
      update interviews set acknowledged_blocker = ${tx.json({ reason: 'no_rounds' })}
      where round_id = ${ids.anaFirstRound}`);
  });

  it('an override with no blocker is fine — a clean manual placement overrides nothing', async () => {
    await inRolledBackTx(async (tx) => {
      const rows = await tx`
        update interviews set manual_override = true
        where round_id = ${ids.anaFirstRound} returning id`;
      expect(rows).toHaveLength(1);
    });
  });
});

describe('candidate availability (spec 004 §6)', () => {
  it('is stored in the candidate\'s zone, alongside the organizer\'s', async () => {
    const [loop] = await owner<
      { timezone: string; candidate_timezone: string; candidate_window_start: string }[]
    >`select timezone, candidate_timezone, candidate_window_start
        from interview_loops where id = ${ids.anaLoop}`;
    expect(loop?.timezone).toBe('America/Los_Angeles');
    expect(loop?.candidate_timezone).toBe('America/New_York');
    expect(loop?.candidate_window_start).toBe('09:00:00');
  });

  it('a half-filled window is rejected — a bound with no zone bounds nothing', async () => {
    await rejectsWith('23514', (tx) => tx`
      update interview_loops set candidate_timezone = null where id = ${ids.anaLoop}`);
  });

  it('a window that ends before it starts is rejected', async () => {
    await rejectsWith('23514', (tx) => tx`
      update interview_loops set candidate_window_end = '08:00' where id = ${ids.anaLoop}`);
  });
});
