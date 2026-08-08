'use client';

import { useEffect, useMemo, useRef, useState, type MouseEvent } from 'react';
import { Button, buttonClass, cx } from './ui';

/* ── Content (spec 003 §UI spec) ───────────────────────────────────────────── */

/**
 * The starting text, not the current text. Once the modal is open the user's edits
 * live in component state; this stays the baseline so "has it been edited?" is
 * answerable, which is what the discard prompt depends on.
 *
 * The compensation section is deliberately placeholder-only. Non-negotiable #2
 * scope-gates real compensation at the API layer, and this component makes no
 * request and checks no scope, so it must never render a real band. A figure here
 * would be comp shown to everyone with no gate at all.
 */
const JOB_TEMPLATE: readonly { id: string; heading: string; body: readonly string[] }[] = [
  {
    id: 'about',
    heading: 'About the role',
    body: [
      'One paragraph on what this person will own and why the role exists now.',
      'Name the team they join and who they work with day to day.',
      'Say what success looks like after six months, in concrete terms.',
    ],
  },
  {
    id: 'responsibilities',
    heading: 'Responsibilities',
    body: [
      'Lead the design and delivery of [area], end to end.',
      'Partner with [function] to turn ambiguous problems into shipped work.',
      'Raise the bar on quality through review, testing and documentation.',
      'Mentor teammates and help set technical direction.',
    ],
  },
  {
    id: 'minimum',
    heading: 'Minimum qualifications',
    body: [
      '[N]+ years building and operating production software.',
      'Depth in [language or domain] and a track record of shipping.',
      'Experience owning a system through design, launch and iteration.',
      'Clear written communication with non-engineering partners.',
    ],
  },
  {
    id: 'preferred',
    heading: 'Preferred qualifications',
    body: [
      'Experience in [industry or problem space].',
      'Familiarity with [tool or platform] at scale.',
      'History of mentoring or leading a small team.',
    ],
  },
  {
    id: 'compensation',
    heading: 'Compensation and benefits',
    body: [
      'Band: [add the range for this req — do not paste a band you cannot share].',
      'Equity, reviewed annually.',
      'Health, dental and vision cover for the whole family.',
      'Paid leave, parental leave and a learning budget.',
    ],
  },
  {
    id: 'process',
    heading: 'Interview process',
    body: [
      'Recruiter screen, 30 minutes.',
      'Hiring manager conversation, 45 minutes.',
      'Onsite loop: [N] rounds covering [areas].',
      'Decision and offer within [N] business days of the loop.',
    ],
  },
  {
    id: 'eeo',
    heading: 'Equal opportunity',
    body: [
      'We are an equal opportunity employer. We do not discriminate on the basis of race, religion, colour, national origin, gender, sexual orientation, age, marital status, veteran status or disability.',
      'Tell us if you need an adjustment at any stage and we will make it.',
    ],
  },
];

type Draft = Record<string, string>;

const initialDraft = (): Draft => Object.fromEntries(JOB_TEMPLATE.map((s) => [s.id, s.body.join('\n')]));

const sectionText = (heading: string, body: string) => `${heading}\n${body}`;

/* ── Modal ─────────────────────────────────────────────────────────────────── */

type CopyState = { id: string; ok: boolean } | null;

