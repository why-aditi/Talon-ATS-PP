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

  // Responses
  SessionUserSchema,
  type SessionUser,
  AuthTokensSchema,
  type AuthTokens,
  SignInResponseSchema,
  type SignInResponse,
  RefreshResponseSchema,
  type RefreshResponse,
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
} from './pipeline.js';

export { ProblemSchema, type Problem } from './problem.js';
export { ERROR_TYPES, type ErrorType } from './errors.js';
