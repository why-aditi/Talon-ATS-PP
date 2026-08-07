// Seed reproducing the reference screens (spec 001 §5.4). Writes HISTORY, not state:
// every application gets backdated stage_transitions so derived metrics match the
// screenshots — Ana Petrova "3d in Onsite", Elena Ruiz "Stalled 8d in stage" (screen
// SLA 5d), Screen "42% pass" (16 of 38 ENG-204 applications ever reached Screen) and
// "median 4d" (median Screen dwell across all completed Screen exits).
//
// Known contradiction in the reference material, resolved toward the kanban screen:
// the jobs list shows ENG-204 "18 in process" but the pipeline screen pictures exactly
// 9 candidates (8 non-terminal). The funnel percentages (100/42/21/8 = 38/16/8/3 over
// 38 applications) confirm 38 total, so ENG-204 seeds 38 applications of which the
// 29 non-pictured are terminal. See the step-3 PR description.
import { pathToFileURL } from 'node:url';
import { uuidv7 } from 'uuidv7';
import { createDb } from './index.js';
import { DEFAULT_DATABASE_URL } from './migrate.js';
import * as s from './schema.js';

const H = 3_600_000;
const DAY = 24 * H;
const NOW = Date.now();
/** `days` days and `hours` hours before seed time. All arithmetic in UTC ms (DST-safe). */
const ago = (days: number, hours = 0) => new Date(NOW - days * DAY - hours * H);
const minus = (d: Date, days: number) => new Date(d.getTime() - days * DAY);

type Canonical = 'applied' | 'screen' | 'onsite' | 'offer' | 'hired' | 'rejected' | 'withdrawn';

const TEMPLATE_STAGES: { name: string; canonical: Canonical; sla_days: number | null; is_terminal: boolean }[] = [
  { name: 'Applied', canonical: 'applied', sla_days: null, is_terminal: false },
  { name: 'Screen', canonical: 'screen', sla_days: 5, is_terminal: false },
  { name: 'Onsite', canonical: 'onsite', sla_days: 5, is_terminal: false },
  { name: 'Offer', canonical: 'offer', sla_days: 5, is_terminal: false },
  { name: 'Hired', canonical: 'hired', sla_days: null, is_terminal: true },
  { name: 'Rejected', canonical: 'rejected', sla_days: null, is_terminal: true },
  { name: 'Withdrawn', canonical: 'withdrawn', sla_days: null, is_terminal: true },
];

