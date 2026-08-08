-- 0006_definer_rls_exemption — make the `security definer` surface work when the
-- role that owns it is not a superuser.
--
-- A NEW pair, deliberately: _migrations keys on name with no checksum, so editing
-- 0003/0004/0005 in place is a silent no-op against any database that already ran
-- them — including main.
--
-- Runs as the migration role (owner), like every migration here.
--
-- ── The bug ────────────────────────────────────────────────────────────────
-- Three functions in this schema are `security definer` because they must touch a
-- table before `app.tenant_id` exists: auth_user_by_email and auth_user_by_sub
-- read `users` (0003, 0004), audit_sign_in writes `audit_log` (0005). Every one
-- of those tables carries `force row level security`.
--
-- FORCE subjects the table's OWNER to the policy. `security definer` runs as the
-- owner. So the definer is exempt only when that owner is a superuser or holds
-- BYPASSRLS — which is exactly true of the local `talon` role, and exactly false
-- of an RDS/Aurora master user. Locally everything passes; on the deployment
-- target this spec exists to reach:
--
--   * every sign-in raises 42501 on the audit write — and the write is
--     deliberately fail-closed ("no audit row, no token", spec 002 §12.4), so
--     that is not a degraded trail, it is a 500 on every login;
--   * auth_user_by_sub returns zero rows, so every authenticated request 401s as
--     an unknown subject even if a token could be minted.
--
-- 0003's own header predicted it — "the Aurora role in spec 002 must carry
-- BYPASSRLS or own an exception policy" — and nothing ever chose. This chooses:
-- the exception policy. Both halves of the alternative were refused:
--
--   1. Require BYPASSRLS on the migration role. Not grantable on a managed
--      instance: BYPASSRLS can only be conferred by a role that already has it,
--      and there is no superuser session on RDS/Aurora to start that chain. It
--      would also mean the role that runs migrations can read and write every
--      tenant's rows through every policy in the schema, permanently, to buy an
--      exemption three functions need.
--   2. A dedicated function owner that holds BYPASSRLS, created by provisioning.
--      Same objection at the role level (a BYPASSRLS role in the database is a
--      strictly larger hole than a policy admitting two row shapes), plus
--      CLAUDE.md §4.11: migrations never create roles. The migration would then
--      depend on an out-of-band step, and skipping that step reproduces this
--      outage later and further from its cause.
--
-- ── What admits the writer, and why it is not forgeable ────────────────────
-- Each policy below is the conjunction of two facts:
--
--   (a) `current_user` is the table's owner. Inside a SECURITY DEFINER function
--       that is the function's owner; for the api it is `talon_app`, which cannot
--       become the owner. This is the part that carries the security weight —
--       `talon_app` gains nothing here it did not already have.
--   (b) a marker GUC set inside the function. Custom GUCs are settable by ANY
--       role, so (b) is forgeable and worthless alone. Its job is different: it
--       keeps FORCE's real purpose — the backstop against an owner-connected
--       session (a seed script, a psql window, an api misconfigured onto the
--       owner URL, which on Aurora would pass the request chain's
--       bypass-role audit because the owner does NOT bypass) reading or writing
--       across tenants by accident. An owner session sees nothing extra unless it
--       has deliberately opted in, inside a transaction, for one statement.
--
-- The marker is `SET LOCAL`, and each function also carries a `SET search_path`
-- clause, which makes Postgres save and restore the whole GUC nest level across
-- the call — so the opt-in cannot outlive the function even within a transaction
-- that traps an error. The explicit resets below are belt to that brace.
--
-- The owner is read from the catalog rather than baked in as a literal, because
-- the owner's NAME differs per environment (`talon` locally, the master user on
-- Aurora) while the relationship — "the role FORCE is aimed at" — does not. If
-- ownership of the functions and the tables is ever split between roles, sign-in
-- fails closed rather than opening up, which is the correct direction.

-- ── users: the sign-in / request-chain bootstrap read ──────────────────────
-- SELECT only. Nothing here lets the owner write a users row past the tenant
-- policy, which remains the seed script's problem and not this migration's.
create policy auth_bootstrap_read on users
  for select
  using (
    current_user = (
      select pg_catalog.pg_get_userbyid(c.relowner)
      from pg_catalog.pg_class c
      where c.oid = 'public.users'::regclass
    )
    and pg_catalog.current_setting('talon.auth_bootstrap', true) = 'on'
  );

comment on policy auth_bootstrap_read on users is
  'Exempts the §11b bootstrap readers (auth_user_by_email, auth_user_by_sub) from force RLS when the owner does not hold BYPASSRLS. Requires the owner AND the marker those functions set LOCAL; talon_app satisfies neither.';

