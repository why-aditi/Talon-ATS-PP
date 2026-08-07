import type { Job, StageDistribution } from '@talon/contracts';

/**
 * The six seeded Talon Inc. jobs, derived from `packages/db/src/seed.ts` rather than
 * read off `docs/reference/02-jobs-list@2x.png`. Where the two disagree, the seed wins
 * — the screen is a picture, the seed is what the API will actually aggregate.
 *
 * Three divergences from the reference screen, all deliberate:
 *
 *  1. ENG-204 reads 8 in process / 9 active, not 18 / 38. Spec 001 §11 open question 5,
 *     answered 2026-08-07: the kanban is the truth, and it pictures exactly nine
 *     candidates. Do not "fix" these numbers to match the screenshot.
 *  2. The reference distribution bars show an Offer segment on jobs the seed gives no
 *     offers to. The bulk seed cycles applications through Applied/Screen/Onsite only,
 *     so those bars render three segments here, not four. Recorded, not manufactured.
 *  3. `recruiter.avatarColor` is null throughout. The contract ships the field, but
 *     `packages/db` stores a raw hex outside the `avatar.1–8` ramp, so the UI derives
 *     the fill by hashing the recruiter id instead (DESIGN_SYSTEM §3). See §7.4.
 *
 * ⚠ `activeCount` follows the seed and the screen — TOTAL applications ever received.
 * The contract's docstring says "not rejected or withdrawn; includes hired", which for
 * every bulk-seeded job collapses activeCount onto inProcessCount (ENG-209 would read
 * 8 active / 8 in process instead of the screen's 21 / 8) and makes the column
 * redundant. Cross-stream disagreement, raised in §7.4 — owner: api.
 *
 * User ids are pinned so `avatarToken()` lands on the reference hues — Maya amber,
 * Tom blue, Sam violet. With real uuidv7 ids from the seed the hues will differ; the
 * hash is on id by design (DESIGN_SYSTEM §3), so that is an accepted delta.
 */
const MAYA = { id: '0198f3a1-0007-7000-8000-000000000001', name: 'Maya Reyes', avatarColor: null };
const TOM = { id: '0198f3a1-0001-7000-8000-000000000001', name: 'Tom Iwu', avatarColor: null };
const SAM = { id: '0198f3a1-0006-7000-8000-000000000001', name: 'Sam Altmann', avatarColor: null };

const NO_APPLICATIONS: StageDistribution = {
  applied: 0,
  screen: 0,
  onsite: 0,
  offer: 0,
  hired: 0,
  rejected: 0,
  withdrawn: 0,
};

/** The seed backdates every job to 90 days before seeding; fixtures pin the instant. */
const CREATED_AT = '2026-05-09T09:00:00.000Z';
const UPDATED_AT = '2026-08-07T09:00:00.000Z';

/** Nothing on this screen renders comp, but the union has to be inhabited correctly. */
const NO_BAND = { visible: true, band: null } as const;

const base = {
  employmentType: null,
  hiringManagerId: null,
  openings: 1,
  createdAt: CREATED_AT,
  updatedAt: UPDATED_AT,
} satisfies Partial<Job>;

export const JOBS: Job[] = [
  {
    ...base,
    id: '0198f3a2-0001-7000-8000-000000000001',
    reqCode: 'ENG-204',
    title: 'Senior Product Engineer',
    department: 'Engineering',
    location: 'Remote (US)',
    status: 'active',
    recruiter: MAYA,
    hiringManagerId: SAM.id,
    // The nine pictured candidates: Applied 4 · Screen 2 · Onsite 1 · Offer 1 · Hired 1.
    stageDistribution: { ...NO_APPLICATIONS, applied: 4, screen: 2, onsite: 1, offer: 1, hired: 1 },
    inProcessCount: 8,
    activeCount: 9,
    comp: { visible: true, band: { minCents: '19000000', maxCents: '22500000', currency: 'USD' } },
  },
  {
    ...base,
    id: '0198f3a2-0002-7000-8000-000000000001',
    reqCode: 'ENG-209',
    title: 'Staff Design Engineer',
    department: 'Engineering',
    location: 'SF / Hybrid',
    status: 'active',
    recruiter: TOM,
    stageDistribution: { ...NO_APPLICATIONS, applied: 4, screen: 3, onsite: 1, rejected: 13 },
    inProcessCount: 8,
    activeCount: 21,
    comp: NO_BAND,
  },
  {
    ...base,
    id: '0198f3a2-0003-7000-8000-000000000001',
    reqCode: 'ENG-198',
    title: 'Engineering Manager, Infra',
    department: 'Engineering',
    location: 'New York',
    status: 'on_hold',
    recruiter: MAYA,
    stageDistribution: { ...NO_APPLICATIONS, applied: 2, screen: 1, rejected: 9 },
    inProcessCount: 3,
    activeCount: 12,
    comp: NO_BAND,
  },
  {
    ...base,
    id: '0198f3a2-0004-7000-8000-000000000001',
    reqCode: 'DES-114',
    title: 'Product Designer, Growth',
    department: 'Design',
    location: 'Remote (EU)',
    status: 'active',
    recruiter: TOM,
    stageDistribution: { ...NO_APPLICATIONS, applied: 8, screen: 8, onsite: 4, rejected: 34 },
    inProcessCount: 20,
    activeCount: 54,
    comp: NO_BAND,
  },
  {
    ...base,
    id: '0198f3a2-0005-7000-8000-000000000001',
    reqCode: 'PPL-031',
    title: 'Recruiting Coordinator',
    department: 'People',
    location: 'Remote (US)',
    status: 'active',
    recruiter: MAYA,
    stageDistribution: { ...NO_APPLICATIONS, applied: 8, screen: 8, onsite: 3, rejected: 48 },
    inProcessCount: 19,
    activeCount: 67,
    comp: NO_BAND,
  },
  {
    ...base,
    id: '0198f3a2-0006-7000-8000-000000000001',
    reqCode: 'SAL-076',
    title: 'Head of Sales, EMEA',
    department: 'Sales',
    location: 'London',
    status: 'closing',
    recruiter: SAM,
    hiringManagerId: SAM.id,
    stageDistribution: { ...NO_APPLICATIONS, applied: 3, screen: 2, onsite: 1, rejected: 3 },
    inProcessCount: 6,
    activeCount: 9,
    comp: NO_BAND,
  },
];

/**
 * Sidebar counts. Only Jobs is derived — Pipeline counts the cards on the default
 * board, which means picking a job arbitrarily, so it is pinned to the reference
 * value alongside the three that have no endpoint at all yet.
 *
 * ponytail: static until GET /v1/review-queue, /v1/interviews and /v1/offers exist —
 * those replace these constants one for one. Spec §11 open question 7 asks where these
 * come from: they are tenant-wide, so they cannot ride the {data, nextCursor} envelope.
 */
export const NAV_COUNTS = {
  jobs: JOBS.length,
  pipeline: 9,
  reviewInbox: 4,
  scheduling: 4,
  offers: 1,
} as const;
