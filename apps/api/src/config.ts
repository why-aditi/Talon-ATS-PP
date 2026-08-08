/**
 * Process configuration. Read once at boot; nothing below reads process.env.
 */
import { isRole, ROLES, type Role } from '@talon/domain';

export interface CognitoConfig {
  region: string;
  userPoolId: string;
  clientId: string;
}

/** What an allow-listed email domain buys: a tenant to land in and a role to land as. */
export interface JitGrant {
  /**
   * A tenant UUID, NOT a name or a slug, and that is forced rather than chosen.
   *
   * `tenants` carries `force row level security` with the policy
   * `id = current_setting('app.tenant_id')` — 0001 says so in as many words:
   * "Cross-tenant lookup (e.g. slug → tenant at sign-in) is the owner's job, not
   * the app role's." The api connects as `talon_app` and
   * `beginTenantTransaction` refuses to serve a request on any role that can
   * bypass RLS, so `select id from tenants where slug = ?` returns zero rows
   * here no matter how it is spelled. Resolving a name would need a new
   * `security definer` reader — a migration, which this change does not own and
   * was explicitly told not to add.
   *
   * A UUID needs no lookup: `SET LOCAL app.tenant_id = <uuid>` and then
   * `select … from tenants where id = <uuid>` is a *self*-read the policy
   * already permits, which is exactly how the boot check confirms the tenant
   * exists (and reads its name back, so an operator can eyeball the log line).
   */
  tenantId: string;
  role: Role;
}

/**
 * Email domain (lowercased, no `@`) → what a new person from it gets.
 *
 * EMPTY MEANS OFF, and empty is the default. Auto-provisioning any authenticated
 * identity is an open door: the pool's Google IdP will authenticate *any* Google
 * account, and the pool's own `allow_admin_create_user_only = false` means anyone
 * who can receive mail at an address can sign themselves up. With this map empty
 * the auth paths behave byte-identically to before this feature existed, 401
 * `user-not-provisioned` included.
 */
export type JitPolicy = ReadonlyMap<string, JitGrant>;

/**
 * Domain labels, conservatively. No wildcard, no leading dot, no `@`, at least
 * one dot — `TALON_JIT_PROVISION="com=…"` or `"*=…"` is a typo that would widen
 * the door to most of the internet, so it stops the process instead.
 */
const DOMAIN_PATTERN = /^(?!-)[a-z0-9-]{1,63}(?<!-)(\.(?!-)[a-z0-9-]{1,63}(?<!-))+$/;

/** Canonical 8-4-4-4-12 only, matching `auth_user_by_sub`'s guard in migration 0004. */
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const JIT_SYNTAX =
  'TALON_JIT_PROVISION is a comma-separated list of ' +
  '`<email-domain>=<tenant-uuid>:<role>`, e.g. ' +
  '"taloninc.com=018f2c31-0000-7000-8000-000000000001:recruiter". ' +
  `Roles: ${ROLES.join(', ')}. Unset or empty disables just-in-time provisioning.`;

function jitError(entry: string, why: string): Error {
  // The offending entry is echoed because this is operator configuration read
  // from the process environment, not caller input — a boot failure that does
  // not say which entry is wrong is a boot failure someone works around by
  // deleting the whole variable.
  return new Error(`TALON_JIT_PROVISION: ${why} in "${entry}". ${JIT_SYNTAX}`);
}

/**
 * Parses the allow-list, and refuses anything it cannot read exactly.
 *
 * Deliberately unforgiving. The two failure modes that must not happen are
 * "a typo silently disabled the feature" (an operator then believes people are
 * being provisioned when they are not) and "a typo silently widened it" (a
 * mistyped domain or a role that fell back to a default). Both become a process
 * that will not start, which is the only outcome that cannot be missed.
 *
 * Exported for the config tests: this is the whole security boundary of the
 * feature, so it is tested as a pure function rather than only end to end.
 */
