/**
 * Process configuration. Read once at boot; nothing below reads process.env.
 */

/**
 * Which `IdentityProvider` implementation `modules/identity/container.ts` picks.
 * `local` is the default and stays the default: a clean clone with no AWS
 * account must come up and be signed into.
 */
export type IdentityProviderKind = 'local' | 'cognito';

export interface CognitoConfig {
  region: string;
  userPoolId: string;
  clientId: string;
}

export interface AuthConfig {
  provider: IdentityProviderKind;
  /**
   * Present only when `provider === 'cognito'`, and validated at boot rather
   * than at first sign-in: a pool id typo should stop the process, not turn
   * every login into a 500.
   */
  cognito?: CognitoConfig;
  /**
   * HS256 signing key for Talon's own session tokens. Both providers mint the
   * §6.2 access token with it — Cognito verifies credentials, we issue the
   * session (see `cognito-provider.ts` for why, and for what changes when the
   * pre-token-generation Lambda lands).
   */
  secret: string;
  issuer: string;
  /** Access-token audience. A token with any other `aud` is not a bearer token here. */
  audience: string;
  /** Refresh-token audience — what stops a refresh token being used as a bearer token. */
  refreshAudience: string;
  /** Open question 2: 1h access, 30d refresh, sliding. */
  accessTtlSeconds: number;
  refreshTtlSeconds: number;
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
 * A published constant, so it is worthless as a secret and obviously so. Refused
 * outright when NODE_ENV is production — the same shape as
 * `resolveAppRolePassword` in packages/db: a local clean clone needs no setup, a
 * real deployment fails on the missing configuration rather than on a default.
 */
export const LOCAL_JWT_SECRET = 'talon-local-development-signing-key';

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  if (!value) {
    throw new Error(`${name} must be set when TALON_IDENTITY_PROVIDER=cognito.`);
  }
  return value;
}

/**
 * Anything other than an exact `cognito` is local. Not a "did you mean" —
 * `TALON_IDENTITY_PROVIDER=Cognito` silently falling back to local would be a
 * deployment that thinks it is on AWS and is not, so the value is validated
 * rather than coerced.
 */
function loadIdentityProvider(
  env: NodeJS.ProcessEnv,
): { provider: IdentityProviderKind; cognito?: CognitoConfig } {
  const raw = env['TALON_IDENTITY_PROVIDER'] ?? 'local';
  if (raw === 'local') return { provider: 'local' };
  if (raw !== 'cognito') {
    throw new Error(`TALON_IDENTITY_PROVIDER must be 'local' or 'cognito', got '${raw}'.`);
  }
  // AWS_REGION is what the SDK's own credential chain reads; accepting it means
  // one fewer variable to set in ECS, where the task already has it.
  const region = env['COGNITO_REGION'] ?? env['AWS_REGION'] ?? env['AWS_DEFAULT_REGION'];
  if (!region) {
    throw new Error(
      'COGNITO_REGION (or AWS_REGION) must be set when TALON_IDENTITY_PROVIDER=cognito.',
    );
  }
  return {
    provider: 'cognito',
    cognito: {
      region,
      userPoolId: required(env, 'COGNITO_USER_POOL_ID'),
      clientId: required(env, 'COGNITO_CLIENT_ID'),
    },
  };
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ApiConfig {
  const identity = loadIdentityProvider(env);
  const secretFromEnv = env['TALON_JWT_SECRET'] || undefined;
  // `provider === 'cognito'` is in here alongside production because Cognito
  // does not replace this key — both providers mint the §6.2 bearer token with
  // it (see cognito-provider.ts). A staging deployment pointed at a real user
  // pool with NODE_ENV unset would otherwise sign every token with a constant
  // published in this repository, and anyone could forge one for any tenant and
  // any role. Requiring a real key wherever a real pool is configured costs one
  // environment variable.
  if (!secretFromEnv && (env['NODE_ENV'] === 'production' || identity.provider === 'cognito')) {
    throw new Error(
      'TALON_JWT_SECRET must be set in production and whenever ' +
        'TALON_IDENTITY_PROVIDER=cognito. The built-in key is a published ' +
        'local-development constant and is refused outside development and test.',
    );
  }
  const poolMax = Number(env['API_DB_POOL_MAX'] ?? 10);
  if (!Number.isInteger(poolMax) || poolMax < 1) {
    throw new Error(`API_DB_POOL_MAX must be a positive integer, got ${String(env['API_DB_POOL_MAX'])}`);
  }

  return {
    databaseUrl: env['API_DATABASE_URL'] ?? LOCAL_DATABASE_URL,
    poolMax,
    auth: {
      ...identity,
      secret: secretFromEnv ?? LOCAL_JWT_SECRET,
      issuer: env['TALON_JWT_ISSUER'] ?? 'talon-local',
      audience: 'talon-api',
      refreshAudience: 'talon-refresh',
      accessTtlSeconds: 60 * 60,
      refreshTtlSeconds: 30 * 24 * 60 * 60,
      expLeewaySeconds: 60,
    },
  };
}
