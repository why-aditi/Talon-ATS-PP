/**
 * Contracts for the review inbox, candidates, offers and reports — spec 007 §4.
 *
 * These describe endpoints that do not exist yet. Spec 007 serves them from a mock
 * under `/api/mock/*` so the four screens can be built; the real routes will implement
 * these shapes unchanged, which is the whole reason the schemas live here rather than
 * beside the fixtures. Spec 003 did the same thing for the board and the board's real
 * endpoint landed against an unmodified `BoardSchema`.
 *
 * Response objects are plain `z.object` and NOT `.strict()`. Stripping is the property
 * the routes rely on: `applications/routes.ts` parses on the way out so a field added
 * to a record later cannot leak through, and `.strict()` would turn that silent, safe
 * strip into a 500.
 */
import { z } from 'zod';
import { CanonicalStageSchema, CompBandSchema, centsSchema } from './jobs.js';
import { ApplicationStatusSchema, SourceSchema } from './pipeline.js';

// ---------------------------------------------------------------------------
// Review inbox — reference screen 04
// ---------------------------------------------------------------------------

/**
 * Closed unions, not free strings. Each drives a pill whose colour the design
 * defines for exactly these cases; a fixture inventing `stackMatch: 'excellent'`
 * would render an unstyled pill rather than fail, and nobody would notice.
 */
export const StackMatchSchema = z.enum(['strong', 'partial', 'weak']);
export type StackMatch = z.infer<typeof StackMatchSchema>;

export const LocationFitSchema = z.enum(['remote_ok', 'onsite', 'relocation']);
export type LocationFit = z.infer<typeof LocationFitSchema>;

export const ReviewSignalSchema = z.object({
  yearsExperience: z.number().int().min(0),
  stackMatch: StackMatchSchema,
  locationFit: LocationFitSchema,
});
export type ReviewSignal = z.infer<typeof ReviewSignalSchema>;

export const ReviewQueueItemSchema = z.object({
  /** The application. This is what an advance or reject would address. */
  id: z.string().uuid(),
  /** The candidate. `Avatar` hashes its hue off this, so one person keeps one colour
   *  across the queue, the board and their profile (spec 003). */
  candidateId: z.string().uuid(),
  name: z.string(),
  currentTitle: z.string(),
  currentCompany: z.string(),
  location: z.string(),
  appliedDaysAgo: z.number().int().min(0),
  /** Null when they applied without one — the card is omitted rather than rendered
   *  empty (spec 007 §10 case 3). */
  coverNote: z.string().nullable(),
  resumeHighlights: z.array(z.string()).max(6),
  signal: ReviewSignalSchema,
});
export type ReviewQueueItem = z.infer<typeof ReviewQueueItemSchema>;

export const ReviewQueueResponseSchema = z.object({
  items: z.array(ReviewQueueItemSchema),
  waiting: z.number().int().min(0),
  /**
   * Carried, not derived. The screen reads "0 of 4 reviewed today" over a progress
   * rule, and today's reviewed count is not `items.length` arithmetic — the items
   * are what remain, so anything computed from them would always read zero.
   */
  reviewedToday: z.number().int().min(0),
});
export type ReviewQueueResponse = z.infer<typeof ReviewQueueResponseSchema>;

// ---------------------------------------------------------------------------
// Candidates — reference screen 05
// ---------------------------------------------------------------------------

export const CandidateSummarySchema = z.object({
  /** The candidate, because the row links to `/candidates/:id`. */
  id: z.string().uuid(),
  /** The application it summarises. A candidate on two jobs has two rows. */
  applicationId: z.string().uuid(),
  name: z.string(),
  currentTitle: z.string(),
  currentCompany: z.string(),
  jobTitle: z.string(),
  stage: CanonicalStageSchema,
  daysInStage: z.number().int().min(0),
  source: SourceSchema,
  status: ApplicationStatusSchema,
});
export type CandidateSummary = z.infer<typeof CandidateSummarySchema>;

