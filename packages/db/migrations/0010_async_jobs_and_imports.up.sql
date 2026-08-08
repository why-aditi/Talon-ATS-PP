-- Background tasks and CSV import bookkeeping (spec 008 §4, §6).
--
-- One table serves both imports and bulk actions. They differ in `kind` and in what
-- `params` holds; the progress, status and audit story is identical, and two tables
-- would mean two SSE endpoints and two sets of the same bugs.

create table jobs_async (              -- "job" is taken by the req; this is a background task
  -- No default. Every other table in this schema takes its id from the application
  -- (0001 throughout), and the enqueuer needs the id before the insert anyway — it goes
  -- into the presigned S3 key.
  id uuid primary key,
  tenant_id uuid not null references tenants (id),
  kind text not null check (kind in ('import', 'bulk_action')),

  -- `partial` is a first-class outcome, not an error (spec 008 §4). Nineteen of twenty
  -- succeeding is the normal case for a bulk action and the UI has to be able to say so;
  -- collapsing it into `failed` would make the honest result indistinguishable from a
  -- crash, and collapsing it into `succeeded` would hide the one that didn't.
  status text not null check (status in ('pending', 'running', 'succeeded', 'failed', 'partial')),

  -- Null until the worker has counted the work. Distinct from 0, which means "counted,
  -- and there is nothing to do" — an empty CSV is a valid file.
  total int,
  processed int not null default 0,
  failed int not null default 0,

  params jsonb not null,
  result jsonb,

  created_by uuid not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  finished_at timestamptz,

  -- Composite, not `references users (id)`. Non-negotiable #10: FK validation bypasses
  -- RLS, so a plain FK will happily point at another tenant's user row and Postgres
  -- will accept it. The pair is what makes that structurally impossible rather than
  -- merely unlikely.
  constraint jobs_async_creator_fk
    foreign key (tenant_id, created_by) references users (tenant_id, id),

  -- So children can reference this row compositely too, for the same reason.
  unique (tenant_id, id)
);

-- The worker's only read: oldest pending first, `for update skip locked`. Partial,
-- because a finished job can never be a candidate and this table is append-mostly.
create index jobs_async_pending_idx on jobs_async (created_at) where status = 'pending';

-- "My imports", newest first — the only list the UI asks for.
create index jobs_async_tenant_kind_idx on jobs_async (tenant_id, kind, created_at desc);

create trigger trg_jobs_async_updated_at before update on jobs_async
  for each row execute function set_updated_at();

alter table jobs_async enable row level security;
alter table jobs_async force row level security;
create policy tenant_isolation on jobs_async
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

grant select, insert, update on jobs_async to talon_app;


-- ── import_rows ─────────────────────────────────────────────────────────────
--
-- One row per CSV line the committer has reached. This table IS the idempotency
-- mechanism (spec 008 §6.2): a commit that dies at line 4,000 of 10,000 resumes rather
-- than duplicating, because the first thing the next attempt does is skip what is
-- already here.
--
-- It is deliberately not a jsonb blob on jobs_async.result. A 50k-row import would
-- rewrite a 50k-element array on every batch, and the resume path needs to ask "is
-- THIS row done" — an indexed lookup, not a scan of a document.

create table import_rows (
  tenant_id uuid not null,
  job_id uuid not null,
  -- 0-based line index within the parsed file, header excluded. Stable across re-runs
  -- of the same file, which is what makes the primary key below an idempotency key.
  row_index int not null,

  -- sha256 over (job_id, row_index, natural_key). The natural key is the email when
  -- there is one, else name+company. Carried alongside row_index rather than instead
  -- of it: row_index alone resumes a crashed run, the hash additionally catches the
  -- same person appearing twice in one file.
  row_hash text not null,

  status text not null check (status in ('committed', 'skipped', 'failed')),

  -- What the row produced, when it produced anything. Null for skipped and failed.
  candidate_id uuid,
  application_id uuid,

  -- Human-readable, and the source of the `_error` column in the downloadable error
  -- CSV. Escaped on the way out, never on the way in — see spec 008 §6.2a; the raw
  -- text is what we want stored, the escaping belongs to the CSV writer.
  error text,

  created_at timestamptz not null default now(),

  primary key (tenant_id, job_id, row_index),

  constraint import_rows_job_fk
    foreign key (tenant_id, job_id) references jobs_async (tenant_id, id) on delete cascade,

  -- Both children are tenant-scoped, so both FKs are composite (#10).
  constraint import_rows_candidate_fk
    foreign key (tenant_id, candidate_id) references candidates (tenant_id, id),
  constraint import_rows_application_fk
    foreign key (tenant_id, application_id) references applications (tenant_id, id),

  -- The same person twice in one file is caught here rather than by a scan.
  unique (tenant_id, job_id, row_hash)
);

-- Building the error CSV: every failed row of one job, in file order.
create index import_rows_failed_idx on import_rows (tenant_id, job_id, row_index)
  where status = 'failed';

alter table import_rows enable row level security;
alter table import_rows force row level security;
create policy tenant_isolation on import_rows
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

-- No update and no delete. A committed row is a statement that work happened; a
-- correction is a new import, not a rewrite of this one. Same treatment as
-- stage_transitions and audit_log, for the same reason.
grant select, insert on import_rows to talon_app;


-- pg_trgm and `candidates_name_trgm_idx` already exist (0001), as does the generated
-- `candidates.search_vector` that ⌘K will use — spec 008 §7.2 needs less new work than
-- it assumes.
--
-- What is missing is the expression this import's second dedupe pass actually runs.
-- Exact email is the first pass; the fallback is similarity over name AND company, and
-- an index on `name` alone cannot serve `similarity(name || ' ' || company, $1)` —
-- Postgres will seq-scan a table we are about to hit once per imported row.
create index candidates_name_company_trgm_idx on candidates
  using gin ((name || ' ' || coalesce(current_company, '')) gin_trgm_ops);
