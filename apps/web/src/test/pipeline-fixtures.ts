/**
 * ENG-204's board — spec 003 §5.
 *
 * Derived from `packages/db/src/seed.ts`, NOT read off `03-pipeline-kanban@2x.png`.
 * Where the two disagree the seed wins: the screen is a picture, the seed is what the
 * API will actually aggregate. Four deltas from the reference, all deliberate and all
 * recorded in spec 003 §5.3–5.4:
 *
 *  1. Pass rates read 100/56/33/22, not the pictured 100/42/21/8. Those percentages
 *     belong to a 38-application population (16/38, 8/38, 3/38) that agrees with the
 *     jobs list and disagrees with the nine cards drawn beside them. Spec 001 open
 *     question 5 resolved this toward the board; `packages/db/test/metrics.test.ts:121`
 *     already asserts 100/56/33/22. DO NOT "fix" these to match the screenshot.
 *  2. `LinkedIn` on Marcus Webb is the designer being loose with the source enum. He
 *     is seeded `outbound` and renders "Outbound". The enum is not widened for a pixel.
 *  3. `Hired` on David Kim is `application.status`, not a tag. It renders from status
 *     in terminal columns.
 *  4. "Starts Sep 1" is a reconstruction — the reference clips it at "Starts S…".
 *
 * ⚠ FIXTURE-ONLY INVENTIONS, with no schema, seed or contract behind them:
 *    • `skills` — nothing stores candidate skills. Spec 003 OQ-2 files the real
 *      modelling (a `candidate_skills` table or a parsed-resume projection) as M1
 *      work, so it does not arrive as a surprise when the endpoint is built.
 *    • `scoreAvg` — there is no scorecards table. Only Ana (4.2) and Sofia (4.6)
 *      carry one, matching the reference.
 *
 * Candidate ids are pinned so `avatarToken()` lands on the reference hues — the hash
 * is FNV-1a over the id and is not steerable, so the ids were searched for rather than
 * chosen. All nine match the screen exactly: Tess red, Omar green, Jordan and Priya
 * amber, Elena and Ana violet, Marcus and David blue, Sofia green.
 */
import type { Board, BoardColumn } from '../lib/pipeline-contract';

export const ENG204_JOB_ID = '0198f3a2-0001-7000-8000-000000000001';

export const STAGE_IDS = {
  applied: '0198f3a4-0001-7000-8000-000000000001',
  screen: '0198f3a4-0002-7000-8000-000000000001',
  onsite: '0198f3a4-0003-7000-8000-000000000001',
  offer: '0198f3a4-0004-7000-8000-000000000001',
  hired: '0198f3a4-0005-7000-8000-000000000001',
} as const;

/**
 * Column statistics are CARRIED, not computed.
 *
 * `medianDaysInStage` is the median of completed dwells across all nine candidate
 * histories — people who have LEFT the stage. Applied's four visible cards sit at
 * 4d/3d/2d/1d and would reduce to 2.5d; the real value is 2d, from the five
 * candidates who exited Applied (Elena, Marcus, Ana, Sofia, David, all at 2d).
 * Screen's 4d comes from Ana/Sofia/David, Onsite's 6d from Sofia/David, Offer's 3d
 * from David alone. Hired has no exits at all, so its median is null and the header
 * reads "closed".
 *
 * `passRatePct` is `reached / 9`: applied 9, screen 5, onsite 3, offer 2, hired 1.
 *
 * A fixture that recomputed these from its own cards would reproduce the exact bug
 * this comment exists to prevent, which is why they are literals.
 */
const STATS = {
  applied: { passRatePct: 100, medianDaysInStage: 2 },
  screen: { passRatePct: 56, medianDaysInStage: 4 },
  onsite: { passRatePct: 33, medianDaysInStage: 6 },
  offer: { passRatePct: 22, medianDaysInStage: 3 },
  hired: { passRatePct: 11, medianDaysInStage: null },
} as const;

/** Matches `TEMPLATE_STAGES` in packages/db/src/seed.ts: Applied has no SLA, the three
 *  middle stages are 5 days, terminal stages have none. Screen's 5 is what makes Elena
 *  (8d) stall and leaves Marcus (5d) alone — the `>` boundary, spec 003 §6.4. */
const SLA = { applied: null, screen: 5, onsite: 5, offer: 5, hired: null } as const;

export const CANDIDATES = {
  tess: '0198f3a3-0001-7000-8000-000000000002',
  omar: '0198f3a3-0002-7000-8000-000000000001',
  jordan: '0198f3a3-0003-7000-8000-000000000007',
  priya: '0198f3a3-0004-7000-8000-000000000002',
  elena: '0198f3a3-0005-7000-8000-000000000002',
  marcus: '0198f3a3-0006-7000-8000-000000000004',
  ana: '0198f3a3-0007-7000-8000-000000000004',
  sofia: '0198f3a3-0008-7000-8000-000000000007',
  david: '0198f3a3-0009-7000-8000-000000000003',
} as const;

const APPLICATION_IDS = {
  tess: '0198f3a5-0001-7000-8000-000000000001',
  omar: '0198f3a5-0002-7000-8000-000000000001',
  jordan: '0198f3a5-0003-7000-8000-000000000001',
  priya: '0198f3a5-0004-7000-8000-000000000001',
  elena: '0198f3a5-0005-7000-8000-000000000001',
  marcus: '0198f3a5-0006-7000-8000-000000000001',
  ana: '0198f3a5-0007-7000-8000-000000000001',
  sofia: '0198f3a5-0008-7000-8000-000000000001',
  david: '0198f3a5-0009-7000-8000-000000000001',
} as const;

