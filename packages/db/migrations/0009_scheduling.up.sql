-- 0009_scheduling — the scheduling data model (spec 004 §5, ARCHITECTURE §5).
--
-- SCOPE NOTE. Spec 004 §5 opens "`interview_loops` already exists (ARCHITECTURE §5)".
-- It does not: ARCHITECTURE §5 *specifies* it, and nothing before this migration
-- created it, nor `interviews`, nor `interview_panelists`. So this file lands the whole
-- scheduling table set rather than the two tables plus two columns the spec implies.
-- The spec's §5 additions (`interview_rounds`, `interview_round_panelists`, and the
-- hold columns) are here; the three ARCHITECTURE §5 tables they hang off are here too.
--
-- The shape of the thing, because it is not obvious from the table names:
--   interview_rounds           the TEMPLATE — "this loop must contain a 60m coding round
--                              with Maya and Priya". Exists before anything is scheduled.
--   interviews                 the INSTANCE — a round that has been given a time. A round
--                              with no interviews row is unscheduled. That is the whole
--                              distinction, and conflating them is why scheduling code
--                              usually cannot answer "what still needs a slot".
--   interview_loops            groups the rounds into one onsite, and owns hold state.
--
-- DEVIATIONS FROM ARCHITECTURE §5, stated rather than left to be discovered:
--
-- 1. `interview_panelists` and `interview_round_panelists` carry `tenant_id`. §5 shows
--    them without one. Non-negotiable #1 is "every tenant-scoped table has tenant_id and
--    an RLS policy" — a join table reachable by id with no policy is a table the hostile
--    tenant suite cannot prove anything about, and "it is only reachable through a parent
--    that is scoped" is exactly the convention RLS exists to stop us relying on.
--
-- 2. `interviews` gains `round_id`, not null and unique. §5 predates §7's round template.
--    Not null because in M2 every interview instantiates a round; unique because a round
--    is scheduled at most once, so a re-solve UPDATEs rather than accumulating rows —
--    which is what makes "unscheduled = no row" a safe read.
--
-- 3. `interview_loops` gains `version` (optimistic concurrency, same pattern as jobs in
--    0008) and the candidate-availability columns from spec 004 §6.

