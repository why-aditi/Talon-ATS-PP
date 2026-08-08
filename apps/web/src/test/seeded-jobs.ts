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
 *  3. Avatar fills are derived by hashing the recruiter id (DESIGN_SYSTEM §3). Step 4
 *     dropped `recruiter.avatarColor` from the contract, which settles the question
 *     the other way from `packages/db` still storing a raw hex per user. See §7.4.
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
const MAYA = { id: '0198f3a1-0007-7000-8000-000000000001', name: 'Maya Reyes' };
const TOM = { id: '0198f3a1-0001-7000-8000-000000000001', name: 'Tom Iwu' };
const SAM = { id: '0198f3a1-0006-7000-8000-000000000001', name: 'Sam Altmann' };

const NO_APPLICATIONS: StageDistribution = {
  applied: 0,
  screen: 0,
  onsite: 0,
  offer: 0,
  hired: 0,
  rejected: 0,
  withdrawn: 0,
};

export const SEEDED_JOBS: Job[] = [
  {
    id: '0198f3a2-0001-7000-8000-000000000001',
    reqCode: 'ENG-204',
    title: 'Senior Product Engineer',
    department: 'Engineering',
    location: 'Remote (US)',
    status: 'active',
    recruiter: MAYA,
    // The nine pictured candidates: Applied 4 · Screen 2 · Onsite 1 · Offer 1 · Hired 1.
    stageDistribution: { ...NO_APPLICATIONS, applied: 4, screen: 2, onsite: 1, offer: 1, hired: 1 },
    inProcessCount: 8,
    activeCount: 9,
    band: { minCents: '19000000', maxCents: '22500000', currency: 'USD' },
  },
  {
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
  },
  {
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
  },
  {
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
  },
  {
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
  },
  {
    id: '0198f3a2-0006-7000-8000-000000000001',
    reqCode: 'SAL-076',
    title: 'Head of Sales, EMEA',
    department: 'Sales',
    location: 'London',
    status: 'closing',
    recruiter: SAM,
    stageDistribution: { ...NO_APPLICATIONS, applied: 3, screen: 2, onsite: 1, rejected: 3 },
    inProcessCount: 6,
    activeCount: 9,
  },
];
