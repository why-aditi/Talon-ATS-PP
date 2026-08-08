import { ERROR_TYPES, SignInResponseSchema } from '@talon/contracts';
import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';
import { API_URL, refreshCookie } from '../../../../../lib/auth-cookie';
import { STATE_COOKIE, VERIFIER_COOKIE, ssoConfig, ssoCookie, type SsoFailure } from '../../../../../lib/sso';

/** Back to sign-in with a reason the screen can turn into its own sentence. */
function back(reason: SsoFailure, origin: string): NextResponse {
  const response = NextResponse.redirect(`${origin}/sign-in?sso=${reason}`);
  // Single-use either way: a state that survived a failure is a state an attacker
  // gets to retry against.
  response.cookies.set(ssoCookie(STATE_COOKIE, '', 0));
  response.cookies.set(ssoCookie(VERIFIER_COOKIE, '', 0));
  return response;
}

/**
 * Finishes the Google flow (spec 004 §4): verify `state`, exchange the code for an
 * id token server-side, hand that to the api for a Talon session, and set the
 * refresh cookie exactly as the password path does.
 *
 * The id token never reaches the browser.
 */
export async function GET(request: Request): Promise<Response> {
  const config = ssoConfig();
  if (!config) return new NextResponse('Not found', { status: 404 });

  const origin = new URL(config.redirectUri).origin;
  const params = new URL(request.url).searchParams;

  // Cancelling at Google is a choice, not a failure — it gets its own copy.
  if (params.get('error')) {
    return back(params.get('error') === 'access_denied' ? 'cancelled' : 'failed', origin);
  }

  const jar = await cookies();
  const expectedState = jar.get(STATE_COOKIE)?.value;
  const verifier = jar.get(VERIFIER_COOKIE)?.value;
  const code = params.get('code');

  // Compared before anything is exchanged: an unverified callback must not reach
  // Cognito at all, or the endpoint becomes an oracle for delivered codes.
  if (!code || !verifier || !expectedState || params.get('state') !== expectedState) {
    return back('expired', origin);
  }

  let idToken: string;
  let refreshToken: string;
  try {
    const token = await fetch(`${config.domain}/oauth2/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        client_id: config.clientId,
        code,
        redirect_uri: config.redirectUri,
        code_verifier: verifier,
      }),
      cache: 'no-store',
    });
    if (!token.ok) return back('failed', origin);
    // Both tokens, from the same exchange. The refresh token is Cognito's and stays
    // Cognito's — the api hands it straight back as the session's long-lived half, so
    // disabling a user or a global sign-out actually ends a federated session instead
    // of waiting out a token we minted.
    const body = (await token.json()) as { id_token?: string; refresh_token?: string };
    if (!body.id_token || !body.refresh_token) return back('failed', origin);
    idToken = body.id_token;
    refreshToken = body.refresh_token;
  } catch {
    return back('failed', origin);
  }

  // The api is the session authority (spec 002 §3): it verifies the id token
  // against the pool's JWKS and mints our own claims from the users row.
  let session: Response;
  try {
    session = await fetch(`${API_URL}/v1/auth/sso`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ idToken, refreshToken }),
      cache: 'no-store',
    });
  } catch {
    return back('failed', origin);
  }

  const payload: unknown = await session.json().catch(() => null);
  if (!session.ok) {
    const type = (payload as { type?: string } | null)?.type;
    // A Google identity with no users row is a provisioning problem, and saying
    // "sign-in failed" would send the user to retry something that cannot work.
    return back(type === ERROR_TYPES.USER_NOT_PROVISIONED ? 'not_provisioned' : 'failed', origin);
  }

  const parsed = SignInResponseSchema.parse(payload);
  const response = NextResponse.redirect(`${origin}/jobs`);
  response.cookies.set(refreshCookie(parsed.refreshToken));
  response.cookies.set(ssoCookie(STATE_COOKIE, '', 0));
  response.cookies.set(ssoCookie(VERIFIER_COOKIE, '', 0));
  return response;
}
