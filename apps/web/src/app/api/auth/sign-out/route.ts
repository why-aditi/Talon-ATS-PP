import { NextResponse } from 'next/server';
import { refreshCookie } from '../../../../lib/auth-cookie';

/** Clears the refresh cookie. The in-memory access token dies with the page. */
export async function POST(): Promise<Response> {
  const response = NextResponse.json({ ok: true });
  response.cookies.set(refreshCookie('', 0));
  return response;
}