-- ── audit_log: the sign-in writer ──────────────────────────────────────────
-- INSERT only, so this adds no way to READ another tenant's audit rows — and in
-- particular no way to read the null-tenant system rows, which stay unreadable
-- through RLS by design (spec 002 §12.3 defers that reader to whoever builds the
-- screen). The row shape is pinned here as well as in the function: even the
-- owner, even having opted in, can only produce the two authentication rows.
create policy audit_sign_in_write on audit_log
  for insert
  with check (
    current_user = (
      select pg_catalog.pg_get_userbyid(c.relowner)
      from pg_catalog.pg_class c
      where c.oid = 'public.audit_log'::regclass
    )
    and pg_catalog.current_setting('talon.audit_sign_in', true) = 'on'
    and entity_type = 'authentication'
    and action in ('auth.sign_in.succeeded', 'auth.sign_in.failed')
    and entity_id is null
    and before is null
  );

comment on policy audit_sign_in_write on audit_log is
  'Exempts audit_sign_in() from force RLS when the owner does not hold BYPASSRLS. Requires the owner AND the marker the function sets LOCAL, and admits only the two fixed authentication row shapes.';

-- ── auth_user_by_email: opt in to the read policy ──────────────────────────
-- DEVIATION from 0003: `language plpgsql`, not `language sql`. The marker has to
-- be set before the read and cleared after it, and a SQL body cannot sequence
-- anything after the statement whose rows it returns. Body, signature, volatility,
-- pinned search_path and grants are otherwise 0003's, unchanged.
--
-- Still has no caller (the local provider is gone, spec 002 open question 1), and
-- is still not dropped here — spec 003 §6 owns that. It is fixed rather than left
-- because the next thing to resolve a principal by email is SSO, and a function
-- that quietly returns zero rows on Aurora is the same outage waiting for its
-- second caller.
create or replace function auth_user_by_email(p_email citext)
returns table (
  id uuid,
  tenant_id uuid,
  email citext,
  name text,
  role text,
  timezone text,
  mfa_enabled boolean,
  tokens_valid_after timestamptz
)
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $$
begin
  perform pg_catalog.set_config('talon.auth_bootstrap', 'on', true);
  return query
    select u.id, u.tenant_id, u.email, u.name, u.role, u.timezone, u.mfa_enabled,
           u.tokens_valid_after
    from public.users u
    where u.email = p_email;
  perform pg_catalog.set_config('talon.auth_bootstrap', '', true);
end $$;

comment on function auth_user_by_email(citext) is
  'Sign-in bootstrap (spec 001 §11b): resolves tenant and role for one email before app.tenant_id exists. No password material, exact match only. Reads past users'' force RLS via the auth_bootstrap_read policy (0006), not via owner privilege.';

-- ── auth_user_by_sub: opt in to the read policy ────────────────────────────
-- 0004's body verbatim — two lookups, resolution order, the regex guard and why
-- it must be plpgsql are all documented there — plus the marker around it.
create or replace function auth_user_by_sub(p_sub text)
returns table (
  id uuid,
  tenant_id uuid,
  email citext,
  name text,
  role text,
  timezone text,
  mfa_enabled boolean,
  tokens_valid_after timestamptz
)
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $$
begin
  perform pg_catalog.set_config('talon.auth_bootstrap', 'on', true);

  return query
    select u.id, u.tenant_id, u.email, u.name, u.role, u.timezone, u.mfa_enabled,
           u.tokens_valid_after
    from public.users u
    where u.external_id = p_sub;
  if found then
    perform pg_catalog.set_config('talon.auth_bootstrap', '', true);
    return;
  end if;

  -- Canonical 8-4-4-4-12 hex only; anything else falls through to zero rows and
  -- never raises (0004).
  if p_sub ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' then
    return query
      select u.id, u.tenant_id, u.email, u.name, u.role, u.timezone, u.mfa_enabled,
             u.tokens_valid_after
      from public.users u
      where u.id = p_sub::uuid and u.external_id is null;
  end if;

  perform pg_catalog.set_config('talon.auth_bootstrap', '', true);
  return;
end $$;

comment on function auth_user_by_sub(text) is
  'Request-chain bootstrap (spec 001 §6.3, spec 002): resolves the users row for a token subject before app.tenant_id exists. Matches users.external_id, else users.id for local-provider users only. Malformed input returns zero rows, never raises. Reads past users'' force RLS via the auth_bootstrap_read policy (0006), not via owner privilege.';

