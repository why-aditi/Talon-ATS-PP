/**
 * Fixtures for the four screens spec 007 builds — review inbox, candidates, offers,
 * reports. Served by `app/api/mock/[...path]/route.ts`; deleted wholesale when the
 * real endpoints land.
 *
 * Two rules govern the numbers here.
 *
 * 1. **Candidate ids are pinned and shared.** `avatarToken()` hashes hue off the
 *    candidate id, so a second set of ids gives one person two colours across two
 *    screens. These are the same ids `test/pipeline-fixtures.ts` pins, for the same
 *    reason it pins them — `mock-fixtures.test.ts` asserts the two lists agree rather
 *    than importing across the lib/test boundary to enforce it.
 *
 * 2. **The review queue is the board's Applied column.** Not a coincidence and not a
 *    separate population: reference screen 04 shows Tess 4d, Omar 3d, Jordan 2d and
 *    Priya 1d, which is exactly ENG-204's Applied column with `nextAction: 'Review'`.
 *    `appliedDaysAgo` here must equal `daysInStage` there or the two screens
 *    contradict each other about the same four people on the same afternoon.
 *
 * Where the reference shows a value, it is copied. Where it shows only one record's
 * detail — the queue renders Jordan's cover note and nobody else's — the others are
 * invented, and marked below.
 */
import { OfferSummarySchema } from '@talon/contracts';
import type {
  CandidateProfile,
  ListCandidatesResponse,
  ListOffersResponse,
  Offer,
  ReportsOverview,
  ReviewQueueResponse,
} from '@talon/contracts';

export const ENG204_JOB_ID = '0198f3a2-0001-7000-8000-000000000001';