-- ── business hours (spec 004 §6) ───────────────────────────────────────────
-- "A single per-tenant window in M2." Per-user working hours are out of scope and are a
-- real gap for a distributed panel (§14 open question 4) — when they land they go on
-- `users`, and this stays as the fallback.
--
-- These are WALL CLOCK IN THE LOOP'S TIMEZONE, deliberately with no timezone column of
-- their own. A third zone (tenant's, on top of organizer's and candidate's) buys nothing
-- here and is a third thing to get wrong at a DST boundary.
alter table tenants
  add column business_hours_start time not null default '09:00',
  add column business_hours_end   time not null default '17:00',
  add constraint tenants_business_hours_ck check (business_hours_end > business_hours_start);

comment on column tenants.business_hours_start is
  'Wall clock in the interview loop''s timezone, not a fixed zone. Spec 004 §6.';

-- ── interview_loops ────────────────────────────────────────────────────────
create table interview_loops (
  id uuid primary key,
  tenant_id uuid not null references tenants (id),
  application_id uuid not null,
  status text not null
    check (status in ('draft', 'proposed', 'held', 'confirmed', 'completed', 'cancelled')),
  target_date date,
  -- The ORGANIZER's zone: what the grid renders in. Storage is UTC everywhere
  -- (non-negotiable #7); this is the conversion target, not a second truth.
  timezone text not null,

  -- Candidate availability (spec 004 §6): "candidate available 9 to 4", stored in the
  -- CANDIDATE's zone and rendered in the organizer's. A hard bound on the solver.
  -- Nullable because a loop exists from the moment someone is advanced to Onsite, before
  -- anyone has asked the candidate; the check makes a half-filled window unrepresentable
  -- and the service refuses to solve without one.
  candidate_timezone text,
  candidate_window_start time,
  candidate_window_end time,

  -- The 24h soft reservation (spec 004 §9). Postgres is the source of truth.
  held_by uuid,
  hold_expires_at timestamptz,

  version int not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint interview_loops_candidate_window_ck check (
    (candidate_timezone is null and candidate_window_start is null and candidate_window_end is null)
    or (candidate_timezone is not null and candidate_window_start is not null
        and candidate_window_end is not null and candidate_window_end > candidate_window_start)
  ),
  -- A hold is a holder AND an expiry, never one of them. Half a hold is a slot nobody
  -- can take and nobody can release.
  constraint interview_loops_hold_pair_ck check (
    (held_by is null) = (hold_expires_at is null)
  ),
  -- `held` with no holder is the state that makes edge case 4 ("who holds it, and until
  -- when?") unanswerable. Unrepresentable instead.
  constraint interview_loops_held_requires_holder_ck check (
    status <> 'held' or held_by is not null
  ),

  unique (tenant_id, id),
  -- Referenceable by interviews (application_id, loop_id) — the constraint that makes
  -- "this interview's loop is for this interview's candidate" a schema guarantee.
  unique (application_id, id),
  foreign key (tenant_id, application_id) references applications (tenant_id, id),
  foreign key (tenant_id, held_by) references users (tenant_id, id)
);
create index interview_loops_tenant_app_idx on interview_loops (tenant_id, application_id);
-- The sweep job's only read (spec 004 §5): expire holds whose hold_expires_at has passed.
-- Partial, because a loop that is not held can never be a candidate — and expiry must not
-- depend on the read path, or an expired hold stays visible until someone happens to look.
create index interview_loops_hold_expiry_idx on interview_loops (hold_expires_at)
  where hold_expires_at is not null;

-- ── interview_rounds — the template ────────────────────────────────────────
create table interview_rounds (
  id uuid primary key,
  tenant_id uuid not null references tenants (id),
  loop_id uuid not null,
  kind text not null
    check (kind in ('coding', 'system_design', 'values', 'hiring_manager')),
  duration_min int not null check (duration_min > 0 and duration_min % 15 = 0),
  position int not null check (position >= 0),
  -- Reserved. Spec 004 §7: the M2 solver places rounds in `position` order and ignores
  -- this. The follow-up permutes swappable rounds (capped at 4! orderings) by wrapping
  -- step 2 of the solver, without touching the schema — which is why the column exists
  -- now rather than arriving with a migration later.
  is_swappable boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  unique (loop_id, position),
  unique (tenant_id, id),
  -- Referenceable by interviews (loop_id, round_id): an interview's round must belong to
  -- the interview's loop. Same shape, same reason, as applications (job_id, stage_id).
  unique (loop_id, id),
  foreign key (tenant_id, loop_id) references interview_loops (tenant_id, id) on delete cascade
);
create index interview_rounds_tenant_loop_idx on interview_rounds (tenant_id, loop_id, position);

-- duration_min % 15 = 0 is not fussiness: the solver works on a 15-minute bitmap
-- (spec 004 §7), so a 50-minute round is not representable in the grid it is placed on.
comment on column interview_rounds.duration_min is
  'Multiple of 15. The solver''s bitmap granularity is 15 minutes (spec 004 §7); a duration off that grid cannot be placed exactly and would silently round.';

-- ── interview_round_panelists ──────────────────────────────────────────────
create table interview_round_panelists (
  tenant_id uuid not null references tenants (id),
  round_id uuid not null,
  user_id uuid not null,
  -- Required panelists are a hard constraint on the solver; optional ones are invited
  -- and never block a placement.
  is_required boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (round_id, user_id),
  foreign key (tenant_id, round_id) references interview_rounds (tenant_id, id) on delete cascade,
  foreign key (tenant_id, user_id) references users (tenant_id, id)
);
-- "Which rounds is this person on" — the read behind edge case 8 (panelist removed from
-- the tenant between hold and send) and behind the per-user free/busy fetch.
create index interview_round_panelists_tenant_user_idx on interview_round_panelists (tenant_id, user_id);

-- ── interviews — the scheduled instance ────────────────────────────────────
create table interviews (
  id uuid primary key,
  tenant_id uuid not null references tenants (id),
  application_id uuid not null,
  loop_id uuid not null,
  round_id uuid not null,
  -- Copied from the round at schedule time, not joined. An interview that has happened
  -- must still describe itself after someone edits the template it came from.
  kind text not null
    check (kind in ('coding', 'system_design', 'values', 'hiring_manager')),
  -- Same 15-minute grid as interview_rounds, and for the same reason rather than for
  -- symmetry: the solver and §7a's validateArrangement both work on a 15-minute bitmap,
  -- so a 50-minute interview has no exact position on it. Copied from the round today,
  -- but this is the row a placement writes, and an off-grid value here would surface far
  -- from where it was written — as a slot that quietly rounds, not as a rejected insert.
  duration_min int not null check (duration_min > 0 and duration_min % 15 = 0),
  scheduled_start timestamptz,
  scheduled_end timestamptz,
  status text not null check (
    status in ('unscheduled', 'pending', 'confirmed', 'declined', 'completed', 'cancelled')
  ),
  external_event_id text,
  external_provider text,

  -- Manual placement (spec 004 §7a). A recruiter may place a round over a hard constraint
  -- after an explicit "Place anyway", because they often know something the calendar does
  -- not. These two columns are the audit trail of that choice: the flag says a human chose
  -- it, `acknowledged_blocker` says what they were shown when they did. The flag alone is
  -- worthless — "someone overrode something" answers nothing six weeks later.
  --
  -- jsonb, not its own table: the payload is the solver's structured blocker union
  -- (packages/contracts SolveBlockerSchema), it is written once with the placement, and it
  -- is only ever read back whole. Normalising a union of eight shapes that nothing queries
  -- by field buys a join and a migration every time a reason is added.
  manual_override boolean not null default false,
  acknowledged_blocker jsonb,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  -- Mirrors the contract's refine on ScheduledInterviewSchema. The reverse is allowed: a
  -- manual placement that violated nothing overrides nothing and carries no blocker.
  constraint interviews_acknowledged_blocker_requires_override_ck check (
    acknowledged_blocker is null or manual_override
  ),

  constraint interviews_schedule_pair_ck check (
    (scheduled_start is null) = (scheduled_end is null)
  ),
  -- The row states its duration twice — `duration_min` and the span — and nothing used to
  -- reconcile them: duration_min = 45 with a 10:00–11:00 span satisfied every other
  -- constraint on the table. That is precisely the "slot that quietly rounds" the
  -- duration_min comment above claims to prevent, arriving by a different door.
  --
  -- `scheduled_end is null` first, so this says nothing about null-ness: the pair check
  -- already forbids half a span and the committed check already forbids no span on a
  -- committed row. An unscheduled or cancelled round passes here trivially.
  --
  -- make_interval(mins => ...) yields a pure time interval with no day or month field, so
  -- the addition is an exact number of seconds on the UTC instant and does not shift at a
  -- DST boundary — an interval '1 day' here would.
  --
  -- THIS ALSO CARRIES `scheduled_end > scheduled_start`, which used to be its own
  -- `interviews_schedule_order_ck`. Equality with a strictly positive interval (duration_min
  -- is checked > 0 above) implies the ordering, so the separate check asserted nothing this
  -- one does not. If this is ever relaxed — a tolerance, a break allowed inside a round —
  -- the ordering stops being implied and the order check has to come back with it.
  constraint interviews_schedule_span_ck check (
    scheduled_end is null or scheduled_end = scheduled_start + make_interval(mins => duration_min)
  ),
  -- A confirmed interview with no time is the state that lets a candidate be told to
  -- show up at nothing.
  constraint interviews_scheduled_when_committed_ck check (
    status in ('unscheduled', 'cancelled') or scheduled_start is not null
  ),

  -- One interview per round: a re-solve updates in place, which is what makes
  -- "no row = unscheduled" a safe read rather than "no row = maybe an old one".
  unique (round_id),
  unique (tenant_id, id),
  foreign key (tenant_id, application_id) references applications (tenant_id, id),
  foreign key (tenant_id, loop_id) references interview_loops (tenant_id, id),
  -- The two structural pins, both stronger than a tenant pair:
  --   the round belongs to this loop …
  foreign key (loop_id, round_id) references interview_rounds (loop_id, id) on delete cascade,
  --   … and the loop is for this application, so the tenant follows transitively.
  foreign key (application_id, loop_id) references interview_loops (application_id, id)
);
create index interviews_tenant_loop_idx on interviews (tenant_id, loop_id);
create index interviews_tenant_app_idx on interviews (tenant_id, application_id);
-- "What is on this person's plate this week" and the itinerary read.
create index interviews_tenant_start_idx on interviews (tenant_id, scheduled_start)
  where scheduled_start is not null;
-- Calendar-write idempotency (spec 004 §10 step 5): a retry must find the event it
-- already created rather than create a second one. Partial — most rows have no event yet.
create unique index interviews_external_event_idx
  on interviews (tenant_id, external_provider, external_event_id)
  where external_event_id is not null;

-- ── interview_panelists ────────────────────────────────────────────────────
create table interview_panelists (
  tenant_id uuid not null references tenants (id),
  interview_id uuid not null,
  user_id uuid not null,
  -- Radicale has no iTIP, so responses are never read back from the server: a panelist
  -- marks accepted or declined in Talon and this column is the only record (spec 004 §10).
  -- A Google adapter later fills the same column from push notifications; the shape does
  -- not change.
  response text not null default 'pending'
    check (response in ('pending', 'accepted', 'declined')),
  is_required boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (interview_id, user_id),
  foreign key (tenant_id, interview_id) references interviews (tenant_id, id) on delete cascade,
  foreign key (tenant_id, user_id) references users (tenant_id, id)
);
create index interview_panelists_tenant_user_idx on interview_panelists (tenant_id, user_id);

-- ── updated_at triggers ────────────────────────────────────────────────────
create trigger trg_interview_loops_updated_at before update on interview_loops
  for each row execute function set_updated_at();
create trigger trg_interview_rounds_updated_at before update on interview_rounds
  for each row execute function set_updated_at();
create trigger trg_interview_round_panelists_updated_at before update on interview_round_panelists
  for each row execute function set_updated_at();
create trigger trg_interviews_updated_at before update on interviews
  for each row execute function set_updated_at();
create trigger trg_interview_panelists_updated_at before update on interview_panelists
  for each row execute function set_updated_at();

-- ── RLS ────────────────────────────────────────────────────────────────────
-- enable + force + the fail-closed nullif() pattern from 0001: with no app.tenant_id set,
-- current_setting(..., true) is '' rather than an error, nullif makes it NULL, and
-- `tenant_id = NULL` is never true. Unset context sees nothing, which is the only safe
-- direction for a default.
alter table interview_loops enable row level security;
alter table interview_loops force row level security;
create policy tenant_isolation on interview_loops
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

alter table interview_rounds enable row level security;
alter table interview_rounds force row level security;
create policy tenant_isolation on interview_rounds
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

alter table interview_round_panelists enable row level security;
alter table interview_round_panelists force row level security;
create policy tenant_isolation on interview_round_panelists
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

alter table interviews enable row level security;
alter table interviews force row level security;
create policy tenant_isolation on interviews
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

alter table interview_panelists enable row level security;
alter table interview_panelists force row level security;
create policy tenant_isolation on interview_panelists
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

-- ── grants ─────────────────────────────────────────────────────────────────
-- Nothing here is append-only: a round is edited, an interview is rescheduled, a hold is
-- released. `stage_transitions` remains the audit trail that cannot be rewritten.
grant select, insert, update, delete
  on interview_loops, interview_rounds, interview_round_panelists, interviews, interview_panelists
  to talon_app;