export const ListCandidatesResponseSchema = z.object({
  items: z.array(CandidateSummarySchema),
});
export type ListCandidatesResponse = z.infer<typeof ListCandidatesResponseSchema>;

/**
 * Drives the timeline dot colour and nothing else. Closed for the same reason as
 * `StackMatchSchema`: the design names a colour per kind, and an unknown kind would
 * render a colourless dot on a screen where the dot is the only grouping cue.
 */
export const ActivityKindSchema = z.enum(['scheduling', 'scorecard', 'stage', 'email', 'note']);
export type ActivityKind = z.infer<typeof ActivityKindSchema>;

export const ActivityEntrySchema = z.object({
  id: z.string().uuid(),
  kind: ActivityKindSchema,
  title: z.string(),
  body: z.string(),
  /** UTC instant. Rendered in the viewer's IANA zone (§4.7) — never a pre-formatted
   *  string, or two people in two zones read the same wrong time. */
  at: z.string().datetime(),
});
export type ActivityEntry = z.infer<typeof ActivityEntrySchema>;

export const CandidateDetailsSchema = z.object({
  email: z.string(),
  phone: z.string(),
  source: z.string(),
  recruiterName: z.string(),
  /**
   * Nullable, never absent. Null carries two different meanings that the screen
   * renders differently, and the caller's scope is what tells them apart (§7.3):
   * with comp scope, null means "never stated"; without it, the row is not drawn at
   * all. An optional field would collapse both into "missing" and the API would have
   * no way to say which happened.
   */
  compExpectation: CompBandSchema.nullable(),
  noticePeriod: z.string().nullable(),
});
export type CandidateDetails = z.infer<typeof CandidateDetailsSchema>;

export const CandidateProfileSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  currentTitle: z.string(),
  currentCompany: z.string(),
  location: z.string(),
  stage: CanonicalStageSchema,
  /** The rail, in order. Sent rather than derived from the canonical enum because a
   *  job may override its stages and the rail must show that job's, not the default. */
  stages: z.array(z.string()),
  daysInStage: z.number().int().min(0),
  /** Null when there is nothing outstanding. The banner is then absent, not empty. */
  nextAction: z
    .object({ text: z.string(), href: z.string().nullable() })
    .nullable(),
  tabCounts: z.object({
    emails: z.number().int().min(0),
    interviews: z.number().int().min(0),
    scorecards: z.number().int().min(0),
    files: z.number().int().min(0),
  }),
  activity: z.array(ActivityEntrySchema),
  details: CandidateDetailsSchema,
  job: z.object({
    id: z.string().uuid(),
    title: z.string(),
    reference: z.string(),
    recruiterName: z.string(),
  }),
  links: z.array(z.object({ label: z.string(), href: z.string() })),
});
export type CandidateProfile = z.infer<typeof CandidateProfileSchema>;

// ---------------------------------------------------------------------------
// Offers — reference screen 07
// ---------------------------------------------------------------------------

export const OfferStatusSchema = z.enum([
  'draft',
  'pending_approval',
  'approved',
  'sent',
  'accepted',
  'declined',
]);
export type OfferStatus = z.infer<typeof OfferStatusSchema>;

export const ApprovalStateSchema = z.enum(['approved', 'pending', 'rejected']);
export type ApprovalState = z.infer<typeof ApprovalStateSchema>;

export const ApprovalStepSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  role: z.string(),
  state: ApprovalStateSchema,
});
export type ApprovalStep = z.infer<typeof ApprovalStepSchema>;

/**
 * Every amount is integer cents as a string and the currency is required with no
 * default (§4.9). A schema that defaulted to 'USD' would be an assumption wearing a
 * constraint: omission has to be a validation error, not a silent guess.
 */