/** Pinned to land on the reference avatar hues. See rule 1 above. */
export const CANDIDATE_IDS = {
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

export const APPLICATION_IDS = {
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

// ---------------------------------------------------------------------------
// Review inbox — reference 04
// ---------------------------------------------------------------------------

/**
 * Queue order is the reference's, which is neither rank order nor age order — the
 * screen shows Jordan, Priya, Omar, Tess while the board ranks Tess, Omar, Jordan,
 * Priya. Copied rather than sorted, because inventing a sort would assert an ordering
 * rule the design has not stated. Spec 007 OQ-7.
 */
export const reviewQueue = (): ReviewQueueResponse => ({
  waiting: 4,
  reviewedToday: 0,
  items: [
    {
      id: APPLICATION_IDS.jordan,
      candidateId: CANDIDATE_IDS.jordan,
      name: 'Jordan Cole',
      currentTitle: 'Fullstack',
      currentCompany: 'Beacon',
      location: 'Chicago, IL',
      appliedDaysAgo: 2,
      // Verbatim from the reference — the only cover note the screen actually shows.
      coverNote:
        'I have spent the last three years turning a monolith into event driven services at Beacon, and the scale problems in your job post are exactly the ones I have been living in. I would love to bring that to a product team that ships weekly.',
      resumeHighlights: [
        '5 yrs fullstack across TypeScript, Node, Postgres',
        'Led migration of 40 endpoints to an event bus',
        'Mentored 3 junior engineers',
      ],
      signal: { yearsExperience: 5, stackMatch: 'strong', locationFit: 'remote_ok' },
    },
    {
      id: APPLICATION_IDS.priya,
      candidateId: CANDIDATE_IDS.priya,
      name: 'Priya Nair',
      currentTitle: 'SWE II',
      currentCompany: 'Loft',
      location: 'Austin, TX',
      appliedDaysAgo: 1,
      // Invented — the reference never opens this record.
      coverNote:
        'Two years on Loft’s payments team, mostly on the reliability side. I am looking for a product surface where the work is closer to the people using it.',
      resumeHighlights: ['3 yrs backend, Go and Postgres', 'On-call for a tier-1 payments service'],
      signal: { yearsExperience: 3, stackMatch: 'partial', locationFit: 'onsite' },
    },
    {
      id: APPLICATION_IDS.omar,
      candidateId: CANDIDATE_IDS.omar,
      name: 'Omar Haddad',
      currentTitle: 'Platform Engineer',
      currentCompany: 'Trellis',
      location: 'Remote — Lisbon',
      appliedDaysAgo: 3,
      coverNote: null, // Exercises §10 case 3: the COVER NOTE card is omitted, not blank.
      resumeHighlights: [
        '7 yrs platform, Kubernetes and Terraform',
        'Cut deploy time from 40 min to 6',
        'Built the internal service template used by 30 teams',
      ],
      signal: { yearsExperience: 7, stackMatch: 'strong', locationFit: 'remote_ok' },
    },
    {
      id: APPLICATION_IDS.tess,
      candidateId: CANDIDATE_IDS.tess,
      name: 'Tess Bianchi',
      currentTitle: 'Frontend Engineer',
      currentCompany: 'Halo',
      location: 'Brooklyn, NY',
      appliedDaysAgo: 4,
      coverNote:
        'I care about the boring parts of frontend — focus order, empty states, what happens when the request fails. Your posting is the first one this quarter that mentioned any of them.',
      resumeHighlights: [], // §10 case 4: empty array, not a missing field.
      signal: { yearsExperience: 4, stackMatch: 'weak', locationFit: 'relocation' },
    },
  ],
});

// ---------------------------------------------------------------------------
// Candidates — reference 05 for the profile; the list has no reference (OQ-1)
// ---------------------------------------------------------------------------

export const candidates = (): ListCandidatesResponse => ({
  items: [
    { id: CANDIDATE_IDS.jordan, applicationId: APPLICATION_IDS.jordan, name: 'Jordan Cole', currentTitle: 'Fullstack', currentCompany: 'Beacon', jobTitle: 'Senior Product Engineer', stage: 'applied', daysInStage: 2, source: 'careers_page', status: 'active' },
    { id: CANDIDATE_IDS.priya, applicationId: APPLICATION_IDS.priya, name: 'Priya Nair', currentTitle: 'SWE II', currentCompany: 'Loft', jobTitle: 'Senior Product Engineer', stage: 'applied', daysInStage: 1, source: 'referral', status: 'active' },
    { id: CANDIDATE_IDS.omar, applicationId: APPLICATION_IDS.omar, name: 'Omar Haddad', currentTitle: 'Platform Engineer', currentCompany: 'Trellis', jobTitle: 'Senior Product Engineer', stage: 'applied', daysInStage: 3, source: 'careers_page', status: 'active' },
    { id: CANDIDATE_IDS.tess, applicationId: APPLICATION_IDS.tess, name: 'Tess Bianchi', currentTitle: 'Frontend Engineer', currentCompany: 'Halo', jobTitle: 'Senior Product Engineer', stage: 'applied', daysInStage: 4, source: 'agency', status: 'active' },
    { id: CANDIDATE_IDS.elena, applicationId: APPLICATION_IDS.elena, name: 'Elena Ruiz', currentTitle: 'Senior Engineer', currentCompany: 'Northwind', jobTitle: 'Senior Product Engineer', stage: 'screen', daysInStage: 8, source: 'outbound', status: 'active' },
    { id: CANDIDATE_IDS.marcus, applicationId: APPLICATION_IDS.marcus, name: 'Marcus Webb', currentTitle: 'Staff Engineer', currentCompany: 'Corvid', jobTitle: 'Senior Product Engineer', stage: 'screen', daysInStage: 2, source: 'referral', status: 'active' },
    { id: CANDIDATE_IDS.ana, applicationId: APPLICATION_IDS.ana, name: 'Ana Petrova', currentTitle: 'Senior SWE', currentCompany: 'Meridian', jobTitle: 'Senior Product Engineer', stage: 'onsite', daysInStage: 3, source: 'referral', status: 'active' },
    { id: CANDIDATE_IDS.sofia, applicationId: APPLICATION_IDS.sofia, name: 'Sofia Lindqvist', currentTitle: 'Product Engineer', currentCompany: 'Rune', jobTitle: 'Senior Product Engineer', stage: 'offer', daysInStage: 5, source: 'outbound', status: 'active' },
    { id: CANDIDATE_IDS.david, applicationId: APPLICATION_IDS.david, name: 'David Osei', currentTitle: 'Senior Engineer', currentCompany: 'Kestrel', jobTitle: 'Senior Product Engineer', stage: 'hired', daysInStage: 12, source: 'referral', status: 'hired' },
  ],
});

/**
 * Timestamps are fixed instants, not offsets from now. A fixture built with
 * `Date.now()` renders "2h ago" forever and would hide a formatter that ignores the
 * viewer's zone — the bug §4.7 exists to prevent. These are UTC; the screen converts.
 */
const anaProfile = (): CandidateProfile => ({
  id: CANDIDATE_IDS.ana,
  name: 'Ana Petrova',
  currentTitle: 'Senior SWE',
  currentCompany: 'Meridian',
  location: 'Austin, TX',
  stage: 'onsite',
  stages: ['Applied', 'Screen', 'Onsite', 'Offer', 'Hired'],
  daysInStage: 3,
  nextAction: { text: 'Values round with Maya Reyes is still unconfirmed', href: '/scheduling' },
  tabCounts: { emails: 2, interviews: 4, scorecards: 2, files: 3 },
  activity: [
    {
      id: '0198f3a6-0001-7000-8000-000000000001',
      kind: 'scheduling',
      title: 'Onsite loop scheduled',
      body: '4 interviews on Thu Aug 6, 10:00 to 14:30 CT. Invites pending panel confirmation.',
      at: '2026-08-08T06:30:00.000Z',
    },
    {
      id: '0198f3a6-0002-7000-8000-000000000001',
      kind: 'scorecard',
      title: 'Scorecard submitted: System design',
      body: 'D. Osei rated 3/4. "Strong tradeoff reasoning under changing constraints. Hire."',
      at: '2026-08-07T17:05:00.000Z',
    },
    {
      id: '0198f3a6-0003-7000-8000-000000000001',
      kind: 'stage',
      title: 'Technical screen passed',
      body: 'L. Chen rated 4/4 and advanced her to Onsite.',
      at: '2026-07-24T15:40:00.000Z',
    },
    {
      id: '0198f3a6-0004-7000-8000-000000000001',
      kind: 'email',
      title: 'Email sent: screen confirmation',
      body: '"Technical screen at Talon" opened 3 times, replied in 12 min.',
      at: '2026-07-21T09:12:00.000Z',
    },
    {
      id: '0198f3a6-0005-7000-8000-000000000001',
      kind: 'stage',
      title: 'Application reviewed',
      body: 'Moved Applied to Screen. Resume flagged strong: 8 yrs, infra heavy.',
      at: '2026-07-18T11:20:00.000Z',
    },
  ],
  details: {
    email: 'ana.petrova@gmail.com',
    phone: '+1 415 555 0142',
    source: 'Referral by J. Kim',
    recruiterName: 'Maya Reyes',
    compExpectation: { minCents: '20500000', maxCents: '22000000', currency: 'USD' },
    noticePeriod: '4 weeks',
  },
  job: {
    id: ENG204_JOB_ID,
    title: 'Senior Product Engineer',
    reference: 'ENG-204',
    recruiterName: 'Maya Reyes',
  },
  links: [
    { label: 'Resume', href: '#' },
    { label: 'LinkedIn', href: '#' },
    { label: 'GitHub', href: '#' },
  ],
});

/**
 * Marcus exercises the other half of §10 case 7: comp expectation genuinely absent,
 * for a caller who *does* have the scope. The screen must read "Not stated" here and
 * omit the row entirely for Ana when the scope is missing — two different nulls.
 */
const marcusProfile = (): CandidateProfile => ({
  ...anaProfile(),
  id: CANDIDATE_IDS.marcus,
  name: 'Marcus Webb',
  currentTitle: 'Staff Engineer',
  currentCompany: 'Corvid',
  location: 'Denver, CO',
  stage: 'screen',
  daysInStage: 2,
  nextAction: null, // §10 case 5 — banner absent, not empty.
  tabCounts: { emails: 1, interviews: 0, scorecards: 0, files: 1 },
  activity: [], // §10 case 6 — "No activity yet", no timeline rule.
  details: {
    email: 'marcus.webb@fastmail.com',
    phone: '+1 303 555 0119',
    source: 'Referral by A. Osei',
    recruiterName: 'Maya Reyes',
    compExpectation: null,
    noticePeriod: null,
  },
  links: [],
});

export const candidateProfiles: Record<string, () => CandidateProfile> = {
  [CANDIDATE_IDS.ana]: anaProfile,
  [CANDIDATE_IDS.marcus]: marcusProfile,
};

// ---------------------------------------------------------------------------
// Offers — reference 07
// ---------------------------------------------------------------------------

const sofiaOffer = (): Offer => ({
  id: '0198f3a7-0001-7000-8000-000000000001',
  candidateId: CANDIDATE_IDS.sofia,
  candidateName: 'Sofia Lindqvist',
  level: 'L5 Senior',
  status: 'pending_approval',
  version: 2,
  editedAt: '2026-08-08T05:45:00.000Z',
  startDate: '2026-09-15',
  expiresDate: '2026-08-14',
  comp: {
    baseCents: '21000000',
    currency: 'USD',
    band: { minCents: '19000000', maxCents: '22500000', currency: 'USD' },
    equityUnits: 22000,
    equityYears: 4,
    equityNote: 'band midpoint',
    signOnCents: '1500000',
  },
  approvals: [
    { id: '0198f3a8-0001-7000-8000-000000000001', name: 'Sam Altmann', role: 'Hiring manager', state: 'approved' },
    { id: '0198f3a8-0002-7000-8000-000000000001', name: 'Rina Patel', role: 'VP Engineering', state: 'approved' },
    { id: '0198f3a8-0003-7000-8000-000000000001', name: 'Finance', role: 'Comp review', state: 'pending' },
  ],
  letterBody: [
    'Dear Sofia,',
    'We are delighted to offer you the position of Senior Product Engineer (L5) at Talon, reporting to Sam Altmann. Your annualized base salary will be $210,000, with an equity grant of 22,000 options vesting over four years and a $15,000 sign-on bonus.',
    'Your anticipated start date is September 15, 2026. This offer expires on August 14, 2026.',
    'Warmly,',
    'Maya Reyes · Recruiting, Talon',
  ],
});

export const offersById: Record<string, () => Offer> = {
  '0198f3a7-0001-7000-8000-000000000001': sofiaOffer,
};

/**
 * One offer, matching the reference's nav count of 1.
 *
 * The summary is produced by parsing the full offer through `OfferSummarySchema`, which
 * strips everything the summary does not declare — comp included. Listing the kept
 * fields by hand would work until someone adds a comp field to `OfferSchema` and forgets
 * this call site; letting the narrower schema do it means the omission is structural.
 */
export const offers = (): ListOffersResponse => ({
  items: Object.values(offersById).map((build) => OfferSummarySchema.parse(build())),
});

// ---------------------------------------------------------------------------
// Reports — reference 08
// ---------------------------------------------------------------------------

export const reportsOverview = (): ReportsOverview => ({
  period: 'Last 30 days · all departments',
  tiles: [
    { key: 'time_to_hire', label: 'Time to hire', value: '24d', delta: '3d faster than last month', direction: 'up' },
    { key: 'offer_accept_rate', label: 'Offer accept rate', value: '86%', delta: 'up 4 points', direction: 'up' },
    { key: 'active_candidates', label: 'Active candidates', value: '9', delta: 'up 12', direction: 'up' },
    { key: 'interviews_this_week', label: 'Interviews this week', value: '22', delta: 'up 6', direction: 'up' },
  ],
  conversion: [
    { stage: 'applied', label: 'Applied', count: 412 },
    { stage: 'screen', label: 'Screen', count: 96 },
    { stage: 'onsite', label: 'Onsite', count: 31 },
    { stage: 'offer', label: 'Offer', count: 12 },
    { stage: 'hired', label: 'Hired', count: 9 },
  ],
  sources: [
    { key: 'referral', label: 'Referrals', hires: 4 },
    { key: 'outbound', label: 'Outbound', hires: 2 },
    { key: 'careers_page', label: 'Careers page', hires: 2 },
    { key: 'agency', label: 'Agencies', hires: 1 },
  ],
  interviewsPerWeek: [
    { label: 'W1', count: 12 },
    { label: 'W2', count: 18 },
    { label: 'W3', count: 14 },
    { label: 'W4', count: 22 },
    { label: 'W5', count: 19 },
    { label: 'W6', count: 26 },
    { label: 'W7', count: 22 },
    { label: 'W8', count: 28 },
  ],
});
