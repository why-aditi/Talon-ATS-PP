-- 0004_users_external_id — spec 002: make the IdentityProvider seam real.
--
-- Spec 001 §6.1 put CognitoIdentityProvider behind the IdentityProvider interface,
-- but nothing could actually be swapped in: the request chain resolves a token
-- subject with auth_user_by_sub(), 0003 typed that parameter `uuid`, and its body
-- matched users.id. Locally the subject IS users.id so that worked. A Cognito sub
-- is a Cognito-allocated UUID that matches no users.id, so every Cognito sign-in
-- would mint a valid token and then 401 `user-not-provisioned` on the next request
-- — and a non-UUID subject (SAML NameID, a future provider) would not even get
-- that far: the repository's `${sub}::uuid` cast raises before the lookup runs.
-- 0003's own comment and apps/api/src/modules/identity/provider.ts both flag this
-- as "a spec 002 migration". This is it.
--
-- A NEW pair, deliberately: _migrations keys on name with no checksum, so editing
-- 0001–0003 in place is a silent no-op against any database that already ran them.
--
-- Runs as the migration role (owner), like every migration here.

-- ── users.external_id ──────────────────────────────────────────────────────
-- The identity provider's subject for this person, or null when there is none.
--
-- text, NOT citext. Cognito subs are lowercase UUIDs, so case-folding would be
-- harmless there — but this column is the join between an external subject and a
-- local principal, and the failure modes are asymmetric. A future SAML persistent
-- NameID is an opaque, case-SENSITIVE string; folding it would let two subjects
-- the IdP considers distinct collide on one users row (and, via the unique index,
-- would reject a legitimate second subject that differs only in case). citext's
-- lower() is also locale-dependent, which is not a property an authentication key
-- should have. Exact bytes, exact match.
--
-- Nullable: every existing row has no external identity, and the whole local
-- provider path (spec 001 §6, local_identities) never gets one. Null means
-- "resolved by users.id", which is exactly what auth_user_by_sub below keys on.
--
-- Unique, and GLOBALLY unique rather than per-tenant: the IdP's subject space is
-- global and the lookup runs BEFORE app.tenant_id exists (§11b), so a per-tenant
-- constraint would permit two tenants to claim one subject and leave the bootstrap
-- lookup ambiguous — i.e. a cross-tenant identity confusion. This mirrors
-- users.email, which 0001 made globally unique for the same reason.
--
-- No index leading with tenant_id is added for it (CLAUDE.md §"tenant-scoped
-- tables"): this column is by construction not looked up within a tenant. users
-- already carries users_tenant_email_idx for the tenant-scoped access paths.
alter table users add column external_id text;

-- '' and whitespace would be a matchable subject that no IdP ever issues, and
-- `external_id = ''` in the lookup below would then resolve a real user for an
-- empty token subject. Make it unrepresentable rather than relying on the
-- function to special-case it.
--
-- The 1024 cap keeps the value comfortably inside btree's ~2704-byte index tuple
-- limit, so an oversized subject fails on a named constraint with a readable
-- message instead of on "index row size exceeds maximum". Generous: a Cognito sub
-- is 36 characters.
alter table users add constraint users_external_id_ck check (
  external_id is null or (btrim(external_id) <> '' and length(external_id) <= 1024)
);

alter table users add constraint users_external_id_key unique (external_id);

comment on column users.external_id is
  'Identity provider subject (Cognito sub, SAML NameID). Null for local-provider users, whose subject is users.id. Globally unique — the IdP subject space is not tenant-scoped.';

-- ── auth_user_by_sub: uuid → text ──────────────────────────────────────────
-- Changing a parameter type is a drop + create, not a replace. No `if exists`:
-- if 0003's function is missing the database has diverged and the whole migration
-- should fail loudly (it runs in one transaction, so it rolls back cleanly).
drop function auth_user_by_sub(uuid);

-- Conventions carried over from 0003 verbatim — stable, security definer,
-- search_path pinned to `pg_catalog, public` (citext's operators live in public),
-- every reference schema-qualified, EXECUTE revoked from PUBLIC and granted only
-- to talon_app. Called before app.tenant_id exists, so it must not and does not
-- depend on RLS context; `security definer` is what lets it read past users'
-- `force row level security` (spec 001 §11b).
--
-- DEVIATION from 0003: language plpgsql, not sql. The function has to try two
-- lookups, and the second one casts p_sub — attacker-controlled text — to uuid.
-- In a `language sql` body those are one query, and SQL guarantees no evaluation
-- order between a regex guard and the cast it is guarding: the planner may fold
-- the cast first and raise 22P02 on a hostile subject, turning what should be a
-- clean 401 into a 500 (and a probe oracle). plpgsql evaluates statements in
-- written order, so the guard actually guards. The alternative that keeps
-- `language sql` — matching `u.id::text = p_sub` — never raises either, but it
-- cannot use the primary key index, and this runs on every authenticated request.
--
-- Resolution order, and why:
--   1. external_id = p_sub. An externally-provisioned user is found by the
--      subject the IdP issued, and by nothing else.
--   2. users.id = p_sub, but ONLY where external_id is null. This is the local
--      provider's path. The `is null` is load-bearing: without it a
--      Cognito-provisioned user would be reachable by two different subjects, so
--      revoking the identity at the IdP would leave the raw users.id still
--      working as a token subject.
-- A match in (1) returns immediately, so the result is at most one row even in
-- the pathological case where one user's external_id equals another's id.
create function auth_user_by_sub(p_sub text)
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

  -- Canonical 8-4-4-4-12 hex only. Postgres' uuid input is laxer (braces, no
  -- hyphens), but our own tokens carry the canonical form, and a lookup key with
  -- more than one spelling is a key that can be smuggled past an equality check
  -- somewhere else later.
  if p_sub ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' then
    return query
      select u.id, u.tenant_id, u.email, u.name, u.role, u.timezone, u.mfa_enabled,
             u.tokens_valid_after
      from public.users u
      where u.id = p_sub::uuid and u.external_id is null;
  end if;

  -- Anything else — null, '', '; drop table users; --', 10KB of noise — falls
  -- through to zero rows. Never an exception: the caller's contract is
  -- "unknown subject", and a raise here would be a 500 on a hostile token.
  return;
end $$;

comment on function auth_user_by_sub(text) is
  'Request-chain bootstrap (spec 001 §6.3, spec 002): resolves the users row for a token subject before app.tenant_id exists. Matches users.external_id, else users.id for local-provider users only. Malformed input returns zero rows, never raises. No password material, exact match only.';

-- CREATE FUNCTION grants EXECUTE to PUBLIC by default; the whole point here is a
-- narrow grant, so take it back first.
revoke all on function auth_user_by_sub(text) from public;
grant execute on function auth_user_by_sub(text) to talon_app;
