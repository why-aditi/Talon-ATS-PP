-- 0001_init — M0a table set (spec 001 §5.1): tenants, users, stage_templates, jobs,
-- job_stages, candidates, applications, stage_transitions, activities, audit_log.
-- Runs as the migration role (owner). The app connects as talon_app, which cannot bypass RLS.
--
-- PREREQUISITE: the talon_app role must exist before this file runs. It is created by
-- ensureAppRole() in src/migrate.ts, NOT here — a role password written into a migration
-- replays verbatim into every environment the migration is ever pointed at.

-- Idempotent here as a belt-and-braces: the docker init script already enables these,
-- but test setup recreates schema public from scratch.
create extension if not exists citext;
create extension if not exists pg_trgm;

grant usage on schema public to talon_app;

create function set_updated_at() returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end $$;

-- ── tenants ────────────────────────────────────────────────────────────────
create table tenants (
  id uuid primary key,
  name text not null,
  slug citext unique not null,
  sso_enforced_roles text[] not null default '{}',
  retention_days int not null default 730,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- ── users ──────────────────────────────────────────────────────────────────
create table users (
  id uuid primary key,
  tenant_id uuid not null references tenants (id),
  -- Globally unique, not (tenant_id, email): spec 001 open question 1 answered
  -- 2026-08-07 — one tenant per email. citext makes it case-insensitive.
  email citext not null unique,
  name text not null,
  avatar_color text,
  role text not null check (role in ('admin', 'recruiter', 'hiring_manager', 'member')),
  timezone text not null default 'UTC',
  mfa_enabled boolean not null default false,
  -- Tokens with iat before this are rejected by the auth chain (step 4).
  -- Null = all tokens valid.
  tokens_valid_after timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- Referenceable by composite FK so a child row cannot point at another tenant's user.
  unique (tenant_id, id)
);
create index users_tenant_email_idx on users (tenant_id, email);

-- ── stage_templates ────────────────────────────────────────────────────────
-- DDL not specified in ARCHITECTURE §5 (gap, flagged in the PR). Minimal shape:
-- stages is an ordered jsonb array [{name, canonical, sla_days, is_terminal}]
-- copied into job_stages at job creation (per-job copies, spec 001 §9.5).
create table stage_templates (
  id uuid primary key,
  tenant_id uuid not null references tenants (id),
  name text not null,
  stages jsonb not null default '[]',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, name),
  unique (tenant_id, id)
);

-- ── jobs ───────────────────────────────────────────────────────────────────
-- Composite FKs throughout (reviewer finding 7): FK validation runs as the table
-- owner and BYPASSES RLS, so a plain `references users (id)` lets a buggy write
-- point a job at another tenant's recruiter and the policy never sees it. Pairing
-- tenant_id into every FK makes that unrepresentable in the schema rather than
-- merely unlikely in the service layer. Nullable child columns are MATCH SIMPLE:
-- a null recruiter_id satisfies the constraint, a non-null one must match tenant.
create table jobs (
  id uuid primary key,
  tenant_id uuid not null references tenants (id),
  req_code text not null,
  title text not null,
  department text not null,
  location text not null,
  employment_type text,
  band_min_cents bigint,
  band_max_cents bigint,
  -- No default (reviewer finding 8): CLAUDE.md §4.9 is "never an assumed USD".
  -- Deviates from ARCHITECTURE §5's `default 'USD'` — see the PR description.
  currency char(3) not null,
  status text not null check (status in ('draft', 'active', 'on_hold', 'closing', 'closed')),
  recruiter_id uuid,
  hiring_manager_id uuid,
  openings int not null default 1,
  stage_template_id uuid not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, req_code),
  unique (tenant_id, id),
  foreign key (tenant_id, recruiter_id) references users (tenant_id, id),
  foreign key (tenant_id, hiring_manager_id) references users (tenant_id, id),
  foreign key (tenant_id, stage_template_id) references stage_templates (tenant_id, id)
);