export const OfferCompSchema = z.object({
  baseCents: centsSchema,
  currency: z.string().regex(/^[A-Z]{3}$/, 'alpha-3 currency code'),
  band: CompBandSchema,
  equityUnits: z.number().int().min(0),
  equityYears: z.number().int().min(1),
  /** Free text — the reference reads "band midpoint", which is a human judgement and
   *  not something derivable from the numbers beside it. */
  equityNote: z.string(),
  signOnCents: centsSchema,
});
export type OfferComp = z.infer<typeof OfferCompSchema>;

/** The fields a list row needs. Comp is not among them and cannot be — see §5.1. */
export const OfferSummarySchema = z.object({
  id: z.string().uuid(),
  candidateId: z.string().uuid(),
  candidateName: z.string(),
  level: z.string(),
  status: OfferStatusSchema,
  version: z.number().int().min(1),
  editedAt: z.string().datetime(),
});
export type OfferSummary = z.infer<typeof OfferSummarySchema>;

export const ListOffersResponseSchema = z.object({
  items: z.array(OfferSummarySchema),
});
export type ListOffersResponse = z.infer<typeof ListOffersResponseSchema>;

export const OfferSchema = OfferSummarySchema.extend({
  startDate: z.string().date(),
  expiresDate: z.string().date(),
  /**
   * Null for a caller without comp scope (§4.2). The screen replaces the whole terms
   * card rather than blanking its values, because the field labels — base, equity,
   * band, sign-on — are themselves the information being withheld.
   */
  comp: OfferCompSchema.nullable(),
  approvals: z.array(ApprovalStepSchema),
  /** Paragraphs, already composed. Rendered as text nodes, never as HTML — §4.17's
   *  reasoning about attacker-controlled documents applies to anything that reaches
   *  this pane once letters stop being fixtures. */
  letterBody: z.array(z.string()),
});
export type Offer = z.infer<typeof OfferSchema>;

// ---------------------------------------------------------------------------
// Reports — reference screen 08
// ---------------------------------------------------------------------------

export const TileKeySchema = z.enum([
  'time_to_hire',
  'offer_accept_rate',
  'active_candidates',
  'interviews_this_week',
]);
export type TileKey = z.infer<typeof TileKeySchema>;

export const TrendDirectionSchema = z.enum(['up', 'down', 'flat']);
export type TrendDirection = z.infer<typeof TrendDirectionSchema>;

export const ReportTileSchema = z.object({
  key: TileKeySchema,
  label: z.string(),
  /**
   * Pre-formatted: "24d", "86%", "9". Formatting a bare number here would mean the
   * component deciding whether a metric is days, points or a count — and the endpoint
   * is the only thing that knows.
   */
  value: z.string(),
  delta: z.string().nullable(),
  /** Paired with an arrow glyph so the delta is never communicated by colour alone
   *  (§4.15). This is why the direction is a field and not inferred from the text. */
  direction: TrendDirectionSchema,
});
export type ReportTile = z.infer<typeof ReportTileSchema>;

export const ConversionRowSchema = z.object({
  stage: CanonicalStageSchema,
  label: z.string(),
  count: z.number().int().min(0),
});
export type ConversionRow = z.infer<typeof ConversionRowSchema>;

/** Matches `color.semantic.source.*` one-to-one — the palette was cut for this legend. */
export const SourceKeySchema = z.enum(['referral', 'outbound', 'careers_page', 'agency']);
export type SourceKey = z.infer<typeof SourceKeySchema>;

export const SourceRowSchema = z.object({
  key: SourceKeySchema,
  label: z.string(),
  hires: z.number().int().min(0),
});
export type SourceRow = z.infer<typeof SourceRowSchema>;

export const WeekPointSchema = z.object({
  label: z.string(),
  count: z.number().int().min(0),
});
export type WeekPoint = z.infer<typeof WeekPointSchema>;

export const ReportsOverviewSchema = z.object({
  period: z.string(),
  tiles: z.array(ReportTileSchema),
  conversion: z.array(ConversionRowSchema),
  sources: z.array(SourceRowSchema),
  interviewsPerWeek: z.array(WeekPointSchema),
});
export type ReportsOverview = z.infer<typeof ReportsOverviewSchema>;
