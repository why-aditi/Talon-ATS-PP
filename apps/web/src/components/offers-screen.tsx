'use client';

/**
 * Offers — reference screen 07, spec 007 §7.4.
 *
 * Two components: the list (which has no reference — OQ-2) and the builder, which is
 * the screenshot. Both read-only; "Send for approval" and "Preview letter" render as
 * drawn and do nothing. Send is the worst candidate for a mock of the four inert
 * actions in this spec, because it starts an approval chain — state that outlives the
 * screen (§6).
 */
import type { Offer, OfferStatus } from '@talon/contracts';
import Link from 'next/link';
import { formatCompactMoney, useOffer, useOffers } from '../lib/people-query';
import { Avatar, Button, Eyebrow, cx } from './ui';

const STATUS: Record<OfferStatus, { label: string; className: string }> = {
  draft: { label: 'Draft', className: 'bg-status-draft-bg text-status-draft-text' },
  pending_approval: { label: 'Pending approval', className: 'bg-status-pending-bg text-status-pending-text' },
  approved: { label: 'Approved', className: 'bg-status-confirmed-bg text-status-confirmed-text' },
  sent: { label: 'Sent', className: 'bg-status-active-bg text-status-active-text' },
  accepted: { label: 'Accepted', className: 'bg-status-active-bg text-status-active-text' },
  declined: { label: 'Declined', className: 'bg-feedback-danger-bg text-feedback-danger-fg' },
};

/** State as text as well as a dot — the dot alone would carry it by colour (§4.15). */
const APPROVAL = {
  approved: { label: 'Approved', dot: 'bg-feedback-success-fg', text: 'text-feedback-success-fg' },
  pending: { label: 'Pending', dot: 'bg-feedback-warning-fg', text: 'text-feedback-warning-fg' },
  rejected: { label: 'Rejected', dot: 'bg-feedback-danger-fg', text: 'text-feedback-danger-fg' },
} as const;

function StatusPill({ status }: { status: OfferStatus }) {
  const { label, className } = STATUS[status];
  return <span className={cx('inline-flex items-center rounded-sm px-2 py-px text-caption', className)}>{label}</span>;
}

const formatDate = (iso: string) =>
  new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' }).format(
    new Date(`${iso}T00:00:00Z`),
  );

