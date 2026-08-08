'use client';

import { ERROR_TYPES, type SessionUser } from '@talon/contracts';
import { useRouter } from 'next/navigation';
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';

/**
 * The access token is held in memory only — never localStorage, never a
 * JS-readable cookie. The refresh token is in an httpOnly cookie the browser's
 * script cannot reach (see lib/auth-cookie.ts), which is what lets a reload
 * restore the session without anything durable being readable by an injected
 * script.
 */
type Session = { user: SessionUser; accessToken: string; expiresAt: number };

/** Carries the RFC 9457 `type` so callers branch on the failure, not the status. */
export class AuthError extends Error {
  constructor(
    readonly type: string,
    message: string,
  ) {
    super(message);
    this.name = 'AuthError';
  }
}

async function post(path: string, body?: unknown): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  } catch {
    // Genuinely offline: distinct from every server-produced failure, and the one
    // case where retrying the same credentials is the right advice.
    throw new AuthError('urn:talon:client:network', 'network');
  }
  const payload: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const type =
      payload && typeof payload === 'object' && typeof (payload as { type?: unknown }).type === 'string'
        ? (payload as { type: string }).type
        : ERROR_TYPES.INTERNAL;
    throw new AuthError(type, `${path} failed with ${response.status}`);
  }
  return payload;
}

type SessionValue = {
  session: Session | null;
  /**
   * False until the cookie has been offered to `/api/auth/refresh` and answered.
   *
   * Without this, `session` is indistinguishable between "no session" and "not
   * asked yet", and every authenticated query fires token-less on mount, 401s,
   * and — with `retry: false` — renders an error before the session arrives. The
   * jobs list showed "Jobs didn't load." on every reload for exactly that reason.
   */
  ready: boolean;
  signIn: (email: string, password: string) => Promise<SessionUser>;
  refresh: () => Promise<SessionUser>;
  signOut: () => Promise<void>;
};

const SessionContext = createContext<SessionValue | null>(null);

function toSession(payload: unknown): Session {
  const { accessToken, expiresIn, user } = payload as {
    accessToken: string;
    expiresIn: number;
    user: SessionUser;
  };
  return { user, accessToken, expiresAt: Date.now() + expiresIn * 1000 };
}

export function SessionProvider({ children }: { children: React.ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [ready, setReady] = useState(false);

  // Restore on mount. Without this the httpOnly cookie is written and never
  // redeemed — the refresh route would be dead code and the "survives a reload"
  // claim would be false. A 401 here just means there is no session yet.
  useEffect(() => {
    let cancelled = false;
    void post('/api/auth/refresh')
      .then((payload) => {
        if (!cancelled) setSession(toSession(payload));
      })
      .catch(() => undefined)
      // `finally`, so a refused cookie marks the session resolved just as a
      // redeemed one does. Only the failure path leaving `ready` false would
      // hang every dependent query forever.
      .finally(() => {
        if (!cancelled) setReady(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const signIn = useCallback(async (email: string, password: string) => {
    const next = toSession(await post('/api/auth/sign-in', { email, password }));
    setSession(next);
    return next.user;
  }, []);

  const refresh = useCallback(async () => {
    const next = toSession(await post('/api/auth/refresh'));
    setSession(next);
    return next.user;
  }, []);

  const signOut = useCallback(async () => {
    await post('/api/auth/sign-out').catch(() => undefined);
    setSession(null);
  }, []);

  const value = useMemo(
    () => ({ session, ready, signIn, refresh, signOut }),
    [session, ready, signIn, refresh, signOut],
  );
  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

/**
 * Gate for everything behind the shell: no session, no page.
 *
 * This is client-side on purpose, and the reason is worth writing down because the
 * obvious alternative looks better and does not work. Next middleware cannot do
 * this: the refresh cookie is scoped to `path=/api/auth` (lib/auth-cookie.ts) so
 * the browser never attaches it to a request for `/jobs`, and middleware would
 * read every visitor as signed out. Widening the cookie's path to fix that would
 * send the refresh token along with every page, image and font request — a worse
 * trade than the one this makes.
 *
 * Nothing renders until `ready`, so the shell never paints for a signed-out
 * visitor and then vanishes. The API stays the real authority regardless: this
 * hides the chrome, and every query behind it still carries a bearer token the
 * server checks (§4.1 — hiding a screen is not access control).
 */
export function RequireSession({ children }: { children: React.ReactNode }) {
  const { session, ready } = useSession();
  const router = useRouter();

  useEffect(() => {
    if (ready && !session) router.replace('/sign-in');
  }, [ready, session, router]);

  return ready && session ? <>{children}</> : null;
}

export function useSession(): SessionValue {
  const value = useContext(SessionContext);
  if (!value) throw new Error('useSession must be used inside SessionProvider');
  return value;
}

/** Optional for component-test seams that intentionally render outside the app shell. */
export function useOptionalSession(): SessionValue | null {
  return useContext(SessionContext);
}
