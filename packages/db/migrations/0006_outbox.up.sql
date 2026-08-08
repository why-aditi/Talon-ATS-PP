-- Transactional outbox (ARCHITECTURE §6.1, spec 004 §3).
--
-- Every state change that others need to hear about writes a row here in the SAME
-- transaction as the change itself. Nothing is published inline: a failed publish must
-- never roll back a committed state change, and a committed state change must never
-- lose its event. The relay (workers-outbox) polls, publishes, and stamps published_at.

create table outbox (
  -- bigserial, not uuid: delivery is at-least-once and every consumer is idempotent
  -- keyed on THIS id (non-negotiable #19), so it has to be a total ordering as well as
  -- unique. A uuid would be unique and useless for ordering.
  id            bigserial primary key,
  tenant_id     uuid not null,
  -- Which aggregate the event is about, so a consumer can filter without opening payload.
  aggregate     text not null,
  aggregate_id  uuid not null,
  event_type    text not null,
  -- Ids and versions only. ARCHITECTURE §6.1: payloads carry no entity state, so a
  -- stale broadcast can never write bad data into a client cache — the client refetches.
  payload       jsonb not null,
  occurred_at   timestamptz not null default now(),
  -- Null until the relay has published it. The partial index below is built on this.
  published_at  timestamptz,
  attempts      int not null default 0,
  last_error    text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),

  -- Deliberately NO unique on (aggregate_id, event_type): one application legitimately
  -- produces many ApplicationStageChanged events over its life. Deduplication is the
  -- consumer's job, keyed on id.
  foreign key (tenant_id) references tenants (id)
);

-- The relay's only read: unpublished, oldest first, `for update skip locked` in batches
-- of 100. Partial so the index does not carry every published row forever — this table
-- is append-mostly and grows without bound until archived.
create index outbox_unpublished_idx on outbox (id) where published_at is null;

-- Rows past 10 attempts alarm rather than retry forever (ARCHITECTURE §6.1). Partial for
-- the same reason: a published row can never be a candidate.
create index outbox_stuck_idx on outbox (attempts, id) where published_at is null;

create trigger trg_outbox_updated_at before update on outbox for each row execute function set_updated_at();

alter table outbox enable row level security;
alter table outbox force row level security;
create policy tenant_isolation on outbox
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

-- Append-only from the application's side: select + insert, no update, no delete —
-- the same treatment stage_transitions and audit_log get. Only the relay stamps
-- published_at, and it connects as its own role.
--
-- That role is NOT created here. Migrations never create roles or carry credentials
-- (non-negotiable #11); `talon_relay` is provisioning's job — the Docker init script
-- locally, Terraform plus Secrets Manager in AWS — and it needs bypassrls, because a
-- poller that could only see one tenant would never drain the table.
grant select, insert on outbox to talon_app;

-- Explicitly, not by relying on 0001's `grant ... on all sequences in schema public`:
-- that is a point-in-time grant over the sequences that existed when it ran, and it
-- does not reach one created by a later migration. Without this the app role can be
-- granted INSERT and still fail with "permission denied for sequence outbox_id_seq" —
-- which would break every stage move, since the insert shares their transaction.
grant usage, select on sequence outbox_id_seq to talon_app;
