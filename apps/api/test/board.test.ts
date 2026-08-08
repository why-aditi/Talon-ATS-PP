/**
 * The board endpoints — spec 004 §10.
 *
 * The numbers below are the deliverable, and they are the ones `metrics.test.ts`
 * already pins from the seed: 100/56/33/22/11 and medians 2/4/6/3. That file proves
 * the SEED derives them; this one proves the ENDPOINT does, from its own query. A
 * change that makes the board read 42/21/8 has gone back to the screenshot (spec 003
 * §5.3) rather than fixed anything.
 */
import postgres from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { BoardSchema, ERROR_TYPES, type ApplicationCard, type Board } from '@talon/contracts';
import { bearer, loadFixtures, signIn, startApp, type Fixtures, type TestApp } from './helpers.js';
import { OWNER_URL } from './urls.js';

let test: TestApp;
let fixtures: Fixtures;
let auth: Record<string, string>;
const owner = postgres(OWNER_URL, { max: 1, onnotice: () => {} });

/** The seed as this suite found it, restored before every test that writes. */
let pristine: { id: string; stage: string; rank: string; version: number; status: string }[];
/**
 * The highest `stage_transitions` id the seed produced. Everything above it is this
 * suite's own doing and is removed between tests.
 *
 * A high-water mark, NOT a time window. The first version of this cleanup deleted by
 * `occurred_at between 1 and 6 days ago` — which is exactly where the seeded history
 * lives, so it quietly destroyed Marcus Webb's `applied -> screen` transition and then
 * asserted against the wreckage. The table is append-only and its ids are monotonic;
 * that is the only predicate that can tell "mine" from "the seed's".
 */
let seedHighWater: number;

beforeAll(async () => {
  test = await startApp();
  fixtures = await loadFixtures();
  const [mark] = await owner`select coalesce(max(id), 0)::int as id from stage_transitions`;
  seedHighWater = mark?.['id'] as number;
  pristine = await owner`
    select id, current_stage_id as stage, board_rank as rank, version, status
    from applications where job_id = ${fixtures.talon.jobId}`.then((rows) =>
    rows.map((r) => ({
      id: r['id'] as string,
      stage: r['stage'] as string,
      rank: r['rank'] as string,
      version: r['version'] as number,
      status: r['status'] as string,
    })),
  );
});

afterAll(async () => {
  await owner.end();
  await test.close();
});

/**
 * Every mutating test puts ENG-204 back exactly as it found it.
 *
 * The alternative is what the isolation suite ran into: a suite that moves a seeded
 * candidate and leaves them moved breaks assertions in files it has never heard of.
 * `stage_transitions` is append-only so the history keeps growing — which is why the
 * stats assertions below run against a restored board rather than assuming ordering.
 */
beforeEach(async () => {
  // Signed in per test, not once in `beforeAll`. `auth-chain.test.ts` deliberately
  // sets `tokens_valid_after` on this same recruiter to prove that an unexpired token
  // is still refused — and vitest runs files in parallel, so a token minted once at
  // the top of this file lands inside that window and every request here 401s. A suite
  // should not depend on its credential outliving another file's deliberate
  // invalidation.
  auth = bearer(await signIn(test, fixtures.talon.recruiter));

  for (const row of pristine) {
    await owner`
      update applications
      set current_stage_id = ${row.stage}, board_rank = ${row.rank},
          version = ${row.version}, status = ${row.status}
      where id = ${row.id}`;
  }
  await owner`delete from stage_transitions where id > ${seedHighWater}`;
  await owner`delete from outbox where tenant_id = ${fixtures.talon.tenantId}`;
});

const getBoard = async (): Promise<Board> => {
  const res = await test.app.inject({
    method: 'GET',
    url: `/v1/jobs/${fixtures.talon.jobId}/board`,
    headers: auth,
  });
  expect(res.statusCode).toBe(200);
  // Parsed, not cast: every assertion rests on the response matching the contract, so
  // a drift fails here rather than as a confusing expectation three lines down.
  return BoardSchema.parse(res.json());
};

const column = (board: Board, name: string) => board.columns.find((c) => c.name === name)!;
const card = (board: Board, name: string): ApplicationCard =>
  board.columns.flatMap((c) => c.cards).find((c) => c.name === name)!;

