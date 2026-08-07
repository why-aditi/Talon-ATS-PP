import type { CanonicalStage, JobStatus, StageDistribution } from '@talon/contracts';
import type { ButtonHTMLAttributes, ReactNode } from 'react';
import { avatarToken, initials } from '../lib/avatar';

const cx = (...parts: (string | false | undefined)[]) => parts.filter(Boolean).join(' ');

/* ── Button (DESIGN_SYSTEM §3) ─────────────────────────────────────────────── */

const VARIANTS = {
  primary: 'bg-action-primary-bg text-text-on-primary hover:bg-action-primary-bg-hover active:bg-action-primary-bg-active',
  secondary: 'bg-action-secondary-bg text-text-primary border border-action-secondary-border hover:bg-bg-surface-hover',
  ghost: 'text-text-secondary hover:bg-action-ghost-bg-hover',
} as const;

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: keyof typeof VARIANTS;
  /** `lg` is the form-scale control — inputs and the primary CTA beside them. */
  size?: 'md' | 'lg';
};

const SIZES = {
  md: 'h-[var(--control-height-md)]',
  lg: 'h-[var(--control-height-lg)]',
} as const;

/** Shared so a link can be styled as a button without nesting one inside an anchor. */
export const buttonClass = (
  variant: keyof typeof VARIANTS = 'secondary',
  className?: string,
  size: keyof typeof SIZES = 'md',
) =>
  cx(
    'inline-flex items-center justify-center gap-2 rounded-md px-4 text-body-strong',
    SIZES[size],
    'transition-colors duration-[var(--duration-instant)] ease-standard',
    'disabled:bg-action-disabled-bg disabled:text-action-disabled-text disabled:cursor-not-allowed',
    VARIANTS[variant],
    className,
  );

export function Button({ variant = 'secondary', size = 'md', className, ...props }: ButtonProps) {
  return <button type="button" className={buttonClass(variant, className, size)} {...props} />;
}

/* ── Status pill ───────────────────────────────────────────────────────────── */

// `closed` has no token pair of its own; it reuses the neutral draft pair, which is
// the only status in design-tokens.json that reads as "not in play".
const STATUS_PILLS: Record<JobStatus, { label: string; className: string }> = {
  active: { label: 'Active', className: 'bg-status-active-bg text-status-active-text' },
  on_hold: { label: 'On hold', className: 'bg-status-on-hold-bg text-status-on-hold-text' },
  closing: { label: 'Closing', className: 'bg-status-closing-bg text-status-closing-text' },
  draft: { label: 'Draft', className: 'bg-status-draft-bg text-status-draft-text' },
  closed: { label: 'Closed', className: 'bg-status-draft-bg text-status-draft-text' },
};

export function StatusPill({ status }: { status: JobStatus }) {
  const { label, className } = STATUS_PILLS[status];
  // The label is always rendered — status is never carried by color alone.
  return <span className={cx('inline-flex items-center rounded-sm px-2 py-px text-caption', className)}>{label}</span>;
}

/* ── Avatar ────────────────────────────────────────────────────────────────── */

export function Avatar({ id, name, size = 24 }: { id: string; name: string; size?: 20 | 24 | 32 | 44 }) {
  return (
    <span
      // A var() reference, not a color literal — the value stays inside packages/tokens.
      style={{ backgroundColor: `var(${avatarToken(id)})`, width: size, height: size }}
      className="inline-flex shrink-0 items-center justify-center rounded-full text-caption font-bold text-text-on-primary"
      aria-hidden="true"
    >
      {initials(name)}
    </span>
  );
}

/* ── Distribution bar (DESIGN_SYSTEM §3, "progress rule") ──────────────────── */

/** Non-terminal stages only — the bar shows the live pipeline, not its history. */
const IN_PROCESS_STAGES = ['applied', 'screen', 'onsite', 'offer'] as const satisfies readonly CanonicalStage[];

const STAGE_FILLS: Record<(typeof IN_PROCESS_STAGES)[number], string> = {
  applied: 'bg-stage-applied',
  screen: 'bg-stage-screen',
  onsite: 'bg-stage-onsite',
  offer: 'bg-stage-offer',
};

export function DistributionBar({ distribution, inProcessCount }: { distribution: StageDistribution; inProcessCount: number }) {
  const segments = IN_PROCESS_STAGES.map((stage) => ({ stage, count: distribution[stage] })).filter((s) => s.count > 0);
  const total = segments.reduce((sum, s) => sum + s.count, 0);

  // Spec 001 §9.4: a job with no applications renders a zero-width fill, never NaN.
  const label =
    total === 0
      ? 'No applications in process'
      : `${inProcessCount} in process: ${segments.map((s) => `${s.count} ${s.stage}`).join(', ')}`;

  return (
    <div
      className="flex h-[var(--layout-progress-rule-height)] w-[var(--layout-job-row-distribution-bar-width)] overflow-hidden rounded-full bg-border-subtle"
      role="img"
      aria-label={label}
    >
      {segments.map(({ stage, count }) => (
        <span key={stage} className={STAGE_FILLS[stage]} style={{ width: `${(count / total) * 100}%` }} />
      ))}
    </div>
  );
}

/* ── Eyebrow ───────────────────────────────────────────────────────────────── */

export function Eyebrow({ children, className }: { children: ReactNode; className?: string }) {
  return <p className={cx('text-eyebrow uppercase text-text-tertiary', className)}>{children}</p>;
}

export { cx };
