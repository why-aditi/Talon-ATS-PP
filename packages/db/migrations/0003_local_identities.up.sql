-- 0003_local_identities — spec 001 §6 (step 4): the local IdentityProvider's store,
-- plus the two bootstrap lookups the sign-in path needs before any tenant context
-- exists (§11b).
--
-- Runs as the migration role (owner), like every migration here.

-- ── local_identities ───────────────────────────────────────────────────────
-- This table models what Cognito holds in AWS: credentials, keyed by `sub`,
-- outside the tenant model entirely. Consequences, all deliberate:
--
--   * No tenant_id, therefore no RLS policy. An identity is looked up by email
--     BEFORE a tenant is known — that is the whole point of §11b — so a
--     tenant-scoped policy could only ever evaluate to false here. One email
--     belongs to exactly one tenant (open question 1), so the tenant is derived
--     from the `users` row after the credential check, never from this table.
--   * `sub` is not a foreign key to users(id). The identity provider does not
--     know about our tenants; in AWS this table does not exist at all and `sub`
--     is Cognito's. Locally `sub` IS users.id — see the note on
--     auth_user_by_sub below and the step-4 report: swapping in Cognito needs a
--     `users.external_id` column, which is a spec 002 migration.
--   * password_hash is scrypt (node:crypto), format
--     `scrypt$N=…,r=…,p=…$<salt b64>$<hash b64>`; the app never stores plaintext.
create table local_identities (
  sub uuid primary key,
  email citext not null unique,
  password_hash text not null,
  -- Base32 TOTP secret, null until enrolled. verifyTotp is false for a null.
  totp_secret text,
  totp_enrolled_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint local_identities_totp_ck check (
    (totp_secret is null) = (totp_enrolled_at is null)
  )
);

create trigger trg_local_identities_updated_at before update on local_identities
  for each row execute function set_updated_at();

-- No delete: an identity is disabled by removing the users row (which is what
-- the request chain checks), not by orphaning credentials.
grant select, insert, update on local_identities to talon_app;

-- ── §11b: the sign-in bootstrap ────────────────────────────────────────────
-- Sign-in must read a `users` row before `app.tenant_id` can be set, and users
-- carries `force row level security` with a tenant policy, so the app role sees
-- nothing. The two ways out were a narrowly-granted second connection or a
-- `security definer` function. These are the functions.
--
-- Why this and not a bootstrap connection: a connection is granted a *table*,
-- so it can read every column of every users row for as long as it is held, and
-- nothing in the codebase constrains what is run over it. A function is granted
-- a *result* — one row, by exact key, with a fixed column list that contains no
-- password material and no other tenant's data. It is also impossible to leave
-- open by accident, which the request-chain connection audit (§9 edge case 10)
-- otherwise has to police. The narrowness is asserted in
-- apps/api/test/bootstrap.test.ts.
--
-- Running the request chain itself on the owner connection was never an option:
-- it nullifies RLS for the whole request (§11b).
--
-- `set search_path = pg_catalog, public` is pinned per the usual SECURITY
-- DEFINER hazard, and every reference below is schema-qualified anyway; `public`
-- is present only because citext's operators live there.
--
-- PREREQUISITE: the owner of these functions must be able to bypass RLS —
-- locally and in CI it is the superuser that runs migrations. Under `force row
-- level security` a non-bypassing owner would make these return zero rows, i.e.
-- every sign-in fails closed with "invalid credentials". Loud, not silent, but
-- the Aurora role in spec 002 must carry BYPASSRLS or own an exception policy.

create function auth_user_by_email(p_email citext)
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

-- Called on every authenticated request (resolveTenant) as well as at refresh.
-- p_sub is the token subject; locally that is users.id.
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

-- CREATE FUNCTION grants EXECUTE to PUBLIC by default; the whole point here is a
-- narrow grant, so take it back first.
revoke all on function auth_user_by_email(citext) from public;
revoke all on function auth_user_by_sub(uuid) from public;
grant execute on function auth_user_by_email(citext) to talon_app;
grant execute on function auth_user_by_sub(uuid) to talon_app;
