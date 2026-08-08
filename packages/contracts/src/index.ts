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
} from './pipeline.js';

export { ProblemSchema, type Problem } from './problem.js';
export { ERROR_TYPES, type ErrorType } from './errors.js';
