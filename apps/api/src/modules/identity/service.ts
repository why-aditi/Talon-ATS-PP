/**
 * Orchestration for the auth chain. Provider failures become problem+json here
 * and nowhere else, so every route and hook reports the same taxonomy.
 *
 * Transactions begin here (CLAUDE.md §3): the repository owns the mechanics, the
 * service decides when one opens.
 */
import { ERROR_TYPES, type RefreshResponse, type SignInResponse, type SsoRequest, type SsoResponse } from '@talon/contracts';
import { scopesFor } from '@talon/domain';
import { uuidv7 } from 'uuidv7';
import type { AuthConfig } from '../../config.js';
import { HttpProblem, isHttpProblem } from '../../errors.js';
import type { AuthenticatedUser, TenantTransaction } from '../../request-context.js';
import {
  IdentityFailure,
  isIdentityFailure,
  type IdentityProvider,
  type UnprovisionedSubject,
  type VerifiedIdentity,
} from './provider.js';
import type { IdentityRepository } from './repository.js';
import { isIssuedBeforeInvalidation } from './session.js';

const PROBLEMS: Record<IdentityFailure['code'], { status: number; type: string; title: string }> = {
  invalid_credentials: {
    status: 401,
    type: ERROR_TYPES.INVALID_CREDENTIALS,
    title: 'Invalid credentials',
  },
  user_not_provisioned: {
    status: 401,
    type: ERROR_TYPES.USER_NOT_PROVISIONED,
    title: 'User not provisioned',
  },
  mfa_not_enrolled: { status: 401, type: ERROR_TYPES.MFA_NOT_ENROLLED, title: 'MFA not enrolled' },
  invalid_token: { status: 401, type: ERROR_TYPES.INVALID_TOKEN, title: 'Invalid token' },
  token_expired: { status: 401, type: ERROR_TYPES.TOKEN_EXPIRED, title: 'Token expired' },
  token_not_yet_valid: {
    status: 401,
    type: ERROR_TYPES.TOKEN_NOT_YET_VALID,
    title: 'Token not yet valid',
  },
  token_invalidated: {
    status: 401,
    type: ERROR_TYPES.TOKEN_INVALIDATED,
    title: 'Token invalidated',
  },
  // The two entries here that are not 401. In both, nothing about the caller's
  // credential is wrong, so a 401 would send them to retype a password that was
  // fine — and in the throttling case it would also hide an operational problem
  // behind a user-facing one.
  rate_limited: { status: 429, type: ERROR_TYPES.RATE_LIMITED, title: 'Too many requests' },
  not_implemented: {
    status: 501,
    type: ERROR_TYPES.NOT_IMPLEMENTED,
    title: 'Not implemented',
  },
};

/** Only used if a provider raises `rate_limited` without one. RFC 9110 §10.2.3. */
const DEFAULT_RETRY_AFTER_SECONDS = 5;

/**
 * What the audit row records about the caller rather than the credential
 * (CLAUDE.md §4: actor, before, after, IP, request id). Passed in from the route
 * because a service must not reach for a Fastify request — and because being an
 * explicit parameter is what stops a new caller forgetting it.
 */
export interface AuditContext {
  ip: string | undefined;
  requestId: string | undefined;
}

/** One resolved allow-list entry, for the boot log. See `assertJitPolicy`. */
export interface JitPolicyEntry {
  domain: string;
  tenantId: string;
  tenantName: string;
  role: string;
}

/** `users.email` is citext with no length cap; the sign-in contract caps at 320. Match it. */
const MAX_EMAIL_LENGTH = 320;
/** Nothing enforces a length on `users.name`; a display name is not a document. */
const MAX_NAME_LENGTH = 200;

/**
 * Enough to refuse a claim that has no business becoming a `users.email`, and no
 * more. Full RFC 5322 is not the goal — the address has already been accepted by
 * the identity provider, and this is the last check before it becomes a globally
 * unique key in our table. Whitespace and control characters are refused because
 * citext equality is exact and an address with a stray newline would be a second,
 * near-invisible principal for the same person.
 */
function normaliseEmail(raw: string): string | null {
  const email = raw.trim().toLowerCase();
  if (email === '' || email.length > MAX_EMAIL_LENGTH) return null;
  // `\p{Cc}` is the Unicode control category, so there is no escape to get wrong
  // and no `no-control-regex` suppression to explain. `\s` covers the rest.
  if (/[\s\p{Cc}]/u.test(email)) return null;
  const at = email.indexOf('@');
  if (at <= 0 || at !== email.lastIndexOf('@') || at === email.length - 1) return null;
  return email;
}