type Who = keyof typeof CANDIDATES;

function card(
  who: Who,
  name: string,
  currentTitle: string,
  currentCompany: string,
  rest: Pick<import('../lib/pipeline-contract').ApplicationCard, 'source' | 'skills' | 'daysInStage' | 'nextAction'> &
    Partial<Pick<import('../lib/pipeline-contract').ApplicationCard, 'status' | 'scoreAvg'>>,
): import('../lib/pipeline-contract').ApplicationCard {
  return {
    id: APPLICATION_IDS[who],
    candidateId: CANDIDATES[who],
    name,
    currentTitle,
    currentCompany,
    status: 'active',
    scoreAvg: null,
    version: 1,
    ...rest,
  };
}

/** A fresh board on every call — the handler mutates its copy, so a shared object
 *  would leak state from one test into the next. */
export function eng204Board(): Board {
  const columns: BoardColumn[] = [
    {
      stageId: STAGE_IDS.applied,
      name: 'Applied',
      canonical: 'applied',
      position: 0,
      slaDays: SLA.applied,
      isTerminal: false,
      count: 4,
      stats: STATS.applied,
      cards: [
        card('tess', 'Tess Bianchi', 'Frontend Engineer', 'Halo', {
          source: 'agency',
          skills: [],
          daysInStage: 4,
          nextAction: 'Review',
        }),
        card('omar', 'Omar Haddad', 'Platform Engineer', 'Trellis', {
          source: 'careers_page',
          skills: [],
          daysInStage: 3,
          nextAction: 'Review',
        }),
        card('jordan', 'Jordan Cole', 'Fullstack', 'Beacon', {
          source: 'careers_page',
          skills: [],
          daysInStage: 2,
          nextAction: 'Review',
        }),
        card('priya', 'Priya Nair', 'SWE II', 'Loft', {
          source: 'referral',
          skills: [],
          daysInStage: 1,
          nextAction: 'Review',
        }),
      ],
    },
    {
      stageId: STAGE_IDS.screen,
      name: 'Screen',
      canonical: 'screen',
      position: 1,
      slaDays: SLA.screen,
      isTerminal: false,
      count: 2,
      stats: STATS.screen,
      cards: [
        // 8d against a 5d SLA — the only stalled card on the board.
        card('elena', 'Elena Ruiz', 'Backend Engineer', 'Cove', {
          source: 'outbound',
          skills: ['Go'],
          daysInStage: 8,
          nextAction: 'Call Tue',
        }),
        // 5d against a 5d SLA — NOT stalled. This card is the whole evidence for the
        // strict `>` threshold; changing its dwell silently changes the rule.
        card('marcus', 'Marcus Webb', 'SWE', 'Northwind', {
          source: 'outbound',
          skills: ['TypeScript'],
          daysInStage: 5,
          nextAction: 'Call Mon',
        }),
      ],
    },
    {
      stageId: STAGE_IDS.onsite,
      name: 'Onsite',
      canonical: 'onsite',
      position: 2,
      slaDays: SLA.onsite,
      isTerminal: false,
      count: 1,
      stats: STATS.onsite,
      cards: [
        card('ana', 'Ana Petrova', 'Senior SWE', 'Meridian', {
          source: 'referral',
          skills: ['React', 'Go'],
          daysInStage: 3,
          nextAction: 'Loop Thu',
          scoreAvg: 4.2,
        }),
      ],
    },
    {
      stageId: STAGE_IDS.offer,
      name: 'Offer',
      canonical: 'offer',
      position: 3,
      slaDays: SLA.offer,
      isTerminal: false,
      count: 1,
      stats: STATS.offer,
      cards: [
        card('sofia', 'Sofia Lindqvist', 'Staff Eng', 'Polar', {
          source: 'outbound',
          skills: ['Platform'],
          daysInStage: 1,
          nextAction: 'Offer out',
          scoreAvg: 4.6,
        }),
      ],
    },
    {
      stageId: STAGE_IDS.hired,
      name: 'Hired',
      canonical: 'hired',
      position: 4,
      slaDays: SLA.hired,
      isTerminal: true,
      count: 1,
      stats: STATS.hired,
      cards: [
        card('david', 'David Kim', 'Sr SWE', 'Argo', {
          source: 'referral',
          skills: [],
          daysInStage: 0,
          nextAction: 'Starts Sep 1',
          status: 'hired',
        }),
      ],
    },
  ];

  return {
    job: {
      id: ENG204_JOB_ID,
      title: 'Senior Product Engineer',
      reqCode: 'ENG-204',
      status: 'active',
      location: 'Remote (US)',
      // Maya's id matches `mocks/fixtures.ts` so her avatar is the same hue on both
      // screens — the hash is on id, and two ids for one person would be two colours.
      recruiter: { id: '0198f3a1-0007-7000-8000-000000000001', name: 'Maya Reyes' },
    },
    columns,
  };
}

/** The `empty` scenario: every stage still present, no cards. The board's shape is
 *  itself the information — collapsing an empty board to one message would hide which
 *  stages exist (spec 003 §6.5). */
export function emptyBoard(): Board {
  const board = eng204Board();
  return {
    ...board,
    columns: board.columns.map((column) => ({
      ...column,
      count: 0,
      cards: [],
      stats: { passRatePct: 0, medianDaysInStage: null },
    })),
  };
}