export function JobTemplateModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);

  const [draft, setDraft] = useState<Draft>(initialDraft);
  const [copied, setCopied] = useState<CopyState>(null);
  const [confirmDiscard, setConfirmDiscard] = useState(false);

  const pristine = useMemo(() => initialDraft(), []);
  const dirty = JOB_TEMPLATE.some((s) => draft[s.id] !== pristine[s.id]);

  // showModal() rather than the `open` attribute: only the former puts the dialog in
  // the top layer and turns on the focus trap, Escape handling and focus restore.
  // Setting `open` directly gives a non-modal dialog with none of that.
  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  // Every open starts from the template again. Without this, reopening after a
  // discard would silently restore the edits the user just chose to throw away.
  useEffect(() => {
    if (open) {
      setDraft(initialDraft());
      setCopied(null);
      setConfirmDiscard(false);
    }
  }, [open]);

  // <dialog> does not lock the page behind it, so the canvas would scroll under the
  // modal on a short viewport.
  useEffect(() => {
    if (!open) return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = previous;
    };
  }, [open]);

  // A pending "Copied" timer outliving the modal would set state after unmount.
  useEffect(() => () => clearTimeout(timer.current), []);

  async function copy(id: string, text: string) {
    clearTimeout(timer.current);
    try {
      // Optional-chained on purpose: `navigator.clipboard` is undefined on an
      // insecure origin, and reading `.writeText` off undefined would throw a
      // TypeError that the catch below would report as a copy failure by accident
      // rather than by decision. `?.` makes the absent case an explicit throw.
      const write = navigator.clipboard?.writeText;
      if (!write) throw new Error('clipboard unavailable');
      await write.call(navigator.clipboard, text);
      setCopied({ id, ok: true });
      timer.current = setTimeout(() => setCopied(null), 2000);
    } catch {
      // Stays until the next attempt: a failure that cleared itself after two
      // seconds would look identical to never having pressed the button.
      setCopied({ id, ok: false });
    }
  }

  const label = (id: string, idle: string) => {
    if (copied?.id !== id) return idle;
    return copied.ok ? 'Copied' : "Couldn't copy";
  };

  /*
    Nothing here is persisted, so closing with edits destroys them. That is fine for a
    template and unacceptable silently — an editor that drops work without asking
    reads as a bug, not as a stopgap. Every dismissal path routes through here.
  */
  function requestClose() {
    if (dirty) setConfirmDiscard(true);
    else onClose();
  }

  /*
    Escape fires `cancel` before `close` on a modal dialog, so this is the only hook
    that can stop the platform closing it out from under an unsaved edit.

    Bound natively rather than as an onCancel prop: `cancel` does not bubble, which
    puts it outside React's delegated event path, and its support across React
    versions has been inconsistent enough that a silently-unbound handler here would
    mean Escape throws away edits with no prompt — the exact failure this prevents.
  */
  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    const onCancel = (event: Event) => {
      if (!dirty) return;
      event.preventDefault();
      setConfirmDiscard(true);
    };
    dialog.addEventListener('cancel', onCancel);
    return () => dialog.removeEventListener('cancel', onCancel);
  }, [dirty]);

  // The click target of a native <dialog> spans the backdrop, so a bare onClick
  // would also fire for clicks on the content. Comparing target to the dialog
  // itself is what distinguishes "clicked outside" from "clicked a paragraph".
  function onBackdropClick(event: MouseEvent<HTMLDialogElement>) {
    if (event.target === dialogRef.current) requestClose();
  }

  const allText = JOB_TEMPLATE.map((s) => sectionText(s.heading, draft[s.id] ?? '')).join('\n\n');

  return (
    <dialog
      ref={dialogRef}
      aria-labelledby="job-template-title"
      aria-describedby="job-template-caveat"
      onClose={onClose}
      onClick={onBackdropClick}
      className={cx(
        // m-auto is load-bearing: a native <dialog> centres itself with `margin: auto`,
        // and Tailwind's preflight resets margin to 0 on every element — which is why
        // it renders pinned to the top-left corner without this.
        'm-auto w-full max-w-2xl rounded-xl bg-bg-surface p-0 text-text-primary shadow-lg backdrop:bg-bg-overlay',
        // No z-index: the top layer sits above every stacking context by definition,
        // so --z-modal would be a value that never decides anything.
        'max-h-[var(--layout-modal-max-height)] overflow-hidden',
      )}
    >
      <div className="flex max-h-[var(--layout-modal-max-height)] flex-col">
        <div className="flex items-start gap-4 border-b border-border-subtle p-6">
          <div className="flex-1">
            <h2 id="job-template-title" className="font-display text-page-title text-text-primary">
              Job description template
            </h2>
            {/*
              Referenced by aria-describedby so a screen reader hears the caveat on
              open. "Nothing is saved" is the one thing a recruiter must not have to
              discover by losing work.
            */}
            <p id="job-template-caveat" className="mt-1 text-body text-text-secondary">
              Edit it here, then copy it into your job post. Nothing is saved and no job is created — your edits are
              gone when this closes.
            </p>
          </div>
          <Button variant="secondary" onClick={() => void copy('all', allText)}>
            {label('all', 'Copy all')}
          </Button>
          <Button variant="ghost" aria-label="Close" onClick={requestClose}>
            ✕
          </Button>
        </div>

        <div className="flex-1 overflow-y-auto p-6">
          {JOB_TEMPLATE.map((section) => (
            <section key={section.id} className="border-b border-border-subtle py-4 first:pt-0 last:border-0 last:pb-0">
              <div className="flex items-center gap-4">
                <h3 id={`job-template-${section.id}`} className="flex-1 text-card-title text-text-primary">
                  {section.heading}
                </h3>
                <button
                  type="button"
                  onClick={() => void copy(section.id, sectionText(section.heading, draft[section.id] ?? ''))}
                  className={cx(
                    buttonClass('ghost'),
                    // The failure label is colour AND words: a red "Copy" would carry
                    // the outcome in hue alone, which #15 rules out.
                    copied?.id === section.id && !copied.ok && 'text-feedback-danger-fg',
                  )}
                >
                  {label(section.id, 'Copy')}
                </button>
              </div>
              {/*
                Labelled by its own heading rather than a visually-hidden <label>: the
                heading is already the field's name on screen, and a second one would
                make a screen reader read it twice.
              */}
              <textarea
                aria-labelledby={`job-template-${section.id}`}
                value={draft[section.id] ?? ''}
                onChange={(event) => setDraft((d) => ({ ...d, [section.id]: event.target.value }))}
                rows={section.body.length + 1}
                className={cx(
                  'mt-2 w-full resize-y rounded-md border border-border-default bg-bg-surface p-3',
                  'text-body text-text-secondary focus:border-border-focus',
                )}
              />
            </section>
          ))}
        </div>

        {/*
          Disabled, with the reason stated next to it — the same treatment sign-in.tsx
          gives the SSO buttons, and for the same reason.

          There is no POST /v1/jobs. The API exposes exactly two POST routes, both on
          /auth, and `jobs` has no description column, so nothing here could be
          persisted even if a route existed. An enabled button would either do nothing
          on click or 404, and a control that looks live and isn't is worse than one
          that says so. Disabled also keeps it out of the tab order, so the keyboard
          path has no dead stop.

          Making it real is a spec-sized change across three boundaries: a migration
          plus RLS in packages/db, CreateJobRequest in packages/contracts, the route
          and its audit_log write in apps/api, then this button.
        */}
        <div className="flex items-center justify-end gap-3 border-t border-border-subtle p-6">
          <p className="flex-1 text-meta text-text-tertiary">
            Creating jobs needs the new-job wizard, which isn’t built yet. Copy the text out for now.
          </p>
          <Button variant="primary" disabled>
            Create job
          </Button>
        </div>

        {confirmDiscard ? (
          <div className="flex items-center gap-3 border-t border-border-subtle bg-feedback-warning-bg p-4">
            <p className="flex-1 text-body text-text-primary">Discard your edits? They are not saved anywhere.</p>
            <Button variant="secondary" onClick={() => setConfirmDiscard(false)}>
              Keep editing
            </Button>
            <Button variant="primary" onClick={onClose}>
              Discard
            </Button>
          </div>
        ) : null}
      </div>

      {/*
        One region for every button's outcome. Without it the label change is a purely
        visual event — a screen-reader user presses Copy and is told nothing at all.
      */}
      <p aria-live="polite" className="sr-only">
        {copied ? (copied.ok ? 'Copied to clipboard' : 'Could not copy to clipboard') : ''}
      </p>
    </dialog>
  );
}