-- ── audit_sign_in: opt in to the write policy, and stop trusting the caller ─
-- 0005's body, with two changes.
--
-- 1. The marker, per the header above.
--
-- 2. The success path now proves the actor belongs to the tenant (reviewer
--    finding 4). 0005 took tenant_id and actor_id from the caller and checked
--    only that they were non-null, so `talon_app` — which is granted this
--    function — could write a forged `auth.sign_in.succeeded` into ANY tenant's
--    trail, naming any actor. That is marginal against its existing insert grant,
--    but the function is `security definer`, it already has to read `users` to be
--    correct, and spec 002 §12.2 claims "every column the caller has no
--    legitimate say in decided inside the function", which was not true of the
--    two columns that decide whose trail the row lands in. The tenant written is
--    now the one `users` says, not the one the caller passed.
--
--    The lookup is by actor id alone and its result is compared, rather than
--    filtering on both columns: "no such user" and "wrong tenant" are different
--    mistakes and a shared error message would hide which one happened. Neither
--    is reachable from the sign-in path — a successful sign-in resolved a users
--    row by construction — so neither is an oracle; both are programming errors
--    and both are loud.
create or replace function audit_sign_in(
  p_outcome    text,
  p_reason     text,
  p_email      text,
  p_tenant_id  uuid,
  p_actor_id   uuid,
  p_ip         text,
  p_request_id text
)
returns void
language plpgsql
volatile
security definer
set search_path = pg_catalog, public
as $$
declare
  v_ip inet;
  v_tenant_id uuid;
begin
  if p_outcome not in ('succeeded', 'failed') then
    raise exception 'audit_sign_in: outcome must be succeeded or failed, got %', p_outcome;
  end if;

  if p_outcome = 'succeeded' and (p_tenant_id is null or p_actor_id is null) then
    -- A successful sign-in resolved a users row by construction. Writing one
    -- without a tenant would hide it from that tenant's own audit trail under
    -- the RLS policy, i.e. lose it in the only place anyone will look.
    raise exception 'audit_sign_in: a succeeded sign-in must carry a tenant and an actor';
  end if;

  if p_outcome = 'succeeded' then
    perform pg_catalog.set_config('talon.auth_bootstrap', 'on', true);
    select u.tenant_id into v_tenant_id from public.users u where u.id = p_actor_id;
    perform pg_catalog.set_config('talon.auth_bootstrap', '', true);

    if v_tenant_id is null then
      raise exception 'audit_sign_in: actor % does not belong to any tenant — no such user',
        p_actor_id;
    end if;
    if v_tenant_id <> p_tenant_id then
      raise exception 'audit_sign_in: actor % does not belong to tenant %',
        p_actor_id, p_tenant_id;
    end if;
  end if;

  -- Fastify's request.ip is the socket peer and always parses; a proxy header
  -- would not be. Never let an unparseable address turn an audit write into a
  -- 500 on the sign-in path — record the row without it.
  begin
    v_ip := nullif(btrim(coalesce(p_ip, '')), '')::inet;
  exception when others then
    v_ip := null;
  end;

  perform pg_catalog.set_config('talon.audit_sign_in', 'on', true);

  insert into public.audit_log (
    tenant_id, actor_id, action, entity_type, entity_id, before, after, ip, request_id
  )
  values (
    -- v_tenant_id, not p_tenant_id: what `users` says, not what the caller said.
    case when p_outcome = 'succeeded' then v_tenant_id end,
    case when p_outcome = 'succeeded' then p_actor_id end,
    'auth.sign_in.' || p_outcome,
    'authentication',
    null,
    -- No before-state: authenticating changes no entity. The row records an
    -- event, and `after` is what is known about it.
    null,
    -- `jsonb_strip_nulls` drops `reason` on a success, where there is nothing to
    -- explain. `nullif` is what makes an empty or whitespace-only reason count
    -- as absent rather than as a key with an empty string in it.
    jsonb_strip_nulls(jsonb_build_object(
      'outcome', p_outcome,
      -- Attacker-controlled, and length-bounded here as well as at the contract
      -- layer, because this function is the last thing between that string and
      -- permanent storage.
      'email', left(btrim(coalesce(p_email, '')), 320),
      'reason', nullif(left(btrim(coalesce(p_reason, '')), 128), '')
    )),
    v_ip,
    left(btrim(coalesce(p_request_id, '')), 128)
  );

  perform pg_catalog.set_config('talon.audit_sign_in', '', true);
end $$;

comment on function audit_sign_in(text, text, text, uuid, uuid, text, text) is
  'Writes the one audit_log row a sign-in attempt produces, before any tenant context exists (CLAUDE.md §4, spec 001 §11b). Fixed action and entity_type; failures carry no tenant and no actor; a success is written to the tenant users says the actor belongs to; never records a password, a token, or any reason the caller was not already told. Writes past audit_log''s force RLS via the audit_sign_in_write policy (0006), not via owner privilege.';

-- CREATE OR REPLACE keeps the existing ACL, so the 0003/0004/0005 grants stand.
-- Restated rather than assumed: a function whose EXECUTE silently reverted to
-- PUBLIC is not a thing to discover later.
revoke all on function auth_user_by_email(citext) from public;
revoke all on function auth_user_by_sub(text) from public;
revoke all on function audit_sign_in(text, text, text, uuid, uuid, text, text) from public;
grant execute on function auth_user_by_email(citext) to talon_app;
grant execute on function auth_user_by_sub(text) to talon_app;
grant execute on function audit_sign_in(text, text, text, uuid, uuid, text, text) to talon_app;
