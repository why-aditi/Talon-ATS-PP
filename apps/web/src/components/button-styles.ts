const cx = (...parts: (string | false | undefined)[]) => parts.filter(Boolean).join(' ');

const VARIANTS = {
  primary: 'bg-action-primary-bg text-text-on-primary hover:bg-action-primary-bg-hover active:bg-action-primary-bg-active',
  secondary: 'bg-action-secondary-bg text-text-primary border border-action-secondary-border hover:bg-bg-surface-hover',
  ghost: 'text-text-secondary hover:bg-action-ghost-bg-hover',
} as const;

const SIZES = {
  md: 'h-[var(--control-height-md)]',
  lg: 'h-[var(--control-height-lg)]',
} as const;

/** Pure styling helper safe to call from both server and client components. */
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
