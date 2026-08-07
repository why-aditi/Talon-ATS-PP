/**
 * Server-only. The refresh token lives in an httpOnly cookie set by the route
 * handlers in `app/api/auth`, never in localStorage and never in a JS-reachable
 * cookie — a cookie set from the browser cannot be httpOnly, so it would be
 * readable by any injected script and no better than the storage it replaced.
 *
 * The upstream API returns the refresh token in its JSON body. These handlers are
 * the only place that body is read; what reaches the browser is the access token
 * and the user, nothing else.
 */
export const REFRESH_COOKIE = 'talon_refresh';

/** 30 days, matching the sliding refresh window (spec 001 §11 open question 2). */
export const REFRESH_MAX_AGE = 60 * 60 * 24 * 30;

export const refreshCookie = (value: string, maxAge = REFRESH_MAX_AGE) =>
  ({
    name: REFRESH_COOKIE,
    value,
    httpOnly: true,
    sameSite: 'lax' as const,
    // Off over plain http so local development works; on everywhere real.
    secure: process.env.NODE_ENV === 'production',
    // Scoped to the endpoints that exchange it, so it is not attached to every
    // page request it has no business being on.
    path: '/api/auth',
    maxAge,
  }) satisfies { name: string; value: string } & Record<string, unknown>;

export const API_URL = process.env['TALON_API_URL'] ?? 'http://localhost:3001';
