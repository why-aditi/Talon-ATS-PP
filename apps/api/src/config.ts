/**
 * Process configuration. Read once at boot; nothing below reads process.env.
 */

export interface AuthConfig {
  /** HS256 signing key for the local provider. Cognito's keys are its own (spec 002). */
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

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ApiConfig {
  const secretFromEnv = env['TALON_JWT_SECRET'] || undefined;
  if (!secretFromEnv && env['NODE_ENV'] === 'production') {
    throw new Error(
      'TALON_JWT_SECRET must be set in production. The built-in key is a published ' +
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
