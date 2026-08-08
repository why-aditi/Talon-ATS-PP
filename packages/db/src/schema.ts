// Typed mirror of migrations/0001_init.up.sql for query building. The SQL migration
// is the source of truth for DDL — checks, indexes, RLS, and grants live there.
// ponytail: search_vector (db-generated tsvector) is deliberately omitted here;
// nothing in app code writes or reads it directly.
import {
  bigint,
  bigserial,
  boolean,
  char,
  customType,
  date,
  integer,
  jsonb,
  pgTable,
  text,
  time,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';
import { uuidv7 } from 'uuidv7';

const citext = customType<{ data: string }>({
  dataType() {
    return 'citext';
  },
});

const id = () => uuid('id').primaryKey().$defaultFn(() => uuidv7());
const tenantId = () => uuid('tenant_id').notNull();
const createdAt = () => timestamp('created_at', { withTimezone: true }).notNull().defaultNow();
// updated_at is maintained by a DB trigger, never by app code (spec 001 §5.2).
const updatedAt = () => timestamp('updated_at', { withTimezone: true }).notNull().defaultNow();

export const tenants = pgTable('tenants', {
  id: id(),
  name: text('name').notNull(),
  slug: citext('slug').notNull(),
  ssoEnforcedRoles: text('sso_enforced_roles').array().notNull().default([]),
  retentionDays: integer('retention_days').notNull().default(730),
  /** Wall clock in the interview loop's timezone, not a fixed zone (migration 0009). */
  businessHoursStart: time('business_hours_start').notNull().default('09:00'),
  businessHoursEnd: time('business_hours_end').notNull().default('17:00'),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const users = pgTable('users', {
  id: id(),
  tenantId: tenantId(),
  email: citext('email').notNull(),
  name: text('name').notNull(),
  role: text('role', { enum: ['admin', 'recruiter', 'hiring_manager', 'member'] }).notNull(),
  timezone: text('timezone').notNull().default('UTC'),
  mfaEnabled: boolean('mfa_enabled').notNull().default(false),
  // Tokens with iat before this are rejected by the auth chain; null = all valid.
  tokensValidAfter: timestamp('tokens_valid_after', { withTimezone: true }),
  // Identity provider subject (migration 0004): Cognito's `sub`, a SAML NameID.
  // Null for local-provider users, whose token subject IS users.id — that is the
  // branch auth_user_by_sub() takes when this is null. Globally unique (the IdP
  // subject space is not tenant-scoped) and case-sensitive text, not citext; the
  // migration carries the reasoning.
  externalId: text('external_id'),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

// The local IdentityProvider's credential store (migration 0003) — the stand-in
// for Cognito, so deliberately outside the tenant model: no tenant_id, no RLS
// policy, looked up by email before a tenant is known (spec 001 §11b).
export const localIdentities = pgTable('local_identities', {
  // Locally the token subject IS users.id; Cognito owns this value in AWS.
  sub: uuid('sub').primaryKey(),
  email: citext('email').notNull(),
  /** scrypt, `scrypt$N=…,r=…,p=…$<salt b64>$<hash b64>`. Never plaintext. */
  passwordHash: text('password_hash').notNull(),
  totpSecret: text('totp_secret'),
  totpEnrolledAt: timestamp('totp_enrolled_at', { withTimezone: true }),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const stageTemplates = pgTable('stage_templates', {
  id: id(),
  tenantId: tenantId(),
  name: text('name').notNull(),
  // Ordered [{ name, canonical, sla_days, is_terminal }] copied into job_stages at job creation.
  stages: jsonb('stages').notNull().default([]),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const jobs = pgTable('jobs', {
  id: id(),
  tenantId: tenantId(),
  reqCode: text('req_code').notNull(),
  title: text('title').notNull(),
  department: text('department').notNull(),
  location: text('location').notNull(),
  employmentType: text('employment_type'),
  // mode: 'bigint' — money never round-trips through a JS number, so the 2^53
  // precision class simply does not exist on these columns (CLAUDE.md §4.9).
  bandMinCents: bigint('band_min_cents', { mode: 'bigint' }),
  bandMaxCents: bigint('band_max_cents', { mode: 'bigint' }),
  // No .default('USD') — "never an assumed USD". Callers state the currency.
  currency: char('currency', { length: 3 }).notNull(),
  status: text('status', { enum: ['draft', 'active', 'on_hold', 'closing', 'closed'] }).notNull(),
  recruiterId: uuid('recruiter_id'),
  hiringManagerId: uuid('hiring_manager_id'),
  openings: integer('openings').notNull().default(1),
  stageTemplateId: uuid('stage_template_id').notNull(),
  /** Optimistic concurrency for PATCH /v1/jobs/:id — migration 0008. */
  version: integer('version').notNull().default(1),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const jobStages = pgTable('job_stages', {
  id: id(),
  tenantId: tenantId(),
  jobId: uuid('job_id').notNull(),
  name: text('name').notNull(),
  position: integer('position').notNull(),
  canonical: text('canonical', {
    enum: ['applied', 'screen', 'onsite', 'offer', 'hired', 'rejected', 'withdrawn'],
  }).notNull(),
  slaDays: integer('sla_days'),
  isTerminal: boolean('is_terminal').notNull().default(false),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const candidates = pgTable('candidates', {
  id: id(),
  tenantId: tenantId(),
  name: text('name').notNull(),
  email: citext('email'),
  phone: text('phone'),
  location: text('location'),
  currentTitle: text('current_title'),
  currentCompany: text('current_company'),
  links: jsonb('links').notNull().default({}),
  anonymizedAt: timestamp('anonymized_at', { withTimezone: true }),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const applications = pgTable('applications', {
  id: id(),
  tenantId: tenantId(),
  candidateId: uuid('candidate_id').notNull(),
  jobId: uuid('job_id').notNull(),
  currentStageId: uuid('current_stage_id').notNull(),
  // Denormalized from stage_transitions in the same transaction; drives "3d in stage".
  stageEnteredAt: timestamp('stage_entered_at', { withTimezone: true }).notNull(),
  boardRank: text('board_rank').notNull(),
  source: text('source').notNull(),
  referredById: uuid('referred_by_id'),
  status: text('status', { enum: ['active', 'hired', 'rejected', 'withdrawn'] })
    .notNull()
    .default('active'),
  rejectionReason: text('rejection_reason'),
  compExpectationMinCents: bigint('comp_expectation_min_cents', { mode: 'bigint' }),
  compExpectationMaxCents: bigint('comp_expectation_max_cents', { mode: 'bigint' }),
  // Cents are meaningless without it. DB check: either cents column non-null
  // forces this non-null (applications_comp_expectation_currency_ck).
  compExpectationCurrency: char('comp_expectation_currency', { length: 3 }),
  noticePeriodDays: integer('notice_period_days'),
  version: integer('version').notNull().default(1),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

// APPEND ONLY — no update/delete grant exists for the app role.
export const stageTransitions = pgTable('stage_transitions', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  tenantId: tenantId(),
  applicationId: uuid('application_id').notNull(),
  fromStageId: uuid('from_stage_id'),
  toStageId: uuid('to_stage_id').notNull(),
  actorId: uuid('actor_id'),
  reason: text('reason'),
  occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull().defaultNow(),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const activities = pgTable('activities', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  tenantId: tenantId(),
  applicationId: uuid('application_id').notNull(),
  type: text('type').notNull(),
  actorId: uuid('actor_id'),
  body: text('body'),
  meta: jsonb('meta').notNull().default({}),
  occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull().defaultNow(),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

/**
 * Scheduling (migration 0009, spec 004 §5).
 *
 * The distinction that carries the whole subsystem: `interviewRounds` is the TEMPLATE
 * ("this loop needs a 60m coding round with Maya"), `interviews` is the INSTANCE (that
 * round, given a time). A round with no `interviews` row is unscheduled.
 */
export const interviewLoops = pgTable('interview_loops', {
  id: id(),
  tenantId: tenantId(),
  applicationId: uuid('application_id').notNull(),
  status: text('status', {
    enum: ['draft', 'proposed', 'held', 'confirmed', 'completed', 'cancelled'],
  }).notNull(),
  targetDate: date('target_date'),
  /** The ORGANIZER's IANA zone — the conversion target for rendering, not a second truth. */
  timezone: text('timezone').notNull(),
  /** Candidate availability, stored in the CANDIDATE's zone (spec 004 §6). All three
   *  columns are set together or none is; the DB check enforces it. */
  candidateTimezone: text('candidate_timezone'),
  candidateWindowStart: time('candidate_window_start'),
  candidateWindowEnd: time('candidate_window_end'),
  /** The 24h soft reservation (spec 004 §9). Postgres is the source of truth. */
  heldBy: uuid('held_by'),
  holdExpiresAt: timestamp('hold_expires_at', { withTimezone: true }),
  version: integer('version').notNull().default(1),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const interviewRounds = pgTable('interview_rounds', {
  id: id(),
  tenantId: tenantId(),
  loopId: uuid('loop_id').notNull(),
  kind: text('kind', { enum: ['coding', 'system_design', 'values', 'hiring_manager'] }).notNull(),
  /** Multiple of 15 — the solver's bitmap granularity (spec 004 §7). DB-checked. */
  durationMin: integer('duration_min').notNull(),
  position: integer('position').notNull(),
  /** Reserved. The M2 solver places rounds in `position` order and ignores this. */
  isSwappable: boolean('is_swappable').notNull().default(false),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const interviewRoundPanelists = pgTable('interview_round_panelists', {
  tenantId: tenantId(),
  roundId: uuid('round_id').notNull(),
  userId: uuid('user_id').notNull(),
  /** Required panelists are a hard solver constraint; optional ones never block a slot. */
  isRequired: boolean('is_required').notNull().default(true),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const interviews = pgTable('interviews', {
  id: id(),
  tenantId: tenantId(),
  applicationId: uuid('application_id').notNull(),
  loopId: uuid('loop_id').notNull(),
  /** Not null and unique: one interview per round, so a re-solve updates in place. */
  roundId: uuid('round_id').notNull(),
  kind: text('kind', { enum: ['coding', 'system_design', 'values', 'hiring_manager'] }).notNull(),
  durationMin: integer('duration_min').notNull(),
  scheduledStart: timestamp('scheduled_start', { withTimezone: true }),
  scheduledEnd: timestamp('scheduled_end', { withTimezone: true }),
  status: text('status', {
    enum: ['unscheduled', 'pending', 'confirmed', 'declined', 'completed', 'cancelled'],
  }).notNull(),
  externalEventId: text('external_event_id'),
  externalProvider: text('external_provider'),
  /** Manual placement over a hard constraint, taken after an explicit confirm (spec 004
   *  §7a). `acknowledgedBlocker` holds the solver blocker the recruiter was shown — a
   *  DB check keeps it null unless `manualOverride` is true. */
  manualOverride: boolean('manual_override').notNull().default(false),
  acknowledgedBlocker: jsonb('acknowledged_blocker'),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const interviewPanelists = pgTable('interview_panelists', {
  tenantId: tenantId(),
  interviewId: uuid('interview_id').notNull(),
  userId: uuid('user_id').notNull(),
  /** Never read back from the calendar server: Radicale has no iTIP, so a panelist marks
   *  accepted or declined in Talon and this is the only record (spec 004 §10). */
  response: text('response', { enum: ['pending', 'accepted', 'declined'] })
    .notNull()
    .default('pending'),
  isRequired: boolean('is_required').notNull().default(true),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

/**
 * Transactional outbox (ARCHITECTURE §6.1). Written in the same transaction as the
 * state change it describes; the relay publishes and stamps `published_at`.
 *
 * APPEND ONLY for the app role — `talon_app` is granted select and insert, nothing
 * else. `id` is a bigserial rather than a uuid on purpose: delivery is at-least-once
 * and consumers are idempotent keyed on it (non-negotiable #19), so it has to order as
 * well as identify.
 */
export const outbox = pgTable('outbox', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  tenantId: tenantId(),
  aggregate: text('aggregate').notNull(),
  aggregateId: uuid('aggregate_id').notNull(),
  eventType: text('event_type').notNull(),
  /** Ids and versions only — never entity state, so a stale broadcast cannot write bad
   *  data into a client cache. */
  payload: jsonb('payload').notNull(),
  occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull().defaultNow(),
  publishedAt: timestamp('published_at', { withTimezone: true }),
  attempts: integer('attempts').notNull().default(0),
  lastError: text('last_error'),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

// APPEND ONLY — tenant_id nullable (system-level events, owner-only under RLS).
export const auditLog = pgTable('audit_log', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  tenantId: uuid('tenant_id'),
  actorId: uuid('actor_id'),
  action: text('action').notNull(),
  entityType: text('entity_type').notNull(),
  entityId: uuid('entity_id'),
  before: jsonb('before'),
  after: jsonb('after'),
  ip: text('ip'),
  requestId: text('request_id'),
  occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull().defaultNow(),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});
