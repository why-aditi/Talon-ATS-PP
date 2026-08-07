'use client';

import { ERROR_TYPES, type SessionUser } from '@talon/contracts';
import { createContext, useCallback, useContext, useMemo, useState } from 'react';

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

  const value = useMemo(() => ({ session, signIn, refresh, signOut }), [session, signIn, refresh, signOut]);
  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): SessionValue {
  const value = useContext(SessionContext);
  if (!value) throw new Error('useSession must be used inside SessionProvider');
  return value;
}