/** The allow-list key: everything after the single `@`, lowercased. */
const domainOf = (email: string): string => email.slice(email.indexOf('@') + 1);

/**
 * `IdentityFailure` carrying a verified identity we have no row for — the one
 * error just-in-time provisioning may answer. Anything else, including a
 * `user_not_provisioned` raised without a subject, passes straight through.
 */
function unprovisioned(error: unknown): UnprovisionedSubject | null {
  if (!isIdentityFailure(error)) return null;
  if (error.code !== 'user_not_provisioned') return null;
  return error.subject ?? null;
}

function asProblem(error: unknown): unknown {
  if (!isIdentityFailure(error)) return error;
  const problem = PROBLEMS[error.code];
  if (error.code !== 'rate_limited') {
    return new HttpProblem(problem.status, problem.type, problem.title, error.detail);
  }
  const seconds = error.retryAfterSeconds ?? DEFAULT_RETRY_AFTER_SECONDS;
  return new HttpProblem(
    problem.status,
    problem.type,
    problem.title,
    error.detail,
    // In the body as well as the header. `Retry-After` is not CORS-safelisted,
    // so a browser calling the api cross-origin cannot read it without an
    // explicit `Access-Control-Expose-Headers` — and a 429 whose backoff the
    // client cannot see is a 429 the client retries immediately.
    { retryAfter: seconds },
    { 'Retry-After': String(seconds) },
  );
}

export class IdentityService {
  readonly #provider: IdentityProvider;
  readonly #repository: IdentityRepository;
  readonly #config: AuthConfig;

  constructor({
    identityProvider,
    identityRepository,
    authConfig,
  }: {
    identityProvider: IdentityProvider;
    identityRepository: IdentityRepository;
    authConfig: AuthConfig;
  }) {
    this.#provider = identityProvider;
    this.#repository = identityRepository;
    this.#config = authConfig;
  }

