/**
 * Display strings for contract enums.
 *
 * These lived in the provisional pipeline contract and did not come across with it:
 * `@talon/contracts` describes what crosses the wire, and "Careers page" is a
 * rendering decision. The api has no use for them and shipping them from there would
 * make every copy change a contract change.
 */
import type { ApplicationStatus, Source } from '@talon/contracts';

export const SOURCE_LABELS: Record<Source, string> = {
  careers_page: 'Careers page',
  outbound: 'Outbound',
  referral: 'Referral',
  agency: 'Agency',
  import: 'Import',
};

export const STATUS_LABELS: Record<Exclude<ApplicationStatus, 'active'>, string> = {
  hired: 'Hired',
  rejected: 'Rejected',
  withdrawn: 'Withdrawn',
};