export function parseJitPolicy(raw: string | undefined): JitPolicy {
  const value = raw?.trim() ?? '';
  if (value === '') return new Map();

  const policy = new Map<string, JitGrant>();
  // A trailing or doubled comma is a typo that cannot widen or narrow anything,
  // so it is skipped rather than fatal. Everything else is fatal.
  const entries = value.split(',').map((entry) => entry.trim()).filter((entry) => entry !== '');
  if (entries.length === 0) throw new Error(`TALON_JIT_PROVISION has no entries. ${JIT_SYNTAX}`);

  for (const entry of entries) {
    const parts = entry.split('=');
    if (parts.length !== 2) throw jitError(entry, 'expected exactly one "="');
    const [rawDomain = '', grant = ''] = parts;
    const target = grant.split(':');
    if (target.length !== 2) throw jitError(entry, 'expected exactly one ":" after the "="');
    const [tenantId = '', role = ''] = target.map((part) => part.trim());

    const domain = rawDomain.trim().toLowerCase();
    if (!DOMAIN_PATTERN.test(domain)) throw jitError(entry, `"${domain}" is not an email domain`);
    if (policy.has(domain)) throw jitError(entry, `"${domain}" is listed twice`);
    if (!UUID_PATTERN.test(tenantId)) {
      throw jitError(entry, `"${tenantId}" is not a tenant UUID (a name or slug will not resolve)`);
    }
    if (!isRole(role)) throw jitError(entry, `"${role}" is not a role`);

    // Lowercased so the map key matches the lookup, which lowercases the domain
    // off the verified email. `users.email` is citext and DNS is case-insensitive;
    // a case-sensitive allow-list would refuse @TalonInc.com and nobody would
    // guess why.
    policy.set(domain, { tenantId: tenantId.toLowerCase(), role });
  }
  return policy;
}

export interface AuthConfig {
  /**
   * Cognito is the only identity provider (spec 002 open question 1, answered
   * "Cognito only"). Required, never optional and never defaulted: a missing
   * pool id has to stop the process, because the only alternative to a real
   * pool is no authentication at all.
   */
  cognito: CognitoConfig;
  /**
   * HS256 signing key for Talon's own session tokens. Cognito verifies the
   * credential, we mint the §6.2 access token with this key (see
   * `cognito-provider.ts` for why, and for what changes when the
   * pre-token-generation Lambda lands).
   */
  secret: string;
  issuer: string;
  /** Access-token audience. A token with any other `aud` is not a bearer token here. */
  audience: string;
  /** Open question 2: 1h access token. The refresh token is Cognito's, not ours. */
  accessTtlSeconds: number;
  /** Spec 001 §9 edge case 9: 60s of leeway on `exp`, none on a future `iat`. */
  expLeewaySeconds: number;
  /**
   * Just-in-time user provisioning, keyed by email domain. Empty = off, and off
   * is the default and the only safe default. See `JitPolicy`.
   */
  jit: JitPolicy;
}

export interface ApiConfig {
  /**
   * Deliberately NOT `DATABASE_URL`: that variable points at the owner/migration
   * role in this repo (packages/db), and the api must connect as a role that
   * cannot bypass RLS. Sharing the name is how a service ends up running as the
   * owner and quietly nullifying every policy (spec 001 §11b).
   */
  databaseUrl: string;
  poolMax: number;
  auth: AuthConfig;
  calendar?: { url: string; username: string; password: string };
}

const LOCAL_DATABASE_URL = 'postgres://talon_app:talon_app@localhost:5432/talon';

/**
 * A published constant, so it is worthless as a secret and obviously so. It is
 * no longer a fallback — nothing defaults to it — but it stays here as a
 * BLOCKLIST entry: an operator who copied it out of an old `.env` or out of this
 * file's history must be refused rather than quietly accepted. See `loadConfig`.
 */
export const LOCAL_JWT_SECRET = 'talon-local-development-signing-key';

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]?.trim();
  if (!value) {
    throw new Error(
      `${name} must be set. Cognito is the only identity provider (spec 002 open ` +
        'question 1); there is no local fallback to degrade to.',
    );
  }
  return value;
}