  /**
   * Sign-in, and the one audit_log row it produces (CLAUDE.md §4).
   *
   * The audit write is deliberately NOT inside a `try`. Every mutation writes to
   * `audit_log`, and a sign-in that cannot be recorded must not mint a session:
   * an attacker who can break the audit path must not thereby get an unlogged
   * one. On the success path the token has already been minted when the write
   * runs, but it has not been *returned* — a JWT nobody was handed is inert.
   *
   * The failure path writes first and then rethrows the original problem, so a
   * broken audit path turns every 401 into a 500 rather than some of them. That
   * uniformity is the point: nothing in the audit call depends on whether the
   * address exists, so it cannot become the enumeration oracle `signIn` itself
   * is careful not to be.
   */
  async signIn(
    input: { email: string; password: string },
    context: AuditContext,
  ): Promise<SignInResponse> {
    let result;
    try {
      result = await this.#run(() =>
        // Inside the `try`, so a provisioning failure is audited as a failed
        // sign-in like any other — and outside `#run`'s conversion, so the
        // `IdentityFailure` still carries the verified subject when
        // `#provisionOnDemand` inspects it.
        this.#provisionOnDemand(context, () =>
          this.#provider.initiatePasswordAuth(input.email, input.password),
        ),
      );
      if (result.status === 'mfa_required') {
        // No MFA challenge endpoint in M0a — there is no screen for it and
        // inventing the exchange now would fix a contract nobody has specced.
        // The seeded users have mfa_enabled = false; this is the fail-closed
        // branch, and an incomplete sign-in is a failed one for audit purposes.
        throw new HttpProblem(
          401,
          ERROR_TYPES.MFA_REQUIRED,
          'MFA required',
          'This account requires a one-time code, which this release cannot collect.',
        );
      }
    } catch (err) {
      await this.#auditSignIn('failed', input.email, context, {
        // The `type` the caller is about to receive, and nothing beyond it. A
        // log that knows more about why a sign-in failed than the response did
        // is the oracle the response was written to avoid.
        // Branded, not `instanceof`: the audit row and the response must not be
        // able to disagree about why a sign-in failed, and a class-identity
        // check is the one way this could answer differently from `render`.
        reason: isHttpProblem(err) ? err.type : ERROR_TYPES.INTERNAL,
        tenantId: null,
        actorId: null,
      });
      throw err;
    }

    await this.#auditSignIn('succeeded', input.email, context, {
      reason: null,
      // Only a successful sign-in names a tenant and an actor. Attributing a
      // failed attempt to an account would assert an identity nobody proved,
      // and resolving one would mean an existence-dependent lookup on the
      // failure path.
      tenantId: result.user.tenantId,
      actorId: result.user.id,
    });
    return { ...result.tokens, user: result.user };
  }

  async refresh(input: { refreshToken: string }, context: AuditContext): Promise<RefreshResponse> {
    const result = await this.#run(() =>
      this.#provisionOnDemand(context, () => this.#provider.refreshSession(input.refreshToken)),
    );
    if (result.status === 'mfa_required') {
      throw new HttpProblem(401, ERROR_TYPES.MFA_REQUIRED, 'MFA required');
    }
    return { ...result.tokens, user: result.user };
  }

  /**
   * Federated sign-in (spec 004 §11.4). `#run` maps `IdentityFailure` to problem+json,
   * so the failure table in §11.6 needs no per-call handling — including the row that
   * matters most: a verified Google identity with no `users` row answers
   * `user_not_provisioned`, not a generic failure. "Your Google sign-in worked; this
   * workspace has no account for you" and "sign-in failed" send a person to do
   * completely different things, and only one of them can succeed.
   *
   * With `TALON_JIT_PROVISION` configured for their email domain, that answer
   * becomes "…so here is your account" instead — this is the path the feature
   * exists for, because a Google identity has no other way into the system.
   */
  async signInWithSso(input: SsoRequest, context: AuditContext): Promise<SsoResponse> {
    const result = await this.#run(() =>
      this.#provisionOnDemand(context, () =>
        this.#provider.exchangeIdToken(input.idToken, input.refreshToken),
      ),
    );
    if (result.status === 'mfa_required') {
      // Unreachable today: MFA is enforced at the IdP for a federated identity and
      // Cognito does not re-challenge one. Handled rather than asserted away, because
      // `AuthResult` is a union and narrowing it by assertion is how the branch that
      // eventually happens goes unnoticed.
      throw new HttpProblem(401, ERROR_TYPES.MFA_REQUIRED, 'MFA required');
    }
    return { ...result.tokens, user: result.user };
  }

  /** Signature, audience, issuer, expiry. Used by the `authenticate` hook. */
  async verifyAccessToken(token: string): Promise<VerifiedIdentity> {
    return this.#run(() => this.#provider.verifyToken(token));
  }

  /**
   * Loads the `users` row for a verified token — the `resolveTenant` hook.
   *
   * The database is authoritative: a role changed since the token was issued
   * takes effect now, not at expiry. A `tenant_id` that disagrees with the token
   * is not a stale claim but a broken one, and is refused.
   *
   * ── Deliberately NOT a just-in-time provisioning point ────────────────────
   * Every other path that resolves a subject will create the row if the
   * allow-list says so. This one will not, and the asymmetry is the point.
   *
   * The token here is TALON's own §6.2 access token, not the identity provider's
   * — `authenticate` has already verified it against our signing key. Such a
   * token can only exist because a sign-in already succeeded, which means the
   * `users` row already existed when it was minted. Reaching this branch
   * therefore means the row was DELETED mid-session, and re-creating it from
   * config would make deleting a person a no-op for up to an access-token
   * lifetime — the removal would appear to work and silently not.
   *
   * It would also be incoherent: the token already asserts `tenant_id` and
   * `role`, and the check below compares them against the row. A row invented
   * here would be compared against claims derived from the row it replaced.
   */
  async resolveAuthenticatedUser(identity: VerifiedIdentity): Promise<AuthenticatedUser> {
    const user = await this.#repository.findUserBySub(identity.sub);
    if (!user) {
      // §9 edge case 1 — valid token, nobody to be. Distinct type, not a crash.
      throw new HttpProblem(
        401,
        ERROR_TYPES.USER_NOT_PROVISIONED,
        'User not provisioned',
        'This identity is authenticated but has no user record in this deployment.',
      );
    }
    if (isIssuedBeforeInvalidation(user.tokensValidAfter, identity.claims.iat)) {
      // Claims are embedded in the token, so revoking a role cannot wait for
      // expiry. `tokens_valid_after` is the pre-expiry invalidation switch, and
      // the predicate lives in `session.ts` so that sign-in, refresh and this
      // hook cannot drift apart — they did, and the result was a 200 followed
      // immediately by a 401.
      throw new HttpProblem(
        401,
        ERROR_TYPES.TOKEN_INVALIDATED,
        'Token invalidated',
        'This token was issued before the account was invalidated.',
      );
    }
    if (user.tenantId !== identity.claims.tenant_id) {
      throw new HttpProblem(
        401,
        ERROR_TYPES.INVALID_TOKEN,
        'Invalid token',
        'The token does not match the tenant of its subject.',
      );
    }
    return {
      id: user.id,
      tenantId: user.tenantId,
      email: user.email,
      name: user.name,
      role: user.role,
      timezone: user.timezone,
      scopes: scopesFor(user.role),
    };
  }

  async openTenantTransaction(tenantId: string, userId: string): Promise<TenantTransaction> {
    return this.#repository.beginTenantTransaction(tenantId, userId);
  }

  /**
   * Creates or replaces the credential at the identity provider and returns the
   * subject it allocated. There is no self-service sign-up in M0a; this exists
   * for operator provisioning (`scripts/seed-identities.ts`) and for the test
   * fixtures that need a seeded person to be able to sign in.
   *
   * The caller is responsible for the second half — writing the returned subject
   * to `users.external_id`. That write is deliberately not here: it needs RLS
   * bypass, and the request process must not have it (spec 001 §11b).
   */
  async provisionCredential(input: { email: string; password: string }): Promise<{ sub: string }> {
    return this.#run(() => this.#provider.createUser(input));
  }

  // ── just-in-time provisioning ─────────────────────────────────────────────

  /**
   * Boot gate for `TALON_JIT_PROVISION`. Called from `buildApp`, before the
   * server listens.
   *
   * `loadConfig` already refuses a policy it cannot parse; this refuses one that
   * parses but names a tenant that is not there. The alternative is discovering
   * it at somebody's first sign-in, which is both the worst moment and the
   * hardest place to see it — the person just gets the 401 the feature was
   * turned on to remove, and nothing says why.
   *
   * Returns one entry per allow-listed domain, resolved, so the caller can log
   * exactly what has been opened. That log line is not decoration: with
   * `allow_admin_create_user_only = false` on the pool, an allow-listed domain
   * means *anyone who can receive mail at that domain* becomes a user with the
   * configured role, and for a consumer domain like gmail.com that is everyone.
   * An operator should be able to read the door's width off the boot log.
   */
  async assertJitPolicy(): Promise<JitPolicyEntry[]> {
    const entries: JitPolicyEntry[] = [];
    for (const [domain, grant] of this.#config.jit) {
      // No principal: this runs before any request and creates nothing.
      const tx = await this.#repository.beginTenantTransaction(grant.tenantId, null);
      let tenant;
      try {
        tenant = await this.#repository.findTenantSelf(tx);
      } finally {
        // Read-only, so roll back rather than commit — a boot check should not
        // be able to leave anything behind even in principle.
        await tx.rollback();
      }
      if (!tenant) {
        throw new Error(
          `TALON_JIT_PROVISION names tenant ${grant.tenantId} for "${domain}", ` +
            'and no such tenant exists. Fix the uuid or unset the variable; ' +
            'a deployment that starts with an unresolvable allow-list would 401 ' +
            'exactly the people it was configured to admit.',
        );
      }
      entries.push({ domain, tenantId: tenant.id, tenantName: tenant.name, role: grant.role });
    }
    return entries;
  }

  /**
   * Runs an auth operation; if it fails only because this deployment has no
   * `users` row for the identity the provider just verified, creates that row
   * when the allow-list says to, and runs the operation once more.
   *
   * ── Why a retry rather than a hook inside the provider ────────────────────
   * The provider is the layer that turns a credential into a verified subject,
   * and it holds the `users` lookup because it needs the row to mint a session.
   * Provisioning is a *policy* decision plus a *write*, and CLAUDE.md §3 puts
   * both in `service.ts`: transactions begin here, never in a repository, a
   * route, or an adapter. Threading a provisioning callback into
   * `CognitoIdentityProvider` would have moved a transaction into the adapter;
   * injecting this service into it would have made the container circular. So
   * the provider reports what it verified, this decides, and the operation runs
   * again with the row in place.
   *
   * Exactly once. Not a loop and not a `while` with a bound: if the second
   * attempt still says "no user", something is wrong with the row we just wrote
   * and retrying forever would turn that bug into a hot loop against Cognito.
   *
   * The second attempt costs one extra `AdminInitiateAuth` on the password and
   * refresh paths (the federated path re-verifies against a cached JWKS and
   * calls no AWS API). That happens at most once per person, ever — the first
   * time they sign in — which is a price worth paying for keeping the write out
   * of the adapter.
   *
   * With the allow-list empty this is a single `catch`/`rethrow` and nothing
   * else: no query, no transaction, no behaviour change at all.
   */
  async #provisionOnDemand<T>(context: AuditContext, operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch (err) {
      if (this.#config.jit.size === 0) throw err;
      const subject = unprovisioned(err);
      if (!subject) throw err;
      if (!(await this.#provision(subject, context))) throw err;
      return operation();
    }
  }

  /**
   * Creates the `users` row for a verified identity whose email domain is
   * allow-listed. Returns false when the allow-list does not cover them, when
   * the token carried no usable email, or when the address already belongs to
   * somebody else — in every one of those cases the caller rethrows the original
   * `user_not_provisioned`, so the response is byte-identical to the one this
   * deployment gave before the feature existed. A caller cannot tell which
   * branch they hit, which is deliberate: "your domain is not on the list" and
   * "that address is taken" are both facts about our configuration and our user
   * table, and neither is owed to an unauthenticated stranger.
   *
   * ── The existing-email decision: REFUSE, never link ───────────────────────
   * If a `users` row already holds this address with a different (or null)
   * `external_id`, this does NOT adopt it. Linking would mean that anyone who
   * can get the identity provider to assert `alice@allowed.com` — a new Google
   * Workspace account at a domain the operator once allow-listed, a self-signup
   * at a pool with `allow_admin_create_user_only = false` — inherits Alice's
   * existing row, her tenant, her role and everything attributed to her. That is
   * an account takeover reachable from outside, traded for saving an operator
   * one command. `link:federated` exists for the legitimate case and is
   * deliberately an operator act on the owner connection.
   */
  async #provision(subject: UnprovisionedSubject, context: AuditContext): Promise<boolean> {
    const email = normaliseEmail(subject.email);
    // No email claim, or one that cannot be a `users.email`. Nothing to key an
    // allow-list on, so nothing to do — 401, exactly as before.
    if (!email) return false;
    const grant = this.#config.jit.get(domainOf(email));
    if (!grant) return false;

    // Generated here, before the insert, because it is also `app.user_id` on the
    // transaction and the `actor_id` on the audit row: the person is the actor
    // in their own creation. UUIDv7 — spec §5.2, ascending id is creation order
    // and the jobs list already reads it that way.
    const id = uuidv7();
    const name = (subject.name ?? '').trim().slice(0, MAX_NAME_LENGTH) || email.slice(0, email.indexOf('@'));

    const tx = await this.#repository.beginTenantTransaction(grant.tenantId, id);
    try {
      const created = await this.#repository.insertProvisionedUser(tx, {
        id,
        email,
        name,
        role: grant.role,
        externalId: subject.sub,
      });

      if (!created) {
        // Something already occupied `email` or `external_id`. Two very
        // different worlds, told apart by re-reading the SUBJECT (not the
        // address) inside this tenant:
        //
        //   - a row is there for this subject → we lost a race with a concurrent
        //     first request from the same person. That is the idempotent
        //     outcome the constraint exists to produce: one row, both requests
        //     proceed. (READ COMMITTED gives this statement a fresh snapshot, so
        //     it sees the winner's commit; `on conflict do nothing` has already
        //     waited on its speculative-insertion lock.)
        //   - nothing → the conflict was on the ADDRESS, belonging to a
        //     different identity or to another tenant. Refuse. See the header.
        const existing = await this.#repository.findUserByExternalId(tx, subject.sub);
        await tx.rollback();
        return existing !== null;
      }

      // Same transaction as the row it describes, so it commits with it or not
      // at all (CLAUDE.md §4 — every mutation writes to audit_log, and a person
      // appearing in a tenant is exactly that).
      await this.#repository.recordUserProvisioned(tx, {
        userId: created.id,
        after: {
          email: created.email,
          name: created.name,
          role: created.role,
          // The IdP subject this row is joined to. Not a secret — it is the
          // `sub` of every token this person will ever present — and without it
          // the row cannot answer "which identity became this user".
          externalId: subject.sub,
          source: 'jit',
          // The allow-list entry that authorised it. The configuration can
          // change; the audit row should still say what the rule was.
          matchedDomain: domainOf(email),
        },
        ip: context.ip ?? null,
        requestId: context.requestId ?? null,
      });
      await tx.commit();
      return true;
    } catch (err) {
      await tx.rollback();
      // Deliberately not swallowed into a 401. A provisioning path that is
      // failing — a lost database, a constraint nobody expected — must be loud;
      // degrading it to "no account for you" would hide an outage behind a
      // message that sends people to ask an administrator for something they
      // already have.
      throw err;
    }
  }

  async #run<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch (err) {
      throw asProblem(err);
    }
  }

  async #auditSignIn(
    outcome: 'succeeded' | 'failed',
    email: string,
    context: AuditContext,
    attribution: { reason: string | null; tenantId: string | null; actorId: string | null },
  ): Promise<void> {
    await this.#repository.recordSignIn({
      outcome,
      email,
      ip: context.ip ?? null,
      requestId: context.requestId ?? null,
      ...attribution,
    });
  }
}
