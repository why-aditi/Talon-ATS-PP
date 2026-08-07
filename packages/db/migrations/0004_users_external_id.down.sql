-- Reverses 0004_users_external_id.
--
-- DESTRUCTIVE: dropping users.external_id drops every external identity mapping
-- with it, and they are not recoverable from anything else in the database — the
-- IdP owns the subject, we only hold the join. Acceptable only because the
-- reverse direction means "go back to the local provider", where the subject is
-- users.id and no mapping exists. Re-running the up migration re-adds the column
-- empty; the mappings have to be re-provisioned from the IdP.
--
-- The function is restored to 0003's uuid-typed version VERBATIM, including its
-- comment, its revoke and its grant. A signature change is drop + create in both
-- directions, and a down that leaves behind a text-typed function (or an
-- ungranted one) would break sign-in on a rollback rather than at the rollback.

drop function if exists auth_user_by_sub(text);

create function auth_user_by_sub(p_sub uuid)
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
  where u.id = p_sub
$$;

comment on function auth_user_by_sub(uuid) is
  'Request-chain bootstrap (spec 001 §6.3): resolves the users row for a token subject before app.tenant_id exists. No password material, exact match only.';

revoke all on function auth_user_by_sub(uuid) from public;
grant execute on function auth_user_by_sub(uuid) to talon_app;

-- The unique constraint, its index, and the check constraint go with the column.
alter table users drop column if exists external_id;
