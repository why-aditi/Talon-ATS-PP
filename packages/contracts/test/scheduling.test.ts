import { describe, expect, test } from 'vitest';
import { BLOCKER_REASONS, ROUND_KINDS, solveLoop, type SolveBlocker as DomainBlocker } from '@talon/domain';
import {
  ArrangementSchema,
  BusyIntervalSchema,
  InterviewLoopSchema,
  SolveBlockerSchema,
  SolveResultSchema,
} from '../src/index.js';

const D = '2026-08-06T';

describe('SolveBlockerSchema', () => {
  test('covers exactly the reasons the solver can produce', () => {
    // The one thing that silently rots: the domain grows a blocker variant, the contract
    // does not, and the API 500s serialising a perfectly good answer.
    const inSchema = SolveBlockerSchema.options.map((option) => option.shape.reason.value);
    expect([...inSchema].sort()).toEqual([...BLOCKER_REASONS].sort());
  });

  test('the reference screen’s conflict round-trips', () => {
    expect(
      SolveBlockerSchema.parse({
        reason: 'panelist_busy',
        roundId: '0198f3a7-0002-7000-8000-000000000001',
        roundKind: 'values',
        atUtc: `${D}15:00:00.000Z`,
        busyPanelists: [{ id: '0198f3a1-0007-7000-8000-000000000001', name: 'Maya Reyes' }],
      }).reason,
    ).toBe('panelist_busy');
  });

  test('a busy blocker with nobody in it is not a blocker', () => {
    expect(
      SolveBlockerSchema.safeParse({
        reason: 'panelist_busy',
        roundId: '0198f3a7-0002-7000-8000-000000000001',
        roundKind: 'values',
        atUtc: `${D}15:00:00.000Z`,
        busyPanelists: [],
      }).success,
    ).toBe(false);
  });
});

describe('SolveResultSchema', () => {
  const arrangement = {
    startUtc: `${D}14:00:00.000Z`,
    endUtc: `${D}16:00:00.000Z`,
    spanMin: 120,
    totalGapMin: 0,
    rounds: [
      {
        roundId: '0198f3a7-0002-7000-8000-000000000001',
        startUtc: `${D}14:00:00.000Z`,
        endUtc: `${D}15:00:00.000Z`,
        panelistIds: ['0198f3a1-0007-7000-8000-000000000001'],
      },
    ],
  };

  test('accepts arrangements with no blocker, and a blocker with no arrangements', () => {
    expect(SolveResultSchema.safeParse({ arrangements: [arrangement], partial: false, blocker: null }).success).toBe(
      true,
    );
    expect(
      SolveResultSchema.safeParse({ arrangements: [], partial: false, blocker: { reason: 'no_rounds' } }).success,
    ).toBe(true);
  });

  test('rejects an empty list with nothing to say about it — §7’s whole point', () => {
    expect(SolveResultSchema.safeParse({ arrangements: [], partial: false, blocker: null }).success).toBe(false);
  });

  test('rejects arrangements carrying a blocker as well', () => {
    expect(
      SolveResultSchema.safeParse({
        arrangements: [arrangement],
        partial: false,
        blocker: { reason: 'timed_out' },
      }).success,
    ).toBe(false);
  });
});

describe('the wire is UTC only', () => {
  test('an offset timestamp is not an instant', () => {
    expect(BusyIntervalSchema.safeParse({ startUtc: `${D}14:00:00+05:30`, endUtc: `${D}15:00:00Z` }).success).toBe(
      false,
    );
  });
});

