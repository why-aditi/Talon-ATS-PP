import { createHash, randomBytes } from 'node:crypto';

/**
 * Server-only configuration for the Google hosted-UI flow (spec 004).
 *
 * Everything is read at call time rather than module load, so a missing value is
 * a 404 on the route rather than a boot failure for the whole app — the flow is
 * optional, and the rest of sign-in must keep working without it.
 */
export const ssoConfig = () => {
  const domain = process.env['COGNITO_DOMAIN'];
  const clientId = process.env['COGNITO_CLIENT_ID'];
  const appOrigin = process.env['APP_ORIGIN'];
  if (!domain || !clientId || !appOrigin) return null;
  return {
    domain: domain.replace(/\/$/, ''),
    clientId,
    // Derived from configuration, never from the request Host: Cognito exact-matches
    // this against its allow-list, and taking it from a header would let a spoofed
    // Host send the authorization code somewhere else.
    redirectUri: `${appOrigin.replace(/\/$/, '')}/api/auth/sso/callback`,
  };
};

export const STATE_COOKIE = 'talon_sso_state';
export const VERIFIER_COOKIE = 'talon_sso_verifier';

/** Ten minutes: long enough to pick an account, short enough to be worthless later. */
const TTL = 60 * 10;

export const ssoCookie = (name: string, value: string, maxAge = TTL) =>
  ({
    name,
    value,
    httpOnly: true,
    // Lax, not Strict: the callback is a top-level cross-site GET returning from
    // Cognito, and Strict would strip the cookie exactly when it is needed.
    sameSite: 'lax' as const,
    secure: process.env.NODE_ENV === 'production',
    path: '/api/auth/sso',
    maxAge,
  }) satisfies { name: string; value: string } & Record<string, unknown>;

const base64url = (input: Buffer) => input.toString('base64url');

/**
 * PKCE. The app client carries no secret (spec 002 open question 3), so an
 * intercepted `code` is bearer-equivalent on its own; the verifier is what binds
 * redemption to the browser that started the flow.
 */
export function createPkce(): { verifier: string; challenge: string } {
  const verifier = base64url(randomBytes(32));
  return { verifier, challenge: base64url(createHash('sha256').update(verifier).digest()) };
}

/** 32 random bytes. Without it the callback accepts any code an attacker delivers. */
export const createState = () => base64url(randomBytes(32));

export function authorizeUrl(
  config: NonNullable<ReturnType<typeof ssoConfig>>,
  state: string,
  challenge: string,
): string {
  const params = new URLSearchParams({
    identity_provider: 'Google',
    response_type: 'code',
    client_id: config.clientId,
    redirect_uri: config.redirectUri,
    scope: 'openid email profile',
    state,
    code_challenge: challenge,
    code_challenge_method: 'S256',
  });
  return `${config.domain}/oauth2/authorize?${params.toString()}`;
}

/** Reasons the callback can fail, each mapped to its own copy on the sign-in screen. */
export type SsoFailure = 'cancelled' | 'expired' | 'not_provisioned' | 'failed';
