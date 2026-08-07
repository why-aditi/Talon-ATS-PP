import { NextResponse } from 'next/server';
import { refreshCookie } from '../../../../lib/auth-cookie';
import { crossOriginRejected, isSameOrigin } from '../../../../lib/same-origin';

/** Clears the refresh cookie. The in-memory access token dies with the page. */
export async function POST(request: Request): Promise<Response> {
  if (!isSameOrigin(request)) return crossOriginRejected();

  const response = NextResponse.json({ ok: true });
  response.cookies.set(refreshCookie('', 0));
  return response;
}
