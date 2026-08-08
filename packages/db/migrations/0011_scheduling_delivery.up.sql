-- Per-calendar delivery and durable idempotency for scheduling send (spec 004 §9–10).
create table interview_calendar_events (
  tenant_id uuid not null references tenants(id),
  interview_id uuid not null,
  user_id uuid not null,
  provider text not null,
  external_event_id text not null,
  status text not null check (status in ('tentative','confirmed')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (interview_id, user_id),
  unique (tenant_id, provider, external_event_id),
  foreign key (tenant_id, interview_id) references interviews(tenant_id,id) on delete cascade,
  foreign key (tenant_id, user_id) references users(tenant_id,id)
);
create index interview_calendar_events_tenant_user_idx on interview_calendar_events(tenant_id,user_id);
create trigger trg_interview_calendar_events_updated_at before update on interview_calendar_events
  for each row execute function set_updated_at();
alter table interview_calendar_events enable row level security;
alter table interview_calendar_events force row level security;
create policy tenant_isolation on interview_calendar_events
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

create table interview_loop_sends (
  tenant_id uuid not null references tenants(id),
  loop_id uuid not null,
  idempotency_key uuid not null,
  result jsonb not null,
  created_at timestamptz not null default now(),
  primary key (tenant_id, loop_id, idempotency_key),
  foreign key (tenant_id, loop_id) references interview_loops(tenant_id,id) on delete cascade
);
alter table interview_loop_sends enable row level security;
alter table interview_loop_sends force row level security;
create policy tenant_isolation on interview_loop_sends
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

grant select,insert,update,delete on interview_calendar_events to talon_app;
grant select,insert on interview_loop_sends to talon_app;