/**
 * Cognito, or nothing.
 *
 * `TALON_IDENTITY_PROVIDER` survives the removal of `LocalIdentityProvider`
 * only so that a stale `TALON_IDENTITY_PROVIDER=local` in somebody's `.env`
 * fails loudly instead of being ignored. Ignoring it would silently give that
 * operator a Cognito deployment while their configuration says otherwise, which
 * is the same class of mistake the old "anything that is not `cognito` is
 * local" coercion was written to avoid — just pointing the other way.
 */
function loadCognito(env: NodeJS.ProcessEnv): CognitoConfig {
  const raw = env['TALON_IDENTITY_PROVIDER'];
  if (raw !== undefined && raw !== 'cognito') {
    throw new Error(
      `TALON_IDENTITY_PROVIDER must be 'cognito' or unset, got '${raw}'. ` +
        'LocalIdentityProvider was removed (spec 002 open question 1).',
    );
  }
  // AWS_REGION is what the SDK's own credential chain reads; accepting it means
  // one fewer variable to set in ECS, where the task already has it.
  const region = (
    env['COGNITO_REGION'] ??
    env['AWS_REGION'] ??
    env['AWS_DEFAULT_REGION'] ??
    ''
  ).trim();
  if (!region) {
    throw new Error('COGNITO_REGION (or AWS_REGION) must be set — Cognito is the only provider.');
  }
  return {
    region,
    userPoolId: required(env, 'COGNITO_USER_POOL_ID'),
    clientId: required(env, 'COGNITO_CLIENT_ID'),
  };
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ApiConfig {
  const cognito = loadCognito(env);
  // Cognito does not replace this key — it proves the credential, we issue the
  // session (see cognito-provider.ts). A deployment pointed at a real user pool
  // that signed every token with a constant published in this repository would
  // let anyone forge one for any tenant and any role.
  //
  // Value, not presence. A guard that only checks "is something set" is
  // satisfied by an operator pasting the constant they found in this file or in
  // an old .env — which is the exact outcome it exists to prevent, and it would
  // read as configured. Whitespace is treated as unset for the same reason.
  // Trimmed BEFORE the blocklist compares, not after. Testing `.trim()` for
  // truthiness while assigning the raw value let `<constant>\n` through — and a
  // trailing newline is the most common way this variable gets set (a .env file,
  // `echo >>`, a multi-line Secrets Manager value). The result booted as
  // "configured" and signed every §6.2 token with a one-character variant of a
  // constant published in this repository, which is a forged admin token for any
  // tenant to anyone who tries the obvious padded variants.
  const secret = env['TALON_JWT_SECRET']?.trim() || undefined;
  if (!secret || secret === LOCAL_JWT_SECRET) {
    throw new Error(
      'TALON_JWT_SECRET must be set to a real value. The built-in key is a ' +
        'published local-development constant and is refused, including when it ' +
        'is supplied explicitly.',
    );
  }
  const poolMax = Number(env['API_DB_POOL_MAX'] ?? 10);
  if (!Number.isInteger(poolMax) || poolMax < 1) {
    throw new Error(
      `API_DB_POOL_MAX must be a positive integer, got ${String(env['API_DB_POOL_MAX'])}`,
    );
  }

  return {
    databaseUrl: env['API_DATABASE_URL'] ?? LOCAL_DATABASE_URL,
    poolMax,
    calendar: {
      url: env['RADICALE_URL'] ?? 'http://localhost:5232',
      username: env['RADICALE_USERNAME'] ?? 'talon',
      password: env['RADICALE_PASSWORD'] ?? 'talon',
    },
    auth: {
      cognito,
      secret,
      issuer: env['TALON_JWT_ISSUER'] ?? 'talon-local',
      audience: 'talon-api',
      accessTtlSeconds: 60 * 60,
      expLeewaySeconds: 60,
      jit: parseJitPolicy(env['TALON_JIT_PROVISION']),
    },
  };
}