-- ── job_stages ─────────────────────────────────────────────────────────────
create table job_stages (
  id uuid primary key,
  tenant_id uuid not null references tenants (id),
  job_id uuid not null,
  name text not null,
  position int not null,
  canonical text not null
    check (canonical in ('applied', 'screen', 'onsite', 'offer', 'hired', 'rejected', 'withdrawn')),
  sla_days int,
  is_terminal boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (job_id, position),
  unique (tenant_id, id),
  -- Referenceable by applications (job_id, current_stage_id) — the constraint that
  -- makes "this card's stage belongs to this card's job" a schema guarantee.
  unique (job_id, id),
  foreign key (tenant_id, job_id) references jobs (tenant_id, id)
);
create index job_stages_tenant_job_idx on job_stages (tenant_id, job_id, position);

-- ── candidates ─────────────────────────────────────────────────────────────
create table candidates (
  id uuid primary key,
  tenant_id uuid not null references tenants (id),
  name text not null,
  email citext,
  phone text,
  location text,
  current_title text,
  current_company text,
  links jsonb not null default '{}',
  anonymized_at timestamptz,
  search_vector tsvector generated always as (
    to_tsvector('simple',
      coalesce(name, '') || ' ' || coalesce(current_title, '') || ' ' || coalesce(current_company, ''))
  ) stored,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- M1 candidate dedupe keys on email. Nulls are distinct in Postgres, so
  -- candidates without an email (and anonymized rows, whose email is nulled)
  -- are unaffected. Scoped per tenant: two tenants may hold the same person.
  unique (tenant_id, email),
  unique (tenant_id, id)
);
create index candidates_search_idx on candidates using gin (search_vector);
create index candidates_name_trgm_idx on candidates using gin (name gin_trgm_ops);
create index candidates_tenant_name_idx on candidates (tenant_id, name);

-- ── applications ───────────────────────────────────────────────────────────
create table applications (
  id uuid primary key,
  tenant_id uuid not null references tenants (id),
  candidate_id uuid not null,
  job_id uuid not null,
  current_stage_id uuid not null,
  stage_entered_at timestamptz not null,
  board_rank text not null,
  source text not null,
  referred_by_id uuid,
  status text not null default 'active'
    check (status in ('active', 'hired', 'rejected', 'withdrawn')),
  rejection_reason text,
  comp_expectation_min_cents bigint,
  comp_expectation_max_cents bigint,
  -- CLAUDE.md §4.9: money is cents PLUS an explicit currency. Nullable only because
  -- the expectation itself is optional; the check below makes "cents without a
  -- currency" unrepresentable. ARCHITECTURE §5 omits this column — see the PR.
  comp_expectation_currency char(3),
  notice_period_days int,
  version int not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint applications_comp_expectation_currency_ck check (
    (comp_expectation_min_cents is null and comp_expectation_max_cents is null)
    or comp_expectation_currency is not null
  ),
  unique (tenant_id, candidate_id, job_id),
  unique (tenant_id, id),
  foreign key (tenant_id, candidate_id) references candidates (tenant_id, id),
  foreign key (tenant_id, job_id) references jobs (tenant_id, id),
  foreign key (tenant_id, referred_by_id) references users (tenant_id, id),
  -- Job-scoped, not tenant-scoped, and deliberately stronger than the tenant pair:
  -- (tenant_id, job_id) pins the job to the tenant and (job_id, current_stage_id)
  -- pins the stage to that job, so the stage's tenant follows transitively. A
  -- separate (tenant_id, current_stage_id) FK would be redundant.
  foreign key (job_id, current_stage_id) references job_stages (job_id, id)
);
create index applications_board_idx on applications (tenant_id, job_id, current_stage_id, board_rank);

-- ── stage_transitions — APPEND ONLY ────────────────────────────────────────
create table stage_transitions (
  id bigserial primary key,
  tenant_id uuid not null references tenants (id),
  application_id uuid not null,
  from_stage_id uuid,
  to_stage_id uuid not null,
  actor_id uuid,
  reason text,
  occurred_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (tenant_id, application_id) references applications (tenant_id, id),
  foreign key (tenant_id, from_stage_id) references job_stages (tenant_id, id),
  foreign key (tenant_id, to_stage_id) references job_stages (tenant_id, id),
  foreign key (tenant_id, actor_id) references users (tenant_id, id)
);
create index stage_transitions_tenant_app_idx on stage_transitions (tenant_id, application_id, occurred_at);
-- Funnel ("42% pass") and median-dwell queries group by the stage entered, not the
-- application — they read this side of the table and had no index (finding 10).
create index stage_transitions_tenant_to_stage_idx on stage_transitions (tenant_id, to_stage_id, occurred_at);