describe('GET the board', () => {
  it('serves five columns — rejected and withdrawn are outcomes, not columns', async () => {
    const board = await getBoard();
    expect(board.columns.map((c) => c.name)).toEqual(['Applied', 'Screen', 'Onsite', 'Offer', 'Hired']);
    // They exist as job_stages rows; an application has to land somewhere when it is
    // rejected. Serving them would put two permanently empty columns on every board.
    const stages = await owner`select canonical from job_stages where job_id = ${fixtures.talon.jobId}`;
    expect(stages.map((r) => r['canonical'])).toContain('rejected');
  });

  it('places the nine seeded candidates 4 / 2 / 1 / 1 / 1', async () => {
    const board = await getBoard();
    expect(column(board, 'Applied').cards.map((c) => c.name)).toEqual([
      'Tess Bianchi',
      'Omar Haddad',
      'Jordan Cole',
      'Priya Nair',
    ]);
    expect(column(board, 'Screen').cards.map((c) => c.name)).toEqual(['Elena Ruiz', 'Marcus Webb']);
    expect(column(board, 'Onsite').cards.map((c) => c.name)).toEqual(['Ana Petrova']);
    expect(column(board, 'Offer').cards.map((c) => c.name)).toEqual(['Sofia Lindqvist']);
    expect(column(board, 'Hired').cards.map((c) => c.name)).toEqual(['David Kim']);
  });

  /**
   * The same figures `metrics.test.ts:121` pins from the seed, now produced by the
   * endpoint's own query. Both have to agree or one of them is lying.
   */
  it('derives 100 / 56 / 33 / 22 / 11 and medians 2 / 4 / 6 / 3', async () => {
    const board = await getBoard();
    expect(board.columns.map((c) => c.stats.passRatePct)).toEqual([100, 56, 33, 22, 11]);
    expect(board.columns.map((c) => c.stats.medianDaysInStage)).toEqual([2, 4, 6, 3, null]);
  });

  it('takes the median from completed dwells, not from the cards in the column', async () => {
    // Applied holds 4d/3d/2d/1d, which average to 2.5. The real figure is 2, over the
    // five candidates who have LEFT Applied. If this reads 2.5 the query has started
    // measuring the wrong population (spec 004 §4.1).
    const board = await getBoard();
    expect(column(board, 'Applied').stats.medianDaysInStage).toBe(2);
    expect(column(board, 'Applied').cards.map((c) => c.daysInStage)).toEqual([4, 3, 2, 1]);
  });

  it('reads the reference card content, with nextAction derived from the stage', async () => {
    const board = await getBoard();
    const elena = card(board, 'Elena Ruiz');
    expect(elena).toMatchObject({
      currentTitle: 'Backend Engineer',
      currentCompany: 'Cove',
      source: 'outbound',
      status: 'active',
      daysInStage: 8,
      // Spec 004 §5: the verb is derivable today, the qualifier ("Call Tue") arrives
      // with scheduling.
      nextAction: 'Call',
    });
    expect(card(board, 'David Kim')).toMatchObject({ status: 'hired', nextAction: 'Hired' });
  });

  it('404s for another tenant’s job, never 403', async () => {
    const res = await test.app.inject({
      method: 'GET',
      url: `/v1/jobs/${fixtures.acme.jobId}/board`,
      headers: auth,
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().type).toBe(ERROR_TYPES.NOT_FOUND);
  });
});

/**
 * CLAUDE.md non-negotiable #18. The failure this prevents does not look like a bug in
 * reordering — it looks like a flaky 409 on an unrelated card, which is why the test
 * has to span both writes.
 */
describe('a rank-only reorder does not bump version', () => {
  it('reorders twice and still accepts a stage move on the original version', async () => {
    const before = await getBoard();
    const tess = card(before, 'Tess Bianchi');
    const priya = card(before, 'Priya Nair');
    const applied = column(before, 'Applied');

    const rank = (id: string, body: object) =>
      test.app.inject({ method: 'PATCH', url: `/v1/applications/${id}/rank`, headers: auth, payload: body });

    expect((await rank(tess.id, { beforeId: null, afterId: priya.id })).statusCode).toBe(200);
    expect((await rank(priya.id, { beforeId: tess.id, afterId: null })).statusCode).toBe(200);

    const middle = await getBoard();
    expect(card(middle, 'Tess Bianchi').version).toBe(tess.version);
    expect(card(middle, 'Priya Nair').version).toBe(priya.version);
    // ...and the order actually changed, so the version claim is not true by inaction.
    expect(column(middle, 'Applied').cards.map((c) => c.name)).not.toEqual(
      applied.cards.map((c) => c.name),
    );

    // The move carries the version read BEFORE either reorder. If a reorder had bumped
    // it, this 409s for no reason — the flaky board behaviour #18 exists to prevent.
    const res = await test.app.inject({
      method: 'PATCH',
      url: `/v1/applications/${priya.id}/stage`,
      headers: auth,
      payload: {
        fromStageId: applied.stageId,
        toStageId: column(before, 'Screen').stageId,
        version: priya.version,
        beforeId: null,
        afterId: null,
      },
    });
    expect(res.statusCode).toBe(200);
  });
});

describe('a stage move', () => {
  const move = (id: string, body: object) =>
    test.app.inject({ method: 'PATCH', url: `/v1/applications/${id}/stage`, headers: auth, payload: body });

  it('bumps version, resets time in stage, and writes transition, activity and outbox atomically', async () => {
    const before = await getBoard();
    const elena = card(before, 'Elena Ruiz');
    const res = await move(elena.id, {
      fromStageId: column(before, 'Screen').stageId,
      toStageId: column(before, 'Onsite').stageId,
      version: elena.version,
      beforeId: null,
      afterId: null,
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ version: elena.version + 1, daysInStage: 0, nextAction: 'Loop' });

    // All four writes, one transaction (ARCHITECTURE §6.1). Nothing is published
    // inline: a failed publish must never roll back a committed state change.
    const [transition] = await owner`
      select to_stage_id from stage_transitions
      where application_id = ${elena.id} order by id desc limit 1`;
    expect(transition?.['to_stage_id']).toBe(column(before, 'Onsite').stageId);

    const [activity] = await owner`
      select type from activities where application_id = ${elena.id} order by id desc limit 1`;
    expect(activity?.['type']).toBe('stage_changed');

    const [event] = await owner`
      select event_type, payload, published_at from outbox
      where aggregate_id = ${elena.id} order by id desc limit 1`;
    expect(event?.['event_type']).toBe('application.stage_changed');
    // Ids and versions only — never entity state, so a stale broadcast cannot write
    // bad data into a client cache.
    expect(Object.keys(event?.['payload'] as object).sort()).toEqual([
      'applicationId',
      'jobId',
      'toStageId',
      'version',
    ]);
    // Unpublished: the relay stamps this, and the relay is not running.
    expect(event?.['published_at']).toBeNull();
  });

  it('places the card between the neighbours it was given', async () => {
    const before = await getBoard();
    const elena = card(before, 'Elena Ruiz');
    const ana = card(before, 'Ana Petrova');
    await move(elena.id, {
      fromStageId: column(before, 'Screen').stageId,
      toStageId: column(before, 'Onsite').stageId,
      version: elena.version,
      beforeId: ana.id,
      afterId: null,
    });
    expect(column(await getBoard(), 'Onsite').cards.map((c) => c.name)).toEqual([
      'Elena Ruiz',
      'Ana Petrova',
    ]);
  });

  /** ARCHITECTURE §6.1 spends a paragraph keeping these apart; a client that collapsed
   *  them would re-apply a stage change over someone else's move. */
  it('409s on a stale version', async () => {
    const before = await getBoard();
    const elena = card(before, 'Elena Ruiz');
    const res = await move(elena.id, {
      fromStageId: column(before, 'Screen').stageId,
      toStageId: column(before, 'Onsite').stageId,
      version: elena.version + 5,
      beforeId: null,
      afterId: null,
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().type).toBe(ERROR_TYPES.STAGE_VERSION_CONFLICT);
    expect(res.json().current.name).toBe('Elena Ruiz');
  });

  it('409s on a from-stage mismatch even when the version matches', async () => {
    const before = await getBoard();
    const elena = card(before, 'Elena Ruiz');
    const res = await move(elena.id, {
      // The client believed she was in Onsite; she is in Screen.
      fromStageId: column(before, 'Onsite').stageId,
      toStageId: column(before, 'Offer').stageId,
      version: elena.version,
      beforeId: null,
      afterId: null,
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().type).toBe(ERROR_TYPES.STAGE_MOVED);
    expect(res.json().currentStageName).toBe('Screen');
  });

  it('leaves nothing behind when it conflicts', async () => {
    const before = await getBoard();
    const elena = card(before, 'Elena Ruiz');
    await move(elena.id, {
      fromStageId: column(before, 'Onsite').stageId,
      toStageId: column(before, 'Offer').stageId,
      version: elena.version,
      beforeId: null,
      afterId: null,
    });
    // No half-applied move: same stage, same version, and no event queued for a
    // change that never happened.
    expect(card(await getBoard(), 'Elena Ruiz')).toMatchObject({ version: elena.version });
    expect(column(await getBoard(), 'Screen').cards.map((c) => c.name)).toContain('Elena Ruiz');
    const events = await owner`select id from outbox where aggregate_id = ${elena.id}`;
    expect(events).toHaveLength(0);
  });

  it('422s a move to a terminal stage with no reason', async () => {
    const before = await getBoard();
    const sofia = card(before, 'Sofia Lindqvist');
    const res = await move(sofia.id, {
      fromStageId: column(before, 'Offer').stageId,
      toStageId: column(before, 'Hired').stageId,
      version: sofia.version,
      beforeId: null,
      afterId: null,
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().type).toBe(ERROR_TYPES.REASON_REQUIRED);
  });

  it('accepts a terminal move that carries one, and flips status to hired', async () => {
    const before = await getBoard();
    const sofia = card(before, 'Sofia Lindqvist');
    const res = await move(sofia.id, {
      fromStageId: column(before, 'Offer').stageId,
      toStageId: column(before, 'Hired').stageId,
      version: sofia.version,
      reason: 'Accepted the offer',
      beforeId: null,
      afterId: null,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe('hired');
    const [transition] = await owner`
      select reason from stage_transitions where application_id = ${sofia.id} order by id desc limit 1`;
    expect(transition?.['reason']).toBe('Accepted the offer');
  });

  it('404s another tenant’s application rather than 403', async () => {
    const [acme] = await owner`
      select id from applications where job_id = ${fixtures.acme.jobId} limit 1`;
    const before = await getBoard();
    const res = await move(acme?.['id'] as string, {
      fromStageId: column(before, 'Applied').stageId,
      toStageId: column(before, 'Screen').stageId,
      version: 1,
      beforeId: null,
      afterId: null,
    });
    expect(res.statusCode).toBe(404);
  });
});

/**
 * The case the seed cannot produce and `metrics.test.ts` therefore cannot catch.
 *
 * `stage_transitions` is append-only and a correction is a new row (non-negotiable
 * #4), so one application can enter the same stage twice. A self-join on
 * `nxt.from_stage_id = ent.to_stage_id` pairs entry #1 with EVERY later exit, which
 * inflates the median — invisibly, because no seeded candidate re-enters anything.
 */
describe('a stage re-entered after a correction', () => {
  /**
   * The case the seed cannot produce, and therefore the one `metrics.test.ts` cannot
   * catch. `stage_transitions` is append-only and a correction is a new row
   * (non-negotiable #4), so one application can enter the same stage twice.
   *
   * The construction matters. A first attempt inserted history that predated the
   * candidate's seeded entry, and the buggy query answered with NEGATIVE dwells, which
   * satisfied a "must not inflate" assertion perfectly while proving nothing. The
   * transitions below are ordered so the two queries genuinely disagree: the correct
   * one pairs each entry with its OWN exit and reports 4, the naive self-join also
   * pairs Marcus's first entry with his second exit and reports 3.
   */
  it('pairs each entry with its own exit, not with every later one', async () => {
    const before = await getBoard();
    expect(column(before, 'Screen').stats.medianDaysInStage).toBe(4);

    const marcus = card(before, 'Marcus Webb');
    const screen = column(before, 'Screen').stageId;
    const onsite = column(before, 'Onsite').stageId;
    const actor = fixtures.talon.recruiter.id;
    const tenant = fixtures.talon.tenantId;

    // Marcus entered Screen 5 days ago (seed). He leaves, is put back — the
    // correction — and leaves again. Each real dwell is one day.
    await owner`
      insert into stage_transitions (tenant_id, application_id, from_stage_id, to_stage_id, actor_id, occurred_at)
      values (${tenant}, ${marcus.id}, ${screen}, ${onsite}, ${actor}, now() - interval '4 days'),
             (${tenant}, ${marcus.id}, ${onsite}, ${screen}, ${actor}, now() - interval '3 days'),
             (${tenant}, ${marcus.id}, ${screen}, ${onsite}, ${actor}, now() - interval '2 days')`;

    // Ana, Sofia and David each dwelled 4 days in Screen; Marcus adds two 1-day
    // dwells, so the correct median of [1,1,4,4,4] is still 4. The naive join also
    // pairs his first entry with his second exit, adding a spurious dwell and moving
    // the median off 4. Verified by reverting the query and watching this fail.
    //
    // No cleanup here: `beforeEach` removes everything above the seed's high-water
    // mark, which is the only way to delete this suite's rows without risking the
    // seed's.
    expect(column(await getBoard(), 'Screen').stats.medianDaysInStage).toBe(4);
  });
});
