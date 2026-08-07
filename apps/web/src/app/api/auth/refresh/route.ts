import { ERROR_TYPES, RefreshResponseSchema } from '@talon/contracts';
import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';
import { API_URL, REFRESH_COOKIE, refreshCookie } from '../../../../lib/auth-cookie';

/**
 * Exchanges the httpOnly refresh cookie for a fresh access token. This is what
 * makes a session survive a reload without any token being readable from JS.
 *
 * The window slides: every exchange returns a new refresh token and the cookie is
 * rewritten, so an active session never expires and an idle one dies after 30 days.
 */
export async function POST(): Promise<Response> {
  const token = (await cookies()).get(REFRESH_COOKIE)?.value;
  if (!token) {
    return NextResponse.json(
      { type: ERROR_TYPES.UNAUTHENTICATED, title: 'No session', status: 401 },
      { status: 401, headers: { 'content-type': 'application/problem+json' } },
    );
  }

  let upstream: Response;
  try {
    upstream = await fetch(`${API_URL}/v1/auth/refresh`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ refreshToken: token }),
      cache: 'no-store',
    });
  } catch {
    return NextResponse.json(
      { type: ERROR_TYPES.INTERNAL, title: 'Sign-in service unreachable', status: 502 },
      { status: 502, headers: { 'content-type': 'application/problem+json' } },
    );
  }

  const payload = await upstream.json().catch(() => null);
  if (!upstream.ok) {
    // A refresh token that no longer works is a dead session, so the cookie goes
    // too — otherwise every page load retries a token that can never succeed.
    const response = NextResponse.json(
      payload ?? { type: ERROR_TYPES.INVALID_TOKEN, title: 'Session expired', status: upstream.status },
      { status: upstream.status, headers: { 'content-type': 'application/problem+json' } },
    );
    response.cookies.set(refreshCookie('', 0));
    return response;
  }

  const session = RefreshResponseSchema.parse(payload);
  const response = NextResponse.json({
    accessToken: session.accessToken,
    expiresIn: session.expiresIn,
    user: session.user,
  });
  response.cookies.set(refreshCookie(session.refreshToken));
  return response;
}