export async function seed(databaseUrl = process.env['DATABASE_URL'] ?? DEFAULT_DATABASE_URL): Promise<void> {
  const { db, client } = createDb(databaseUrl, { max: 1 });

  // Row buffers, inserted in FK order at the end.
  const tenantRows: (typeof s.tenants.$inferInsert)[] = [];
  const userRows: (typeof s.users.$inferInsert)[] = [];
  const templateRows: (typeof s.stageTemplates.$inferInsert)[] = [];
  const jobRows: (typeof s.jobs.$inferInsert)[] = [];
  const jobStageRows: (typeof s.jobStages.$inferInsert)[] = [];
  const candidateRows: (typeof s.candidates.$inferInsert)[] = [];
  const applicationRows: (typeof s.applications.$inferInsert)[] = [];
  const transitionRows: (typeof s.stageTransitions.$inferInsert)[] = [];
  const activityRows: (typeof s.activities.$inferInsert)[] = [];
  const auditRows: (typeof s.auditLog.$inferInsert)[] = [];

  const rankCounters = new Map<string, number>();
  const nextRank = (stageId: string) => {
    const n = (rankCounters.get(stageId) ?? 0) + 1;
    rankCounters.set(stageId, n);
    // ponytail: lexorank-shaped, evenly spaced strings; the real rebalancer is M1.
    return `a${String(n).padStart(3, '0')}`;
  };

  function addJob(opts: {
    tenantId: string;
    templateId: string;
    reqCode: string;
    title: string;
    department: string;
    location: string;
    status: 'draft' | 'active' | 'on_hold' | 'closing' | 'closed';
    recruiterId: string;
    hiringManagerId?: string;
    bandMinCents?: number;
    bandMaxCents?: number;
  }) {
    const jobId = uuidv7();
    jobRows.push({
      id: jobId,
      tenantId: opts.tenantId,
      reqCode: opts.reqCode,
      title: opts.title,
      department: opts.department,
      location: opts.location,
      status: opts.status,
      recruiterId: opts.recruiterId,
      hiringManagerId: opts.hiringManagerId ?? null,
      bandMinCents: opts.bandMinCents ?? null,
      bandMaxCents: opts.bandMaxCents ?? null,
      stageTemplateId: opts.templateId,
      createdAt: ago(90),
    });
    const stages = {} as Record<Canonical, string>;
    TEMPLATE_STAGES.forEach((st, i) => {
      const id = uuidv7();
      stages[st.canonical] = id;
      jobStageRows.push({
        id,
        tenantId: opts.tenantId,
        jobId,
        name: st.name,
        position: i + 1,
        canonical: st.canonical,
        slaDays: st.sla_days,
        isTerminal: st.is_terminal,
        createdAt: ago(90),
      });
    });
    return { jobId, stages };
  }

  function addApplication(opts: {
    tenantId: string;
    job: { jobId: string; stages: Record<Canonical, string> };
    candidate: { name: string; title?: string; company?: string };
    /** Chronological stage path; first entry is the application's creation. */
    path: { c: Canonical; at: Date }[];
    source: string;
    referredById?: string;
    actorId?: string;
    rejectionReason?: string;
    withActivities?: boolean;
  }) {
    const candidateId = uuidv7();
    const first = opts.path[0];
    const last = opts.path[opts.path.length - 1];
    if (!first || !last) throw new Error('path must be non-empty');
    candidateRows.push({
      id: candidateId,
      tenantId: opts.tenantId,
      name: opts.candidate.name,
      currentTitle: opts.candidate.title ?? null,
      currentCompany: opts.candidate.company ?? null,
      email: `${opts.candidate.name.toLowerCase().replace(/[^a-z]+/g, '.')}@example.com`,
      createdAt: first.at,
    });
    const applicationId = uuidv7();
    const status =
      last.c === 'hired' ? 'hired' : last.c === 'rejected' ? 'rejected' : last.c === 'withdrawn' ? 'withdrawn' : 'active';
    applicationRows.push({
      id: applicationId,
      tenantId: opts.tenantId,
      candidateId,
      jobId: opts.job.jobId,
      currentStageId: opts.job.stages[last.c],
      stageEnteredAt: last.at,
      boardRank: nextRank(opts.job.stages[last.c]),
      source: opts.source,
      referredById: opts.referredById ?? null,
      status,
      rejectionReason: opts.rejectionReason ?? (status === 'rejected' ? 'not_a_fit' : null),
      createdAt: first.at,
    });
    opts.path.forEach((step, i) => {
      const prev = opts.path[i - 1];
      transitionRows.push({
        tenantId: opts.tenantId,
        applicationId,
        fromStageId: prev ? opts.job.stages[prev.c] : null,
        toStageId: opts.job.stages[step.c],
        actorId: i === 0 ? null : (opts.actorId ?? null), // creation is a system write
        occurredAt: step.at,
        createdAt: step.at,
      });
      if (opts.withActivities) {
        activityRows.push({
          tenantId: opts.tenantId,
          applicationId,
          type: 'stage_change',
          actorId: i === 0 ? null : (opts.actorId ?? null),
          body: i === 0 ? 'Application created' : `Moved to ${step.c}`,
          meta: { from: prev?.c ?? null, to: step.c },
          occurredAt: step.at,
          createdAt: step.at,
        });
      }
    });
    return applicationId;
  }

  // ── Tenant A: Talon Inc. ──────────────────────────────────────────────────
  const talon = uuidv7();
  tenantRows.push({ id: talon, name: 'Talon Inc.', slug: 'talon', createdAt: ago(365) });

  const maya = uuidv7();
  const sam = uuidv7();
  const lin = uuidv7();
  const davidO = uuidv7();
  const tom = uuidv7();
  userRows.push(
    { id: maya, tenantId: talon, email: 'maya@taloninc.com', name: 'Maya Reyes', role: 'recruiter', avatarColor: '#6E56CF', timezone: 'America/Los_Angeles' },
    { id: sam, tenantId: talon, email: 'sam@taloninc.com', name: 'Sam Altmann', role: 'hiring_manager', avatarColor: '#8B5CF6', timezone: 'Europe/London' },
    { id: lin, tenantId: talon, email: 'lin@taloninc.com', name: 'Lin Chen', role: 'member', avatarColor: '#0E9F6E', timezone: 'America/New_York' },
    { id: davidO, tenantId: talon, email: 'david@taloninc.com', name: 'David Osei', role: 'member', avatarColor: '#D97706', timezone: 'America/New_York' },
    { id: tom, tenantId: talon, email: 'tom@taloninc.com', name: 'Tom Iwu', role: 'recruiter', avatarColor: '#B45309', timezone: 'America/Los_Angeles' },
  );

  const talonTemplate = uuidv7();
  templateRows.push({ id: talonTemplate, tenantId: talon, name: 'Default pipeline', stages: TEMPLATE_STAGES, createdAt: ago(365) });

  const eng204 = addJob({ tenantId: talon, templateId: talonTemplate, reqCode: 'ENG-204', title: 'Senior Product Engineer', department: 'Engineering', location: 'Remote (US)', status: 'active', recruiterId: maya, hiringManagerId: sam, bandMinCents: 190_000_00, bandMaxCents: 225_000_00 });
  const eng209 = addJob({ tenantId: talon, templateId: talonTemplate, reqCode: 'ENG-209', title: 'Staff Design Engineer', department: 'Engineering', location: 'SF / Hybrid', status: 'active', recruiterId: tom });
  const eng198 = addJob({ tenantId: talon, templateId: talonTemplate, reqCode: 'ENG-198', title: 'Engineering Manager, Infra', department: 'Engineering', location: 'New York', status: 'on_hold', recruiterId: maya });
  const des114 = addJob({ tenantId: talon, templateId: talonTemplate, reqCode: 'DES-114', title: 'Product Designer, Growth', department: 'Design', location: 'Remote (EU)', status: 'active', recruiterId: tom });
  const ppl031 = addJob({ tenantId: talon, templateId: talonTemplate, reqCode: 'PPL-031', title: 'Recruiting Coordinator', department: 'People', location: 'Remote (US)', status: 'active', recruiterId: maya });
  const sal076 = addJob({ tenantId: talon, templateId: talonTemplate, reqCode: 'SAL-076', title: 'Head of Sales, EMEA', department: 'Sales', location: 'London', status: 'closing', recruiterId: sam, hiringManagerId: sam });

  // ── ENG-204: the nine pictured candidates ─────────────────────────────────
  // The +6h anchor keeps floor(days-in-stage) stable for most of a day after seeding.
  const named = { tenantId: talon, job: eng204, actorId: maya, withActivities: true };
  addApplication({ ...named, candidate: { name: 'Tess Bianchi', title: 'Frontend Engineer', company: 'Halo' }, source: 'agency', path: [{ c: 'applied', at: ago(4, 6) }] });
  addApplication({ ...named, candidate: { name: 'Omar Haddad', title: 'Platform Engineer', company: 'Trellis' }, source: 'careers_page', path: [{ c: 'applied', at: ago(3, 6) }] });
  addApplication({ ...named, candidate: { name: 'Jordan Cole', title: 'Fullstack', company: 'Beacon' }, source: 'careers_page', path: [{ c: 'applied', at: ago(2, 6) }] });
  addApplication({ ...named, candidate: { name: 'Priya Nair', title: 'SWE II', company: 'Loft' }, source: 'referral', referredById: lin, path: [{ c: 'applied', at: ago(1, 6) }] });
  // Elena: 8d in Screen (> SLA 5) → "Stalled 8d in stage"
  addApplication({ ...named, candidate: { name: 'Elena Ruiz', title: 'Backend Engineer', company: 'Cove' }, source: 'outbound', path: [{ c: 'applied', at: ago(10, 6) }, { c: 'screen', at: ago(8, 6) }] });
  addApplication({ ...named, candidate: { name: 'Marcus Webb', title: 'SWE', company: 'Northwind' }, source: 'outbound', path: [{ c: 'applied', at: ago(7, 6) }, { c: 'screen', at: ago(5, 6) }] });
  // Ana: entered Onsite 3d ago → "3d in stage"; Screen dwell exactly 4d
  addApplication({ ...named, candidate: { name: 'Ana Petrova', title: 'Senior SWE', company: 'Meridian' }, source: 'referral', referredById: davidO, path: [{ c: 'applied', at: ago(9, 6) }, { c: 'screen', at: ago(7, 6) }, { c: 'onsite', at: ago(3, 6) }] });
  addApplication({ ...named, candidate: { name: 'Sofia Lindqvist', title: 'Staff Eng', company: 'Polar' }, source: 'outbound', path: [{ c: 'applied', at: ago(12, 6) }, { c: 'screen', at: ago(10, 6) }, { c: 'onsite', at: ago(6, 6) }, { c: 'offer', at: ago(1, 6) }] });
  addApplication({ ...named, candidate: { name: 'David Kim', title: 'Sr SWE', company: 'Argo' }, source: 'referral', referredById: lin, path: [{ c: 'applied', at: ago(14, 6) }, { c: 'screen', at: ago(12, 6) }, { c: 'onsite', at: ago(8, 6) }, { c: 'offer', at: ago(2, 6) }, { c: 'hired', at: ago(0, 6) }] });

  // ── ENG-204: 29 historical (terminal) applications completing the funnel ──
  // Ever-reached counts incl. the nine above: applied 38, screen 16, onsite 8,
  // offer 3, hired 1 → 42% / 21% / 8% pass. Screen dwell median across all 14
  // completed Screen exits (11 fillers + Ana/Sofia/David at 4d) = exactly 4d.
  const sources = ['careers_page', 'outbound', 'referral', 'agency', 'import'];
  const src = (i: number) => sources[i % sources.length] as string;
  for (let i = 0; i < 18; i++) {
    const rejectedAt = ago(23 + i, i % 12);
    addApplication({ tenantId: talon, job: eng204, actorId: maya, candidate: { name: `Alex Morgan ${i + 1}` }, source: src(i), path: [{ c: 'applied', at: minus(rejectedAt, 2) }, { c: 'rejected', at: rejectedAt }] });
  }
  const screenRejectDwell = [2, 2, 3, 3, 3, 4];
  screenRejectDwell.forEach((dwell, i) => {
    const rejectedAt = ago(18 + i, 3);
    const screenAt = minus(rejectedAt, dwell);
    addApplication({ tenantId: talon, job: eng204, actorId: maya, candidate: { name: `Riley Chen ${i + 1}` }, source: src(i), path: [{ c: 'applied', at: minus(screenAt, 2) }, { c: 'screen', at: screenAt }, { c: 'rejected', at: rejectedAt }] });
  });
  const onsiteScreenDwell = [5, 5, 5, 6, 6];
  onsiteScreenDwell.forEach((dwell, i) => {
    const last = i === 4; // the one that reached Offer before being declined
    const end = ago(15 + i, 9);
    const offerAt = last ? minus(end, 3) : null;
    const onsiteAt = minus(offerAt ?? end, 6);
    const screenAt = minus(onsiteAt, dwell);
    const path: { c: Canonical; at: Date }[] = [
      { c: 'applied', at: minus(screenAt, 2) },
      { c: 'screen', at: screenAt },
      { c: 'onsite', at: onsiteAt },
    ];
    if (offerAt) path.push({ c: 'offer', at: offerAt });
    path.push({ c: 'rejected', at: end });
    addApplication({ tenantId: talon, job: eng204, actorId: maya, candidate: { name: `Sasha Ito ${i + 1}` }, source: src(i), rejectionReason: last ? 'declined_offer' : 'not_a_fit', path });
  });

  // ── Other jobs: bulk history matching the jobs-list counts ────────────────
  // "N active" = total applications (the 38-denominator reading confirmed by the
  // funnel percentages); "M in process" = currently non-terminal.
  const bulk: { job: typeof eng204; req: string; total: number; inProcess: number }[] = [
    { job: eng209, req: 'ENG-209', total: 21, inProcess: 8 },
    { job: eng198, req: 'ENG-198', total: 12, inProcess: 3 },
    { job: des114, req: 'DES-114', total: 54, inProcess: 20 },
    { job: ppl031, req: 'PPL-031', total: 67, inProcess: 19 },
    { job: sal076, req: 'SAL-076', total: 9, inProcess: 6 },
  ];
  const inProcessCycle: Canonical[] = ['applied', 'applied', 'screen', 'screen', 'onsite'];
  for (const { job, req, total, inProcess } of bulk) {
    for (let i = 0; i < inProcess; i++) {
      const target = inProcessCycle[i % inProcessCycle.length] as Canonical;
      const appliedAt = ago(18 + (i % 10), i % 12);
      const path: { c: Canonical; at: Date }[] = [{ c: 'applied', at: appliedAt }];
      if (target !== 'applied') path.push({ c: 'screen', at: minus(appliedAt, -2) });
      if (target === 'onsite') path.push({ c: 'onsite', at: minus(appliedAt, -6) });
      addApplication({ tenantId: talon, job, candidate: { name: `${req} Candidate ${i + 1}` }, source: src(i), path });
    }
    for (let i = 0; i < total - inProcess; i++) {
      const rejectedAt = ago(25 + (i % 30), i % 12);
      addApplication({ tenantId: talon, job, candidate: { name: `${req} Past Candidate ${i + 1}` }, source: src(i), path: [{ c: 'applied', at: minus(rejectedAt, 2) }, { c: 'rejected', at: rejectedAt }] });
    }
  }

  auditRows.push({ tenantId: talon, action: 'seed.completed', entityType: 'tenant', entityId: talon, after: { jobs: 6, users: 5 }, requestId: 'seed' });

  // ── Tenant B: Acme Corp (isolation-test target) ───────────────────────────
  const acme = uuidv7();
  tenantRows.push({ id: acme, name: 'Acme Corp', slug: 'acme', createdAt: ago(200) });
  const beth = uuidv7();
  userRows.push({ id: beth, tenantId: acme, email: 'beth@acme.test', name: 'Beth Okafor', role: 'admin', timezone: 'UTC' });
  const acmeTemplate = uuidv7();
  templateRows.push({ id: acmeTemplate, tenantId: acme, name: 'Default pipeline', stages: TEMPLATE_STAGES, createdAt: ago(200) });
  const acm001 = addJob({ tenantId: acme, templateId: acmeTemplate, reqCode: 'ACM-001', title: 'Platform Engineer', department: 'Engineering', location: 'Berlin', status: 'active', recruiterId: beth });
  const acmeCommon = { tenantId: acme, job: acm001, actorId: beth, withActivities: true };
  addApplication({ ...acmeCommon, candidate: { name: 'Noor Haddad', title: 'SRE', company: 'Initech' }, source: 'careers_page', path: [{ c: 'applied', at: ago(5, 3) }] });
  addApplication({ ...acmeCommon, candidate: { name: 'Petra Kovacs', title: 'Backend Engineer', company: 'Globex' }, source: 'outbound', path: [{ c: 'applied', at: ago(9, 3) }, { c: 'screen', at: ago(4, 3) }] });
  addApplication({ ...acmeCommon, candidate: { name: 'Milo Andersen', title: 'Platform Engineer', company: 'Umbrella' }, source: 'referral', referredById: beth, path: [{ c: 'applied', at: ago(20, 3) }, { c: 'rejected', at: ago(15, 3) }] });
  auditRows.push({ tenantId: acme, action: 'seed.completed', entityType: 'tenant', entityId: acme, after: { jobs: 1, users: 1 }, requestId: 'seed' });

  // ── Write everything (seed runs as the owner/migration role, which is not
  // subject to app-role grants; re-running the seed resets all data) ─────────
  try {
    await client.unsafe(`truncate table audit_log, activities, stage_transitions, applications,
      candidates, job_stages, jobs, stage_templates, users, tenants restart identity cascade`);
    const chunked = async <T extends object>(table: Parameters<typeof db.insert>[0], rows: T[]) => {
      for (let i = 0; i < rows.length; i += 300) {
        await db.insert(table).values(rows.slice(i, i + 300) as never);
      }
    };
    await chunked(s.tenants, tenantRows);
    await chunked(s.users, userRows);
    await chunked(s.stageTemplates, templateRows);
    await chunked(s.jobs, jobRows);
    await chunked(s.jobStages, jobStageRows);
    await chunked(s.candidates, candidateRows);
    await chunked(s.applications, applicationRows);
    // Chronological insert order so bigserial ids are time-ordered like production writes.
    transitionRows.sort((a, b) => (a.occurredAt as Date).getTime() - (b.occurredAt as Date).getTime());
    activityRows.sort((a, b) => (a.occurredAt as Date).getTime() - (b.occurredAt as Date).getTime());
    await chunked(s.stageTransitions, transitionRows);
    await chunked(s.activities, activityRows);
    await chunked(s.auditLog, auditRows);
    console.log(
      `seeded: ${tenantRows.length} tenants, ${userRows.length} users, ${jobRows.length} jobs, ` +
        `${applicationRows.length} applications, ${transitionRows.length} transitions`,
    );
  } finally {
    await client.end();
  }
}

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  seed().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}
