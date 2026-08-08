/**
 * The "next action" on a pipeline card (spec 004 §5).
 *
 * The reference board shows one on every card: "Review", "Call Tue", "Loop Thu",
 * "Offer out", "Starts Sep 1". Spec 003 invented these in the fixture because nothing
 * could produce them; defining the derivation is the price of removing that invention.
 *
 * The split is clean and worth stating: the VERB is a function of the canonical stage
 * and is available today. The QUALIFIER — which day the call is, which day the loop
 * starts, when a hire starts — belongs to scheduling and offers, and arrives with them.
 * So `Review` and `Offer out` reproduce exactly, and the other four lose their detail
 * until those subsystems exist. That is a visible regression against the reference and
 * it is deliberate: the alternative is an endpoint returning a value it cannot derive.
 */
import type { CanonicalStage } from './stages.js';

const VERBS: Record<CanonicalStage, string> = {
  applied: 'Review',
  screen: 'Call',
  onsite: 'Loop',
  offer: 'Offer out',
  hired: 'Hired',
  rejected: 'Rejected',
  withdrawn: 'Withdrawn',
};

/**
 * Stages whose action names a moment. Passing a qualifier for any other stage is a
 * caller bug rather than something to silently append — "Review Tue" is not a thing.
 */
const TAKES_QUALIFIER: ReadonlySet<CanonicalStage> = new Set<CanonicalStage>(['screen', 'onsite', 'hired']);

export function nextActionFor(stage: CanonicalStage, qualifier?: string | null): string {
  const verb = VERBS[stage];
  if (!qualifier || !TAKES_QUALIFIER.has(stage)) return verb;
  // `hired` replaces rather than appends: the reference reads "Starts Sep 1", not
  // "Hired Sep 1".
  return stage === 'hired' ? `Starts ${qualifier}` : `${verb} ${qualifier}`;
}
