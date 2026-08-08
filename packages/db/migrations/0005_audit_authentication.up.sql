-- 0005_audit_authentication — CLAUDE.md §4 "every mutation writes to audit_log
-- with actor, before, after, IP, request id", applied to the one mutation that
-- has never obeyed it: sign-in.
--
-- Runs as the migration role (owner), like every migration here.
--
-- ── The problem this exists to solve ───────────────────────────────────────
-- Sign-in happens BEFORE tenant context exists. There is no
-- `openTenantTransaction` for an audit write to ride on, because the tenant is
-- not known until the credential has already been checked — and for a failed
-- attempt it is never known at all. 0001 anticipated exactly this: audit_log's
-- tenant_id is nullable "per ARCHITECTURE §5 (system-level events)", and its
-- comment says such rows are writable only by "the owner (migration role /
-- system writer)". This is that system writer.
--
-- Under audit_log's RLS policy `talon_app` cannot insert a null-tenant row at
-- all: the WITH CHECK expression evaluates to NULL, and only TRUE passes. So the
-- three options were:
--
--   1. A second, owner-privileged connection in the api process. Rejected for
--      spec 001 §11b's reason, which has not changed: a connection is granted a
--      TABLE, so it can write anything to anything for as long as it is held,
--      and `beginTenantTransaction` deliberately refuses to serve a request on a
--      role that bypasses RLS. Handing the request process owner credentials to
--      write an audit row inverts that guarantee to buy a log line.
--   2. Only auditing what a tenant transaction can reach — i.e. successful
--      sign-ins, plus failures for known emails after a lookup. Rejected: it
--      loses the failed attempts for UNKNOWN addresses, which is precisely the
--      shape of a credential-stuffing sweep, and it makes the audit path branch
--      on whether an account exists. A branch there is a timing oracle and, if
--      the null-tenant insert then raises, an error-shaped one.
--   3. A `security definer` writer, granted narrowly. This.
--
-- ── Why this is narrow, in the §11b sense ──────────────────────────────────
-- `talon_app` is not granted "insert into audit_log". It is granted ONE function
-- that can only ever produce one of two rows: `auth.sign_in.succeeded` or
-- `auth.sign_in.failed`, with entity_type fixed to 'authentication', no
-- caller-chosen action, no caller-chosen entity, and no `before` state. The
-- function decides every column the caller does not have a legitimate say in.
-- (`talon_app` retains its 0001 `insert on audit_log` grant for the ordinary
-- in-transaction case, which is unaffected: that path has a tenant.)
--
-- ── What is deliberately NOT recorded ──────────────────────────────────────
-- The password, obviously, and the token. Also the *reason* beyond the RFC 9457
-- `type` the caller was already given: the audit row must not know more about
-- why a sign-in failed than the response did, or the log becomes the oracle the
-- response refuses to be.
--
-- A FAILED attempt is recorded with tenant_id and actor_id NULL, always, even
-- when the address belongs to a real user. Attributing a failure to an account
-- asserts an identity that was never proven, and resolving it would mean an
-- existence-dependent lookup on the failure path. The email as typed is kept, so
-- correlation is still possible offline, by someone who is allowed to do it.

create function audit_sign_in(
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
    -- Not user input: the only callers are in modules/identity. A caller that
    -- gets here is a programming error and should be loud, not silently logged
    -- under a third action name nobody queries.
    raise exception 'audit_sign_in: outcome must be succeeded or failed, got %', p_outcome;
  end if;

  if p_outcome = 'succeeded' and (p_tenant_id is null or p_actor_id is null) then
    -- A successful sign-in resolved a users row by construction. Writing one
    -- without a tenant would hide it from that tenant's own audit trail under
    -- the RLS policy, i.e. lose it in the only place anyone will look.
    raise exception 'audit_sign_in: a succeeded sign-in must carry a tenant and an actor';
  end if;

  -- Fastify's request.ip is the socket peer and always parses; a proxy header
  -- would not be. Never let an unparseable address turn an audit write into a
  -- 500 on the sign-in path — record the row without it.
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
    -- No before-state: authenticating changes no entity. The row records an
    -- event, and `after` is what is known about it.
    null,
    -- `jsonb_strip_nulls` drops `reason` on a success, where there is nothing to
    -- explain. `nullif` is what makes an empty or whitespace-only reason count
    -- as absent rather than as a key with an empty string in it — a shape a
    -- consumer would have to special-case, and eventually would not.
    jsonb_strip_nulls(jsonb_build_object(
      'outcome', p_outcome,
      -- Attacker-controlled, and length-bounded here as well as at the contract
      -- layer (SignInRequestSchema caps email at 320), because this function is
      -- the last thing between that string and permanent storage. Not
      -- null-stripped: "the address typed was empty" is itself a fact worth
      -- keeping, and the contract already refuses it before this is reached.
      'email', left(btrim(coalesce(p_email, '')), 320),
      'reason', nullif(left(btrim(coalesce(p_reason, '')), 128), '')
    )),
    v_ip,
    left(btrim(coalesce(p_request_id, '')), 128)
  );
end $$;

comment on function audit_sign_in(text, text, text, uuid, uuid, text, text) is
  'Writes the one audit_log row a sign-in attempt produces, before any tenant context exists (CLAUDE.md §4, spec 001 §11b). Fixed action and entity_type; failures carry no tenant and no actor; never records a password, a token, or any reason the caller was not already told.';

-- CREATE FUNCTION grants EXECUTE to PUBLIC by default; the whole point here is a
-- narrow grant, so take it back first.
revoke all on function audit_sign_in(text, text, text, uuid, uuid, text, text) from public;
grant execute on function audit_sign_in(text, text, text, uuid, uuid, text, text) to talon_app;
