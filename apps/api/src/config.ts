/**
 * Process configuration. Read once at boot; nothing below reads process.env.
 */

export interface CognitoConfig {
  region: string;
  userPoolId: string;
  clientId: string;
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
  const secret = env['TALON_JWT_SECRET']?.trim() ? env['TALON_JWT_SECRET'] : undefined;
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
    auth: {
      cognito,
      secret,
      issuer: env['TALON_JWT_ISSUER'] ?? 'talon-local',
      audience: 'talon-api',
      accessTtlSeconds: 60 * 60,
      expLeewaySeconds: 60,
    },
  };
}
