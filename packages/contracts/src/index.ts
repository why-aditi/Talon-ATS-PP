export {
  // Enums
  JobStatusSchema,
  type JobStatus,
  CanonicalStageSchema,
  type CanonicalStage,

  // Query / params
  ListJobsQuerySchema,
  type ListJobsQuery,
  GetJobParamsSchema,
  type GetJobParams,

  // Response types
  CompBandSchema,
  type CompBand,
  StageDistributionSchema,
  type StageDistribution,
  RecruiterSummarySchema,
  type RecruiterSummary,
  JobSchema,
  type Job,

  // Envelope
  ListJobsResponseSchema,
  type ListJobsResponse,

  // Stage templates + create (spec 005)
  TemplateStageSchema,
  type TemplateStage,
  StageTemplateSchema,
  type StageTemplate,
  ListStageTemplatesResponseSchema,
  type ListStageTemplatesResponse,
  StageOverrideSchema,
  type StageOverride,
  CreateJobRequestSchema,
  type CreateJobRequest,
  UpdateJobRequestSchema,
  type UpdateJobRequest,
  JobConflictSchema,
  type JobConflict,
} from './jobs.js';

export {
  // Roles
  RoleSchema,
  type Role,

  // Token claims (spec 001 §6.2)
  SubjectSchema,
  AccessTokenClaimsSchema,
  type AccessTokenClaims,

  // Requests
  SignInRequestSchema,
  type SignInRequest,
  NewPasswordSchema,
  RefreshRequestSchema,
  type RefreshRequest,
  SsoRequestSchema,
  type SsoRequest,
  SsoResponseSchema,
  type SsoResponse,

  // Responses
  SessionUserSchema,
  type SessionUser,
  AuthTokensSchema,
  type AuthTokens,
  SignInResponseSchema,
  type SignInResponse,
  RefreshResponseSchema,
  type RefreshResponse,

  // Users (spec 005 §6.4)
  UserSummarySchema,
  type UserSummary,
  ListUsersQuerySchema,
  type ListUsersQuery,
  ListUsersResponseSchema,
  type ListUsersResponse,
} from './auth.js';

export {
  // Params
  GetBoardParamsSchema,
  type GetBoardParams,
  ApplicationParamsSchema,
  type ApplicationParams,

  // Board response
  SourceSchema,
  type Source,
  ApplicationStatusSchema,
  type ApplicationStatus,
  ApplicationCardSchema,
  type ApplicationCard,
  ColumnStatsSchema,
  type ColumnStats,
  BoardColumnSchema,
  type BoardColumn,
  BoardJobSchema,
  type BoardJob,
  BoardSchema,
  type Board,

  // Mutations
  MoveStageBodySchema,
  type MoveStageBody,
  ReorderBodySchema,
  type ReorderBody,
  StageConflictSchema,
  type StageConflict,
  // Candidate intake (spec 005 §4.5)
  CreateCandidateSchema,
  type CreateCandidate,
  CreateApplicationBodySchema,
  type CreateApplicationBody,
  CreateApplicationResponseSchema,
  type CreateApplicationResponse,
} from './pipeline.js';

export {
  // Enums (spec 004)
  RoundKindSchema,
  type RoundKind,
  InterviewStatusSchema,
  type InterviewStatus,
  LoopStatusSchema,
  type LoopStatus,

  // Availability
  BusyIntervalSchema,
  type BusyInterval,
  TimeWindowSchema,
  type TimeWindow,
  SchedulingPanelistSchema,
  type SchedulingPanelist,

  // Solve
  SolveBlockerSchema,
  type SolveBlocker,
  PlacedRoundSchema,
  type PlacedRound,
  ArrangementSchema,
  type Arrangement,
  SolveResultSchema,
  type SolveResult,

  // Loop
  RoundPanelistSchema,
  type RoundPanelist,
  ScheduledInterviewSchema,
  type ScheduledInterview,
  InterviewRoundSchema,
  type InterviewRound,
  LoopHoldSchema,
  type LoopHold,
  InterviewLoopSchema,
  type InterviewLoop,
  GetInterviewLoopParamsSchema,
  HoldLoopRequestSchema,
  type HoldLoopRequest,
  HoldLoopResponseSchema,
  type HoldLoopResponse,
  SendLoopRequestSchema,
  type SendLoopRequest,
  AvailabilityDriftSchema,
  SendLoopResponseSchema,
  type SendLoopResponse,
} from './scheduling.js';

export {
  // Review inbox (spec 007 §4.1)
  StackMatchSchema,
  type StackMatch,
  LocationFitSchema,
  type LocationFit,
  ReviewSignalSchema,
  type ReviewSignal,
  ReviewQueueItemSchema,
  type ReviewQueueItem,
  ReviewQueueResponseSchema,
  type ReviewQueueResponse,

  // Candidates (spec 007 §4.2, §4.3)
  CandidateSummarySchema,
  type CandidateSummary,
  ListCandidatesResponseSchema,
  type ListCandidatesResponse,
  ActivityKindSchema,
  type ActivityKind,
  ActivityEntrySchema,
  type ActivityEntry,
  CandidateDetailsSchema,
  type CandidateDetails,
  CandidateProfileSchema,
  type CandidateProfile,

  // Offers (spec 007 §4.4)
  OfferStatusSchema,
  type OfferStatus,
  ApprovalStateSchema,
  type ApprovalState,
  ApprovalStepSchema,
  type ApprovalStep,
  OfferCompSchema,
  type OfferComp,
  OfferSummarySchema,
  type OfferSummary,
  ListOffersResponseSchema,
  type ListOffersResponse,
  OfferSchema,
  type Offer,

  // Reports (spec 007 §4.5)
  TileKeySchema,
  type TileKey,
  TrendDirectionSchema,
  type TrendDirection,
  ReportTileSchema,
  type ReportTile,
  ConversionRowSchema,
  type ConversionRow,
  SourceKeySchema,
  type SourceKey,
  SourceRowSchema,
  type SourceRow,
  WeekPointSchema,
  type WeekPoint,
  ReportsOverviewSchema,
  type ReportsOverview,
} from './people.js';

export {
  // Async jobs (spec 008 §4)
  AsyncJobStatusSchema,
  type AsyncJobStatus,
  AsyncJobSchema,
  type AsyncJob,

  // CSV import (spec 008 §6)
  CreateImportRequestSchema,
  type CreateImportRequest,
  CreateImportResponseSchema,
  type CreateImportResponse,
  DelimiterSchema,
  EncodingSchema,
  ImportAnalysisSchema,
  type ImportAnalysis,
  ImportFieldSchema,
  type ImportField,
  DuplicateStrategySchema,
  type DuplicateStrategy,
  ImportMappingSchema,
  type ImportMapping,
  RowIssueSchema,
  type RowIssue,
  DuplicateMatchSchema,
  type DuplicateMatch,
  DryRunReportSchema,
  type DryRunReport,
  ImportParamsSchema,
  type ImportParams,
  CommitImportResponseSchema,
  type CommitImportResponse,
} from './imports.js';

export { ProblemSchema, type Problem } from './problem.js';
export { ERROR_TYPES, type ErrorType } from './errors.js';