export function OffersScreen() {
  const query = useOffers();

  return (
    <div className="flex flex-1 flex-col gap-4 p-[var(--layout-page-gutter)]">
      <h1 className="text-page-title text-text-primary">Offers</h1>

      <div className="overflow-hidden rounded-lg border border-border-subtle bg-bg-surface">
        {query.isPending ? (
          <div className="h-[var(--layout-row-height)] animate-pulse bg-bg-surface-sunken" />
        ) : query.isError ? (
          <p className="p-6 text-body text-text-secondary">Offers could not be loaded.</p>
        ) : query.data.items.length === 0 ? (
          <p className="p-6 text-body text-text-secondary">No offers yet.</p>
        ) : (
          <ul>
            {query.data.items.map((offer) => (
              <li key={offer.id} className="border-b border-border-subtle last:border-0">
                <Link
                  href={`/offers/${offer.id}`}
                  className="grid h-[var(--layout-row-height)] grid-cols-[minmax(0,1fr)_auto_auto_auto] items-center gap-4 px-4 hover:bg-action-ghost-bg-hover"
                >
                  <span className="flex min-w-0 items-center gap-3">
                    <Avatar id={offer.candidateId} name={offer.candidateName} size={24} />
                    <span className="truncate text-body-strong text-text-primary">{offer.candidateName}</span>
                  </span>
                  <span className="text-body text-text-secondary">{offer.level}</span>
                  <span>
                    <StatusPill status={offer.status} />
                  </span>
                  {/* No comp on this row, and none in the payload — OfferSummarySchema
                      does not declare it, so the omission is structural (§5.1). */}
                  <span className="text-body text-text-tertiary tabular-nums">v{offer.version}</span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function Term({ label, value, badge }: { label: string; value: string; badge?: string }) {
  return (
    <div className="flex items-center gap-4 border-b border-border-subtle py-4 last:border-0">
      <dt className="w-20 shrink-0 text-body text-text-secondary">{label}</dt>
      <dd className="flex min-w-0 flex-1 items-center justify-between gap-3">
        <span className="text-body-strong text-text-primary">{value}</span>
        {badge ? (
          <span className="shrink-0 rounded-sm bg-feedback-success-bg px-2 py-px text-caption text-feedback-success-fg">
            {badge}
          </span>
        ) : null}
      </dd>
    </div>
  );
}

function Terms({ offer }: { offer: Offer }) {
  // Replaced wholesale, not blanked. The field names — base, equity, band, sign-on —
  // are themselves the information being withheld, so rendering the labels with empty
  // values would leak the shape of what is hidden (§7.4, §10 case 9).
  if (offer.comp === null) {
    return (
      <div className="rounded-lg border border-border-subtle bg-bg-surface px-5 py-6">
        <p className="text-body text-text-secondary">Compensation is not visible to your role.</p>
      </div>
    );
  }

  const c = offer.comp;
  return (
    <div className="rounded-lg border border-border-subtle bg-bg-surface px-5">
      <dl>
        <Term label="Candidate" value={offer.candidateName} />
        <Term label="Level" value={offer.level} />
        <Term
          label="Base salary"
          value={formatCompactMoney(c.baseCents, c.currency)}
          badge={`band ${formatCompactMoney(c.band.minCents, c.band.currency)} to ${formatCompactMoney(c.band.maxCents, c.band.currency)}`}
        />
        <Term
          label="Equity"
          value={`${c.equityUnits.toLocaleString('en-US')} options over ${c.equityYears} yr`}
          badge={c.equityNote}
        />
        <Term label="Sign-on bonus" value={formatCompactMoney(c.signOnCents, c.currency)} />
        <Term label="Start date" value={formatDate(offer.startDate)} />
        <Term label="Expires" value={formatDate(offer.expiresDate)} />
      </dl>
      <div className="flex gap-3 py-5">
        <Button variant="primary" aria-disabled="true" title="Approvals need the real endpoint — see spec 007 §6">
          Send for approval
        </Button>
        <Button aria-disabled="true" title="Letter preview ships with the offers endpoint">
          Preview letter
        </Button>
      </div>
    </div>
  );
}

export function OfferDetail({ offerId }: { offerId: string }) {
  const query = useOffer(offerId);

  if (query.isPending) {
    return (
      <div className="flex flex-1 gap-4 p-[var(--layout-page-gutter)]">
        <div className="h-20 flex-1 animate-pulse rounded-lg bg-bg-surface-sunken" />
        <div className="h-20 flex-1 animate-pulse rounded-lg bg-bg-surface-sunken" />
      </div>
    );
  }

  if (query.isError) {
    return <p className="p-[var(--layout-page-gutter)] text-body text-text-secondary">This offer could not be loaded.</p>;
  }

  const offer = query.data;

  return (
    <div className="flex flex-1 gap-6 overflow-y-auto p-[var(--layout-page-gutter)]">
      <div className="flex min-w-0 flex-1 flex-col gap-4">
        <div className="flex items-center gap-3">
          <h1 className="text-section-title text-text-primary">Offer: {offer.candidateName}</h1>
          <StatusPill status={offer.status} />
          <span className="ml-auto text-caption text-text-tertiary">
            v{offer.version} · edited{' '}
            <time dateTime={offer.editedAt}>
              {new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' }).format(
                new Date(offer.editedAt),
              )}
            </time>
          </span>
        </div>

        <Terms offer={offer} />

        <Eyebrow className="mt-2">Approval chain</Eyebrow>
        <ol className="flex flex-col gap-3">
          {offer.approvals.map((step) => {
            const state = APPROVAL[step.state];
            return (
              <li
                key={step.id}
                className="flex items-center gap-3 rounded-lg border border-border-subtle bg-bg-surface px-5 py-4"
              >
                <span className={cx('size-2 shrink-0 rounded-full', state.dot)} aria-hidden="true" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-body-strong text-text-primary">{step.name}</span>
                  <span className="block truncate text-body text-text-secondary">{step.role}</span>
                </span>
                <span className={cx('shrink-0 text-body', state.text)}>{state.label}</span>
              </li>
            );
          })}
        </ol>
      </div>

      {/*
        Paragraphs as text nodes, never dangerouslySetInnerHTML. Letters are fixtures
        today; the moment they are composed from candidate-supplied fields they are
        attacker-adjacent, and §4.17's reasoning about resumes applies to this pane.
      */}
      <aside className="min-w-0 flex-1 rounded-lg border border-border-subtle bg-bg-surface p-8">
        <h2 className="mb-6 text-body-lg text-text-primary">Talon Inc. Offer of Employment</h2>
        <div className="flex flex-col gap-4">
          {offer.letterBody.map((paragraph) => (
            <p key={paragraph} className="text-body-lg text-text-primary">
              {paragraph}
            </p>
          ))}
        </div>
      </aside>
    </div>
  );
}
