-- Reverses 0006_definer_rls_exemption.
--
-- Drops the two exception policies and puts the three definer functions back to
-- the bodies 0003/0004/0005 created — restoring the previous state rather than
-- leaving functions that opt in to policies which no longer exist. (Under a
-- superuser owner the marker is inert either way, which is precisely why leaving
-- it would look clean and prove nothing.)
--
-- Know what this rolls back TO: with these policies gone, a database whose owner
-- is not a superuser and does not hold BYPASSRLS returns to failing every sign-in
-- with 42501 on the audit write, and resolving no user for any token subject.
-- That is the bug 0006 exists to fix, so this direction is only ever correct
-- against a local superuser-owned database, or as the middle step of up → down →
-- up. It is not a mitigation for anything.
--
-- audit_log rows already written are untouched: the table is append-only, and a
-- rollback that deleted history would be the one operation it exists to prevent.

drop policy if exists audit_sign_in_write on audit_log;
drop policy if exists auth_bootstrap_read on users;

-- ── 0003's auth_user_by_email, verbatim (language sql again) ───────────────
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
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select u.id, u.tenant_id, u.email, u.name, u.role, u.timezone, u.mfa_enabled,
         u.tokens_valid_after
  from public.users u
  where u.email = p_email
$$;

comment on function auth_user_by_email(citext) is
  'Sign-in bootstrap (spec 001 §11b): resolves tenant and role for one email before app.tenant_id exists. No password material, exact match only.';

-- ── 0004's auth_user_by_sub, verbatim ─────────────────────────────────────
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
  return query
    select u.id, u.tenant_id, u.email, u.name, u.role, u.timezone, u.mfa_enabled,
           u.tokens_valid_after
    from public.users u
    where u.external_id = p_sub;
  if found then
    return;
  end if;

  if p_sub ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' then
    return query
      select u.id, u.tenant_id, u.email, u.name, u.role, u.timezone, u.mfa_enabled,
             u.tokens_valid_after
      from public.users u
      where u.id = p_sub::uuid and u.external_id is null;
  end if;

  return;
end $$;

comment on function auth_user_by_sub(text) is
  'Request-chain bootstrap (spec 001 §6.3, spec 002): resolves the users row for a token subject before app.tenant_id exists. Matches users.external_id, else users.id for local-provider users only. Malformed input returns zero rows, never raises. No password material, exact match only.';

-- ── 0005's audit_sign_in, verbatim (no actor/tenant consistency check) ─────
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
begin
  if p_outcome not in ('succeeded', 'failed') then
    raise exception 'audit_sign_in: outcome must be succeeded or failed, got %', p_outcome;
  end if;

  if p_outcome = 'succeeded' and (p_tenant_id is null or p_actor_id is null) then
    raise exception 'audit_sign_in: a succeeded sign-in must carry a tenant and an actor';
  end if;

  begin
    v_ip := nullif(btrim(coalesce(p_ip, '')), '')::inet;
  exception when others then
    v_ip := null;
  end;

  insert into public.audit_log (
    tenant_id, actor_id, action, entity_type, entity_id, before, after, ip, request_id
  )
  values (
    case when p_outcome = 'succeeded' then p_tenant_id end,
    case when p_outcome = 'succeeded' then p_actor_id end,
    'auth.sign_in.' || p_outcome,
    'authentication',
    null,
    null,
    jsonb_strip_nulls(jsonb_build_object(
      'outcome', p_outcome,
      'email', left(btrim(coalesce(p_email, '')), 320),
      'reason', nullif(left(btrim(coalesce(p_reason, '')), 128), '')
    )),
    v_ip,
    left(btrim(coalesce(p_request_id, '')), 128)
  );
end $$;

comment on function audit_sign_in(text, text, text, uuid, uuid, text, text) is
  'Writes the one audit_log row a sign-in attempt produces, before any tenant context exists (CLAUDE.md §4, spec 001 §11b). Fixed action and entity_type; failures carry no tenant and no actor; never records a password, a token, or any reason the caller was not already told.';

revoke all on function auth_user_by_email(citext) from public;
revoke all on function auth_user_by_sub(text) from public;
revoke all on function audit_sign_in(text, text, text, uuid, uuid, text, text) from public;
grant execute on function auth_user_by_email(citext) to talon_app;
grant execute on function auth_user_by_sub(text) to talon_app;
grant execute on function audit_sign_in(text, text, text, uuid, uuid, text, text) to talon_app;
