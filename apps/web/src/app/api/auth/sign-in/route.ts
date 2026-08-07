import { ERROR_TYPES, SignInRequestSchema, SignInResponseSchema } from '@talon/contracts';
import { NextResponse } from 'next/server';
import { API_URL, refreshCookie } from '../../../../lib/auth-cookie';
import { crossOriginRejected, isSameOrigin } from '../../../../lib/same-origin';

/**
 * Sign-in proxy. Exists so the refresh token can be put in an httpOnly cookie:
 * the upstream API returns it in the response body, and only a server can set a
 * cookie the browser's JS cannot read.
 *
 * Failures are passed through unchanged — the screen switches on the RFC 9457
 * `type`, and rewriting an upstream problem here would flatten
 * `user-not-provisioned` and `mfa-required` into "something went wrong".
 */
export async function POST(request: Request): Promise<Response> {
  if (!isSameOrigin(request)) return crossOriginRejected();

  const body = await request.json().catch(() => null);
  const parsed = SignInRequestSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      {
        type: ERROR_TYPES.VALIDATION_FAILED,
        title: 'Validation failed',
        status: 400,
        errors: parsed.error.flatten().fieldErrors,
      },
      { status: 400, headers: { 'content-type': 'application/problem+json' } },
    );
  }

  let upstream: Response;
  try {
    upstream = await fetch(`${API_URL}/v1/auth/sign-in`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(parsed.data),
      cache: 'no-store',
    });
  } catch {
    // The API is unreachable. 502 rather than 500: the fault is upstream, and the
    // screen shows "couldn't reach the server", not "wrong password".
    return NextResponse.json(
      { type: ERROR_TYPES.INTERNAL, title: 'Sign-in service unreachable', status: 502 },
      { status: 502, headers: { 'content-type': 'application/problem+json' } },
    );
  }

  const payload = await upstream.json().catch(() => null);
  if (!upstream.ok) {
    return NextResponse.json(payload ?? { type: ERROR_TYPES.INTERNAL, title: 'Sign-in failed', status: upstream.status }, {
      status: upstream.status,
      headers: { 'content-type': 'application/problem+json' },
    });
  }

  const session = SignInResponseSchema.parse(payload);
  // The refresh token stops here. Everything past this line is what the browser gets.
  const response = NextResponse.json({
    accessToken: session.accessToken,
    expiresIn: session.expiresIn,
    user: session.user,
  });
  response.cookies.set(refreshCookie(session.refreshToken));
  return response;
}
