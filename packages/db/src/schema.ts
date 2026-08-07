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
  integer,
  jsonb,
  pgTable,
  text,
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
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const users = pgTable('users', {
  id: id(),
  tenantId: tenantId(),
  email: citext('email').notNull(),
  name: text('name').notNull(),
  avatarColor: text('avatar_color'),
  role: text('role', { enum: ['admin', 'recruiter', 'hiring_manager', 'member'] }).notNull(),
  timezone: text('timezone').notNull().default('UTC'),
  mfaEnabled: boolean('mfa_enabled').notNull().default(false),
  // Tokens with iat before this are rejected by the auth chain; null = all valid.
  tokensValidAfter: timestamp('tokens_valid_after', { withTimezone: true }),
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
