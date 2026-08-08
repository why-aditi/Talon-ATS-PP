'use client';

import * as SelectPrimitive from '@radix-ui/react-select';
import { useState } from 'react';
import { CheckIcon, ChevronDownIcon } from './icons';
import { cx } from './ui';

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
  /*
    A native <dialog> opened with showModal() lives in the top layer, which sits
    above every stacking context in <body> — z-index cannot reach it. Portalling
    the option list to body (Radix's default) therefore draws it *behind* the
    modal and its backdrop. Portalling into the dialog itself puts it back in the
    top layer. Outside a dialog, `closest` returns null and we get body as before.
  */
  const [trigger, setTrigger] = useState<HTMLButtonElement | null>(null);

  return (
    <SelectPrimitive.Root value={value} onValueChange={onValueChange}>
      {/*
        The trigger carries the border and the full control height, so the hit
        target is the whole box rather than the ~20px line box of the text inside
        it — the same reason the native version sized the <select> and not its
        wrapper.
      */}
      <SelectPrimitive.Trigger
        ref={setTrigger}
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

      <SelectPrimitive.Portal container={trigger?.closest('dialog') ?? undefined}>
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