-- ── activities ─────────────────────────────────────────────────────────────
create table activities (
  id bigserial primary key,
  tenant_id uuid not null references tenants (id),
  application_id uuid not null,
  type text not null,
  actor_id uuid,
  body text,
  meta jsonb not null default '{}',
  occurred_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (tenant_id, application_id) references applications (tenant_id, id),
  foreign key (tenant_id, actor_id) references users (tenant_id, id)
);
create index activities_tenant_app_idx on activities (tenant_id, application_id, occurred_at desc);

-- ── audit_log — immutable ──────────────────────────────────────────────────
-- tenant_id nullable per ARCHITECTURE §5 (system-level events). Rows with a null
-- tenant_id are invisible to talon_app under the policy below — only the owner
-- (migration role / system writer) can read or write them.
--
-- Deliberately NOT given composite FKs (finding 7): tenant_id is nullable, and a
-- MATCH SIMPLE composite FK is satisfied outright whenever any column is null, so
-- it would be a no-op on exactly the system rows. actor_id and entity_id carry no
-- FK at all by design — an audit row must outlive the entity it describes.
create table audit_log (
  id bigserial primary key,
  tenant_id uuid references tenants (id),
  actor_id uuid,
  action text not null,
  entity_type text not null,
  entity_id uuid,
  before jsonb,
  after jsonb,
  ip inet,
  request_id text,
  occurred_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index audit_log_tenant_idx on audit_log (tenant_id, occurred_at desc);

-- ── updated_at triggers ────────────────────────────────────────────────────
create trigger trg_tenants_updated_at before update on tenants for each row execute function set_updated_at();
create trigger trg_users_updated_at before update on users for each row execute function set_updated_at();
create trigger trg_stage_templates_updated_at before update on stage_templates for each row execute function set_updated_at();
create trigger trg_jobs_updated_at before update on jobs for each row execute function set_updated_at();
create trigger trg_job_stages_updated_at before update on job_stages for each row execute function set_updated_at();
create trigger trg_candidates_updated_at before update on candidates for each row execute function set_updated_at();
create trigger trg_applications_updated_at before update on applications for each row execute function set_updated_at();
create trigger trg_activities_updated_at before update on activities for each row execute function set_updated_at();
-- stage_transitions and audit_log get no update trigger: UPDATE is not granted, ever.

-- ── RLS ────────────────────────────────────────────────────────────────────
-- tenants has no tenant_id; a tenant row is visible only to itself
-- (id = app.tenant_id). Cross-tenant lookup (e.g. slug → tenant at sign-in)
-- is the owner role's job, not the app role's.
alter table tenants enable row level security;
alter table tenants force row level security;
create policy tenant_isolation on tenants
  using (id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (id = nullif(current_setting('app.tenant_id', true), '')::uuid);

alter table users enable row level security;
alter table users force row level security;
create policy tenant_isolation on users
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

alter table stage_templates enable row level security;
alter table stage_templates force row level security;
create policy tenant_isolation on stage_templates
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

alter table jobs enable row level security;
alter table jobs force row level security;
create policy tenant_isolation on jobs
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

alter table job_stages enable row level security;
alter table job_stages force row level security;
create policy tenant_isolation on job_stages
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

alter table candidates enable row level security;
alter table candidates force row level security;
create policy tenant_isolation on candidates
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

alter table applications enable row level security;
alter table applications force row level security;
create policy tenant_isolation on applications
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

alter table stage_transitions enable row level security;
alter table stage_transitions force row level security;
create policy tenant_isolation on stage_transitions
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

alter table activities enable row level security;
alter table activities force row level security;
create policy tenant_isolation on activities
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

alter table audit_log enable row level security;
alter table audit_log force row level security;
create policy tenant_isolation on audit_log
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

-- ── grants ─────────────────────────────────────────────────────────────────
-- stage_transitions and audit_log are append-only: select + insert only.
grant select, insert, update, delete
  on tenants, users, stage_templates, jobs, job_stages, candidates, applications, activities
  to talon_app;
grant select, insert on stage_transitions, audit_log to talon_app;
grant usage, select on all sequences in schema public to talon_app;
