import * as SelectPrimitive from '@radix-ui/react-select';
import type { CanonicalStage, JobStatus, StageDistribution } from '@talon/contracts';
import type { ButtonHTMLAttributes, ReactNode } from 'react';
import { avatarToken, initials } from '../lib/avatar';
import { CheckIcon, ChevronDownIcon } from './icons';

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

/* ── Select (DESIGN_SYSTEM §3) ─────────────────────────────────────────────── */

/*
  Radix rather than a native <select>. The option list of a native select is drawn
  by the OS, not the DOM: `appearance: none` restyles the closed control and stops
  there, so the open list keeps the system font and the system highlight and
  ignores every token we set. Verified on Chromium/Windows — `accent-color` and
  `option { background }` both had no effect — before taking on the dependency.

  What this costs: keyboard nav, type-ahead and the screen-reader contract were
  free from the platform and are now Radix's to provide. That is the reason this
  is Radix, already the decided stack (CLAUDE.md §2), and not a hand-rolled
  listbox — a11y is a CI gate, not something to reimplement for a styling win.
*/
export function Select({
  prefix,
  placeholder,
  ariaLabel,
  value,
  onValueChange,
  options,
  className,
  invalid,
}: {
  /** Visible lead-in, e.g. "Status:". Distinct from the accessible name. */
  prefix?: string;
  /**
   * Shown while `value` is empty. A filter always has a value ("All"), so it
   * needs none; a required field with no default — the wizard's currency, which
   * #9 forbids guessing — has nothing to show until someone chooses.
   */
  placeholder?: string;
  ariaLabel: string;
  value: string;
  onValueChange: (value: string) => void;
  options: readonly { value: string; label: string }[];
  className?: string;
  invalid?: boolean;
}) {
  return (
    <SelectPrimitive.Root value={value} onValueChange={onValueChange}>
      {/*
        The trigger carries the border and the full control height, so the hit
        target is the whole box rather than the ~20px line box of the text inside
        it — the same reason the native version sized the <select> and not its
        wrapper.
      */}
      <SelectPrimitive.Trigger
        aria-label={ariaLabel}
        {...(invalid ? { 'aria-invalid': true } : {})}
        className={cx(
          'inline-flex h-[var(--control-height-md)] items-center gap-1 rounded-md border bg-bg-surface pl-3 pr-2 text-body text-text-primary hover:bg-bg-surface-hover',
          invalid ? 'border-border-danger' : 'border-border-default',
          className,
        )}
      >
        {prefix ? <span className="text-text-secondary">{prefix}</span> : null}
        {/* Radix renders `placeholder` only while the value is empty, which is
            exactly the distinction between "not chosen" and "chose the default". */}
        <SelectPrimitive.Value placeholder={placeholder} />
        <SelectPrimitive.Icon asChild>
          <ChevronDownIcon className="text-text-secondary" />
        </SelectPrimitive.Icon>
      </SelectPrimitive.Trigger>

      <SelectPrimitive.Portal>
        <SelectPrimitive.Content
          // `popper` rather than the default `item-aligned`: item-aligned mimics a
          // native macOS select by overlaying the trigger, which reads as the menu
          // covering the control it belongs to on every other platform.
          position="popper"
          // The control sits at the right edge of the header, so the menu hangs from
          // that edge too — `start` would leave it floating short of the trigger it
          // belongs to, which is what made the first pass look detached.
          align="end"
          sideOffset={4}
          collisionPadding={8}
          className={cx(
            'z-[var(--z-dropdown)] rounded-md border border-border-default bg-bg-surface shadow-lg',
            // Radix measures both of these for us. Matching the trigger width stops
            // the menu being narrower than the control that opened it; capping at the
            // available height means a longer status list scrolls instead of running
            // off the bottom of the window.
            'min-w-[var(--radix-select-trigger-width)] max-h-[var(--radix-select-content-available-height)] overflow-y-auto',
          )}
        >
          <SelectPrimitive.Viewport className="p-1">
            {options.map((option) => (
              <SelectPrimitive.Item
                key={option.value}
                value={option.value}
                // flex, not block: it makes the row fill the menu width — a block item
                // shrank to its text and left the highlight ending mid-row — and gives
                // the checkmark somewhere to sit without a second layout rule.
                // data-[highlighted] covers hover and keyboard focus as one state,
                // so the pointer and the arrow keys cannot show different rows.
                // py-2, not py-1: the scale ships no 1.5 step, and 4px of lead on a
                // 20px line box puts the row under the 24px minimum hit target.
                className="flex cursor-default items-center justify-between gap-3 rounded-sm px-3 py-2 text-body text-text-primary outline-none data-[highlighted]:bg-bg-selected data-[highlighted]:text-text-link"
              >
                <SelectPrimitive.ItemText>{option.label}</SelectPrimitive.ItemText>
                {/*
                  Which row is *selected* and which is merely *highlighted* are two
                  different questions, and the highlight answers only the second — as
                  soon as you arrow away from the current value, nothing on screen
                  still points at it. The check is the persistent answer, and it is not
                  carried by colour alone.
                */}
                <SelectPrimitive.ItemIndicator>
                  <CheckIcon />
                </SelectPrimitive.ItemIndicator>
              </SelectPrimitive.Item>
            ))}
          </SelectPrimitive.Viewport>
        </SelectPrimitive.Content>
      </SelectPrimitive.Portal>
    </SelectPrimitive.Root>
  );
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
      // No font-bold: `text-caption` already carries its own weight (500), and a
      // Tailwind weight utility on top silently overrides the token — which is how
      // these initials ended up at 700 while the reference renders them at 500.
      className="inline-flex shrink-0 items-center justify-center rounded-full text-caption text-text-on-primary"
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