describe('a solved arrangement serialises into the contract shape', () => {
  test('the domain’s Dates map to the wire without loss', () => {
    const roundId = '0198f3a7-0002-7000-8000-000000000001';
    const panelistId = '0198f3a1-0007-7000-8000-000000000001';
    const result = solveLoop(
      {
        rounds: [{ id: roundId, durationMin: 60, requiredPanelistIds: [panelistId] }],
        busy: { [panelistId]: [] },
        windowStart: new Date(`${D}14:00:00.000Z`),
        windowEnd: new Date(`${D}16:00:00.000Z`),
        maxGapMin: 0,
        maxSpanMin: 240,
      },
      { now: () => 0 },
    );
    const [best] = result.arrangements;
    expect(best).toBeDefined();

    const parsed = ArrangementSchema.parse({
      startUtc: best?.start.toISOString(),
      endUtc: best?.end.toISOString(),
      spanMin: best?.spanMin,
      totalGapMin: best?.totalGapMin,
      rounds: best?.rounds.map((r) => ({
        roundId: r.roundId,
        startUtc: r.start.toISOString(),
        endUtc: r.end.toISOString(),
        panelistIds: r.panelistIds,
      })),
    });
    expect(parsed.startUtc).toBe(`${D}14:00:00.000Z`);
  });

  test('every domain blocker reason has a contract variant to land in', () => {
    // A compile-time exhaustiveness check would not catch a MISSING variant, only a
    // spurious one, so the list is compared at runtime above and sampled here.
    const reasons: DomainBlocker['reason'][] = [...BLOCKER_REASONS];
    expect(reasons).toContain('panelist_busy');
    expect(ROUND_KINDS).toContain('values');
  });
});

describe('InterviewLoopSchema', () => {
  const loop = {
    id: '0198f3a7-0001-7000-8000-000000000001',
    applicationId: '0198f3a6-0007-7000-8000-000000000001',
    status: 'proposed',
    candidate: { id: '0198f3a6-0007-7000-8000-000000000001', name: 'Ana Petrova', zone: 'America/Chicago' },
    jobTitle: 'Senior Product Engineer',
    organizerZone: 'America/Chicago',
    targetDate: '2026-08-06',
    candidateWindow: { startUtc: `${D}14:00:00.000Z`, endUtc: `${D}21:00:00.000Z` },
    searchWindow: { startUtc: `${D}14:00:00.000Z`, endUtc: `${D}21:00:00.000Z` },
    panelists: [
      {
        id: '0198f3a1-0007-7000-8000-000000000001',
        name: 'Maya Reyes',
        shortName: 'Maya R.',
        calendarConnected: true,
      },
    ],
    rounds: [
      {
        id: '0198f3a7-0002-7000-8000-000000000001',
        kind: 'values',
        durationMin: 45,
        position: 2,
        isSwappable: false,
        panelists: [{ userId: '0198f3a1-0007-7000-8000-000000000001', isRequired: true }],
        interview: null,
      },
    ],
    busy: { '0198f3a1-0007-7000-8000-000000000001': [{ startUtc: `${D}15:00:00.000Z`, endUtc: `${D}16:00:00.000Z` }] },
    hold: null,
    version: 1,
  };

  test('an unscheduled round carries no interview', () => {
    expect(InterviewLoopSchema.parse(loop).rounds[0]?.interview).toBeNull();
  });

  test('a manually overridden interview records what the recruiter was shown (§7a)', () => {
    const parsed = InterviewLoopSchema.parse({
      ...loop,
      rounds: [
        {
          ...loop.rounds[0],
          interview: {
            id: '0198f3a7-0003-7000-8000-000000000001',
            status: 'pending',
            startUtc: `${D}15:00:00.000Z`,
            endUtc: `${D}15:45:00.000Z`,
            manualOverride: true,
            acknowledgedBlocker: {
              reason: 'panelist_busy',
              roundId: '0198f3a7-0002-7000-8000-000000000001',
              roundKind: 'values',
              atUtc: `${D}15:00:00.000Z`,
              busyPanelists: [{ id: '0198f3a1-0007-7000-8000-000000000001', name: 'Maya Reyes' }],
            },
          },
        },
      ],
    });
    expect(parsed.rounds[0]?.interview?.manualOverride).toBe(true);
  });

  test('a duration off the 15-minute grid is not placeable and is not accepted', () => {
    expect(
      InterviewLoopSchema.safeParse({ ...loop, rounds: [{ ...loop.rounds[0], durationMin: 50 }] }).success,
    ).toBe(false);
  });
});
