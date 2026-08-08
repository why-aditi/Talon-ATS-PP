import { ERROR_TYPES } from '@talon/contracts';
import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { STATE_COOKIE, VERIFIER_COOKIE, authorizeUrl, createPkce, createState, ssoCookie, ssoConfig } from '../lib/sso';

/*
  Spec 004 §8. The route handlers are server-side, so what is asserted here is the
  request Talon builds and the request it refuses to build — the two places a
  mistake is a security bug rather than a broken button.
*/

const ENV = {
  COGNITO_DOMAIN: 'https://talon-dev.auth.eu-west-1.amazoncognito.com',
  COGNITO_CLIENT_ID: 'client-abc',
  APP_ORIGIN: 'https://app.talon.test',
};

/** The jar the mocked `next/headers` hands back; each test sets what it holds. */
const jar = { current: new Map<string, string>() };
vi.mock('next/headers', () => ({
  cookies: () => Promise.resolve({ get: (name: string) => { const value = jar.current.get(name); return value === undefined ? undefined : { name, value }; } }),
}));

beforeEach(() => {
  for (const [key, value] of Object.entries(ENV)) vi.stubEnv(key, value);
  jar.current = new Map();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('ssoConfig', () => {
  it('is null unless every value is set, so a half-configured pool cannot be used', () => {
    vi.stubEnv('COGNITO_CLIENT_ID', '');
    expect(ssoConfig()).toBeNull();
  });

  it('derives redirect_uri from APP_ORIGIN, not from the request', () => {
    expect(ssoConfig()?.redirectUri).toBe('https://app.talon.test/api/auth/sso/callback');
  });

  it('tolerates a trailing slash on either value', () => {
    vi.stubEnv('COGNITO_DOMAIN', `${ENV.COGNITO_DOMAIN}/`);
    vi.stubEnv('APP_ORIGIN', `${ENV.APP_ORIGIN}/`);
    const config = ssoConfig();
    expect(config?.domain).toBe(ENV.COGNITO_DOMAIN);
    expect(config?.redirectUri).toBe('https://app.talon.test/api/auth/sso/callback');
  });
});

describe('authorizeUrl', () => {
  it('asks Cognito for Google, a code, and S256 PKCE', () => {
    const url = new URL(authorizeUrl(ssoConfig()!, 'the-state', 'the-challenge'));
    expect(url.origin + url.pathname).toBe(`${ENV.COGNITO_DOMAIN}/oauth2/authorize`);
    expect(Object.fromEntries(url.searchParams)).toEqual({
      identity_provider: 'Google',
      response_type: 'code',
      client_id: 'client-abc',
      redirect_uri: 'https://app.talon.test/api/auth/sso/callback',
      scope: 'openid email profile',
      state: 'the-state',
      code_challenge: 'the-challenge',
      code_challenge_method: 'S256',
    });
  });
});

describe('createPkce', () => {
  it('publishes the sha256 of the verifier, never the verifier itself', () => {
    const { verifier, challenge } = createPkce();
    expect(challenge).toBe(createHash('sha256').update(verifier).digest('base64url'));
    expect(challenge).not.toBe(verifier);
  });

  it('is fresh per call', () => {
    expect(createPkce().verifier).not.toBe(createPkce().verifier);
    expect(createState()).not.toBe(createState());
  });
});

describe('ssoCookie', () => {
  it('is httpOnly and lax — Strict would be stripped on the return leg', () => {
    const cookie = ssoCookie(STATE_COOKIE, 'value');
    expect(cookie).toMatchObject({ httpOnly: true, sameSite: 'lax', path: '/api/auth/sso' });
  });
});

/**
 * Read what the browser is actually told. The handlers are typed as returning a
 * plain `Response`, and asserting on the header rather than Next's cookie jar is
 * also what catches a flag (`HttpOnly`) that the jar would let us assume.
 */
function cookie(response: Response, name: string): { value: string; raw: string } | null {
  const raw = response.headers.getSetCookie().find((entry) => entry.startsWith(`${name}=`));
  if (!raw) return null;
  const end = raw.indexOf(';');
  return { value: raw.slice(name.length + 1, end === -1 ? undefined : end), raw };
}

describe('GET /api/auth/sso/google', () => {
  it('404s when no pool is configured rather than redirecting somewhere useless', async () => {
    vi.stubEnv('COGNITO_DOMAIN', '');
    const { GET } = await import('../app/api/auth/sso/google/route');
    expect((await GET()).status).toBe(404);
  });

  it('redirects to Cognito and remembers the state and verifier', async () => {
    const { GET } = await import('../app/api/auth/sso/google/route');
    const response = await GET();

    const location = new URL(response.headers.get('location')!);
    const state = cookie(response, STATE_COOKIE)?.value;
    const verifier = cookie(response, VERIFIER_COOKIE)?.value;

    expect(state).toBeTruthy();
    // Neither may be readable by script: the verifier is the only thing binding
    // the exchange to this browser, and the state is the only thing binding the
    // callback to a flow Talon started.
    expect(cookie(response, VERIFIER_COOKIE)?.raw).toContain('HttpOnly');
    expect(location.searchParams.get('state')).toBe(state);
    // The challenge on the wire has to match the verifier held back, or Cognito
    // rejects the exchange and the flow fails at its very last step.
    expect(location.searchParams.get('code_challenge')).toBe(createHash('sha256').update(verifier!).digest('base64url'));
  });
});

describe('GET /api/auth/sso/callback', () => {
  const callback = (query: string) => new Request(`https://app.talon.test/api/auth/sso/callback?${query}`);
  const reason = (response: Response) => new URL(response.headers.get('location')!).searchParams.get('sso');

  it('refuses a mismatched state without contacting Cognito', async () => {
    jar.current.set(STATE_COOKIE, 'the-real-state');
    jar.current.set(VERIFIER_COOKIE, 'the-verifier');
    const fetchSpy = vi.spyOn(globalThis, 'fetch');

    const { GET } = await import('../app/api/auth/sso/callback/route');
    const response = await GET(callback('code=attacker-code&state=forged'));

    // The whole point of `state`: an unverified callback must not be exchanged.
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(reason(response)).toBe('expired');
  });

  it('refuses a callback with no state cookie at all', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const { GET } = await import('../app/api/auth/sso/callback/route');
    expect(reason(await GET(callback('code=c&state=s')))).toBe('expired');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('reads a cancelled sign-in as cancelled, not as a failure', async () => {
    const { GET } = await import('../app/api/auth/sso/callback/route');
    expect(reason(await GET(callback('error=access_denied')))).toBe('cancelled');
    expect(reason(await GET(callback('error=server_error')))).toBe('failed');
  });

  it('clears the single-use cookies on every failure path', async () => {
    const { GET } = await import('../app/api/auth/sso/callback/route');
    const response = await GET(callback('error=access_denied'));
    // A state that survives a failure is a state an attacker gets to retry against.
    for (const name of [STATE_COOKIE, VERIFIER_COOKIE]) {
      expect(cookie(response, name)?.value).toBe('');
      expect(cookie(response, name)?.raw).toContain('Max-Age=0');
    }
  });

  it('distinguishes an unprovisioned user from a broken sign-in', async () => {
    jar.current.set(STATE_COOKIE, 'state');
    jar.current.set(VERIFIER_COOKIE, 'verifier');
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes('/oauth2/token')) return Response.json({ id_token: 'an-id-token', refresh_token: 'a-refresh-token' });
      return Response.json({ type: ERROR_TYPES.USER_NOT_PROVISIONED, status: 403 }, { status: 403 });
    });

    const { GET } = await import('../app/api/auth/sso/callback/route');
    expect(reason(await GET(callback('code=c&state=state')))).toBe('not_provisioned');
  });

  it('sets the refresh cookie and lands on /jobs when the api mints a session', async () => {
    jar.current.set(STATE_COOKIE, 'state');
    jar.current.set(VERIFIER_COOKIE, 'verifier');
    const session = {
      accessToken: 'access',
      refreshToken: 'refresh',
      tokenType: 'Bearer',
      expiresIn: 3600,
      user: {
        id: '0198f3a1-0007-7000-8000-000000000001',
        email: 'maya@taloninc.com',
        name: 'Maya Reyes',
        role: 'recruiter',
        tenantId: '0198f3a1-0000-7000-8000-000000000001',
        timezone: 'America/Los_Angeles',
      },
    };
    let sent: unknown;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      if (String(input).includes('/oauth2/token')) {
        return Response.json({ id_token: 'an-id-token', refresh_token: 'a-refresh-token' });
      }
      sent = JSON.parse(String(init?.body));
      return Response.json(session);
    });

    const { GET } = await import('../app/api/auth/sso/callback/route');
    const response = await GET(callback('code=c&state=state'));

    // BOTH tokens go to the api. The refresh token stays Cognito's — the api hands it
    // straight back as the session's long-lived half, which is what makes a global
    // sign-out actually end a federated session. Forwarding only the id token leaves
    // the api unable to answer `SignInResponseSchema` at all.
    expect(sent).toEqual({ idToken: 'an-id-token', refreshToken: 'a-refresh-token' });

    expect(response.headers.get('location')).toBe('https://app.talon.test/jobs');
    // Same treatment as the password path: httpOnly, so the browser holds the
    // refresh token and no script can read it. The id token never gets this far.
    expect(cookie(response, 'talon_refresh')?.value).toBe('refresh');
    expect(cookie(response, 'talon_refresh')?.raw).toContain('HttpOnly');
  });
});
