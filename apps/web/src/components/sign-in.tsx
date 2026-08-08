'use client';

import { ERROR_TYPES } from '@talon/contracts';
import { useRouter, useSearchParams } from 'next/navigation';
import { useId, useState, type FormEvent } from 'react';
import { AuthError, useSession } from '../lib/session';
import { TalonMark } from './icons';
import { Avatar, Button, buttonClass, cx } from './ui';

/* ── Hero (left) ───────────────────────────────────────────────────────────── */

const STATS = [
  { value: '24d', label: 'median time to hire' },
  { value: '86%', label: 'offer accept rate' },
  { value: '1,240', label: 'candidates this year' },
] as const;

export function SignInHero() {
  return (
    <section
      // aria-hidden: every word here is marketing that repeats nothing the form
      // needs. A screen-reader user tabs straight into "Welcome back".
      aria-hidden="true"
      className="relative hidden flex-col justify-between overflow-hidden p-12 lg:flex"
      style={{
        background: 'linear-gradient(150deg, var(--color-bg-hero-from), var(--color-bg-hero-to))',
      }}
    >
      {/* Dot texture, mixed from the on-hero token rather than a literal rgba. */}
      <span
        className="pointer-events-none absolute inset-0"
        style={{
          backgroundImage:
            'radial-gradient(color-mix(in srgb, var(--color-text-on-hero) 14%, transparent) 1px, transparent 1px)',
          backgroundSize: '22px 22px',
        }}
      />

      <div className="relative flex items-center gap-3">
        <span className="flex size-10 items-center justify-center rounded-md bg-bg-surface">
          <TalonMark className="size-6 text-action-primary-bg" />
        </span>
        <span className="font-display text-section-title text-text-on-hero">Talon</span>
      </div>

      <div className="relative">
        <h2 className="max-w-xl font-display text-hero text-text-on-hero">Hiring, coordinated.</h2>
        <p className="mt-4 max-w-md text-body-lg text-text-on-hero opacity-80">
          One pipeline for every role, every interview, every offer. Your team stops chasing threads and starts closing
          candidates.
        </p>

        {/* The same primitives the product uses, so the hero cannot drift from it. */}
        <div className="mt-8 flex w-[var(--layout-sign-in-hero-card-width)] items-center gap-3 rounded-lg bg-bg-surface p-3 shadow-sm">
          {/* Id pinned so the hash lands on the violet the reference shows — the fill
              comes from the ramp, not from a colour chosen here (DESIGN_SYSTEM §3). */}
          <Avatar id="ana-petrova-2" name="Ana Petrova" size={32} />
          <span className="flex-1 leading-tight">
            <span className="block text-body-strong text-text-primary">Ana Petrova</span>
            <span className="block text-meta text-text-tertiary">Onsite loop Thu, 4 rounds</span>
          </span>
          <span className="rounded-sm bg-bg-selected px-2 py-px text-caption text-text-link">Onsite</span>
        </div>
      </div>

      <dl
        className="relative flex gap-10 rounded-lg px-6 py-5"
        style={{ background: 'color-mix(in srgb, var(--color-bg-hero-from) 55%, transparent)' }}
      >
        {STATS.map((stat) => (
          <div key={stat.label}>
            <dt className="font-display text-metric-xl tabular-nums text-text-on-hero">{stat.value}</dt>
            <dd className="mt-1 text-meta text-text-on-hero opacity-70">{stat.label}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

/* ── Form (right) ──────────────────────────────────────────────────────────── */

const FIELD =
  'h-[var(--control-height-lg)] w-full rounded-md border border-border-default bg-bg-surface px-3 text-body text-text-primary placeholder:text-text-placeholder focus:border-border-focus';

/**
 * Every reachable failure of POST /v1/auth/sign-in, keyed by its RFC 9457 type.
 * Switching on the type rather than the status is what keeps "we have no user row
 * for you" from being rendered as "wrong password" — a support problem shown as a
 * login problem sends the user round a loop that cannot end.
 */
const FAILURES: Record<string, string> = {
  [ERROR_TYPES.INVALID_CREDENTIALS]: 'That email and password don’t match. Check them and try again.',
  [ERROR_TYPES.USER_NOT_PROVISIONED]:
    'Your sign-in worked, but this workspace has no account for you yet. Ask an admin to add you.',
  [ERROR_TYPES.MFA_REQUIRED]:
    'This account needs a verification code. Two-factor sign-in isn’t available in this build yet.',
  [ERROR_TYPES.MFA_NOT_ENROLLED]:
    'This account requires two-factor, but no authenticator is enrolled. An admin needs to reset it.',
  [ERROR_TYPES.VALIDATION_FAILED]: 'Enter a valid work email and your password.',
  'urn:talon:client:network': 'We couldn’t reach the server. Check your connection and try again.',
};

const FALLBACK = 'Sign-in isn’t working right now. Try again in a moment.';

/**
 * Off unless a Cognito pool is configured (spec 004 §6). A button that redirects
 * to an unconfigured pool is worse than one that says it isn't ready.
 */
const GOOGLE_SSO_ENABLED = process.env['NEXT_PUBLIC_SSO_GOOGLE'] === 'on';

/** How the callback's `?sso=` reason reads to the person who just came back. */
const SSO_FAILURES: Record<string, string> = {
  cancelled: 'Google sign-in was cancelled.',
  expired: 'That sign-in link expired. Start again.',
  not_provisioned:
    'Your Google account signed in, but this workspace has no account for you yet. Ask an admin to add you.',
  failed: 'Google sign-in didn’t complete. Try again, or use your email and password.',
};

export function SignInForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { signIn } = useSession();
  const emailId = useId();
  const passwordId = useId();
  const errorId = useId();

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  // Seeded from the callback's ?sso= reason, so a failed Google round-trip lands
  // in the same alert region as a failed password attempt rather than a second one.
  const [error, setError] = useState<string | null>(SSO_FAILURES[searchParams.get('sso') ?? ''] ?? null);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      await signIn(email, password);
      router.push('/jobs');
    } catch (caught) {
      setError(caught instanceof AuthError ? (FAILURES[caught.type] ?? FALLBACK) : FALLBACK);
      setSubmitting(false);
    }
  }

  return (
    <section className="flex items-center justify-center bg-bg-canvas px-6 py-12">
      <div className="w-[var(--layout-sign-in-form-width)]">
        <h1 className="font-display text-page-title text-text-primary">Welcome back</h1>
        <p className="mt-1 text-body text-text-secondary">Sign in to your Talon workspace.</p>

        {/*
          Disabled, not hidden and not inert-but-focusable: disabled keeps them out
          of the tab order so the keyboard path has no dead stop, while the screen
          keeps the shape the reference shows. DESIGN_SYSTEM §3 disables with
          token colors rather than opacity, so the labels stay legible.
        */}
        <div className="mt-6 space-y-3">
          {GOOGLE_SSO_ENABLED ? (
            // A link, not a fetch: the hosted-UI flow is a top-level navigation and
            // the browser has to own it, or the redirect back carries no cookies.
            <a href="/api/auth/sso/google" className={buttonClass('secondary', 'w-full', 'lg')}>
              <GoogleMark />
              Continue with Google
            </a>
          ) : (
            <Button variant="secondary" size="lg" disabled className="w-full">
              <GoogleMark />
              Continue with Google
            </Button>
          )}
          {/*
            SAML stays disabled regardless of the flag. Spec 002 open question 2: a
            persistent NameID does not satisfy AccessTokenClaimsSchema.sub, so it
            would fail validation at the moment sign-in succeeded.
          */}
          <Button variant="secondary" size="lg" disabled className="w-full">
            <LockMark />
            Continue with SAML SSO
          </Button>
        </div>
        {/*
          Not "available once configured": that implies an admin can switch it on,
          and there is nothing to switch — no OAuth client, no SAML, no setting.
          Copy rule (§6): name the real blocker and the next move, and don't point
          at machinery. This says what is true and what to do instead.
        */}
        <p className="mt-2 text-meta text-text-tertiary">
          {GOOGLE_SSO_ENABLED
            ? 'SAML single sign-on isn’t available yet.'
            : 'Single sign-on isn’t available yet. Use your email and password.'}
        </p>

        <div className="my-6 flex items-center gap-3">
          <span className="h-px flex-1 bg-border-default" />
          <span className="text-meta text-text-tertiary">or use email</span>
          <span className="h-px flex-1 bg-border-default" />
        </div>

        <form onSubmit={onSubmit} noValidate>
          <label htmlFor={emailId} className="block text-body-strong text-text-primary">
            Work email
          </label>
          <input
            id={emailId}
            type="email"
            name="email"
            autoComplete="username"
            required
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            placeholder="maya@company.com"
            className={cx(FIELD, 'mt-2')}
            {...(error ? { 'aria-invalid': true, 'aria-describedby': errorId } : {})}
          />

          {/* mt-2, not mt-4: the reference puts 70px between the two field tops, and
              a 16px lead above the label overshoots it by ten. */}
          <div className="mt-2 flex items-baseline justify-between">
            <label htmlFor={passwordId} className="block text-body-strong text-text-primary">
              Password
            </label>
            {/* A link cannot be disabled, so the affordance is a button — which is
                what actually keeps it out of the tab order. No reset endpoint yet. */}
            <button type="button" disabled className="text-body text-action-disabled-text">
              Forgot?
            </button>
          </div>
          <input
            id={passwordId}
            type="password"
            name="password"
            autoComplete="current-password"
            required
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            className={cx(FIELD, 'mt-2')}
            {...(error ? { 'aria-invalid': true, 'aria-describedby': errorId } : {})}
          />

          {/* Live region: the message replaces nothing visually, so a screen reader
              would otherwise never learn the submission failed. */}
          <p id={errorId} role="alert" className={cx('mt-3 text-body text-feedback-danger-fg', !error && 'sr-only')}>
            {error ?? ''}
          </p>

          <Button type="submit" variant="primary" size="lg" disabled={submitting} className="mt-4 w-full">
            {submitting ? 'Signing in…' : 'Sign in'}
          </Button>
        </form>

        <p className="mt-6 text-center text-meta text-text-tertiary">SOC 2 Type II · SSO enforced for admin roles</p>
      </div>
    </section>
  );
}

/* Monochrome marks: a full-colour Google glyph would need brand hex values, which
   cannot be semantic tokens, and colour on a disabled control reads as enabled. */
function GoogleMark() {
  return (
    <svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden="true">
      <path d="M14 8a6 6 0 1 1-1.8-4.3" strokeLinecap="round" />
      <path d="M14 8H8" strokeLinecap="round" />
    </svg>
  );
}

function LockMark() {
  return (
    <svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden="true">
      <rect x="3.25" y="7.25" width="9.5" height="6.5" rx="1.5" />
      <path d="M5.75 7V5.25a2.25 2.25 0 0 1 4.5 0V7" strokeLinecap="round" />
    </svg>
  );
}
