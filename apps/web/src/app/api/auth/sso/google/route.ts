import { NextResponse } from 'next/server';
import { STATE_COOKIE, VERIFIER_COOKIE, authorizeUrl, createPkce, createState, ssoCookie, ssoConfig } from '../../../../../lib/sso';

/**
 * Starts the Google hosted-UI flow (spec 004 §4).
 *
 * A GET, not a POST: this is a top-level navigation the user initiated, and the
 * origin guard the POST handlers use would reject the browser's own redirect back.
 * The `state` cookie is what protects this leg instead.
 */
export async function GET(): Promise<Response> {
  const config = ssoConfig();
  // 404 rather than a redirect to a half-configured pool. With the flag off the
  // button is disabled too, so reaching this means someone typed the URL.
  if (!config) return new NextResponse('Not found', { status: 404 });

  const state = createState();
  const { verifier, challenge } = createPkce();

  const response = NextResponse.redirect(authorizeUrl(config, state, challenge));
  response.cookies.set(ssoCookie(STATE_COOKIE, state));
  response.cookies.set(ssoCookie(VERIFIER_COOKIE, verifier));
  return response;
}
