/**
 * RFC 9457 problem+json (ARCHITECTURE §7). One error shape, one place that
 * renders it, `type` values from @talon/contracts so the ui can switch on them.
 */
import type { FastifyError, FastifyReply, FastifyRequest } from 'fastify';
import { ERROR_TYPES, ProblemSchema, type Problem } from '@talon/contracts';

export class HttpProblem extends Error {
  constructor(
    readonly status: number,
    readonly type: string,
    readonly title: string,
    readonly detail?: string,
    /** RFC 9457 §3.2 extension members, e.g. field-level validation errors. */
    readonly extensions?: Record<string, unknown>,
    /**
     * Response headers this problem requires to be actionable — `Retry-After`
     * on a 429 being the case that forced this parameter to exist. A status code
     * whose protocol-level companion header is missing is a status code the
     * client has to guess at.
     */
    readonly headers?: Record<string, string>,
  ) {
    super(detail ?? title);
    this.name = 'HttpProblem';
  }
}

export function notFound(detail?: string): HttpProblem {
  return new HttpProblem(404, ERROR_TYPES.NOT_FOUND, 'Not found', detail);
}

/** A request a schema cannot express — an opaque cursor that does not decode. */
export function badRequest(detail?: string): HttpProblem {
  return new HttpProblem(400, ERROR_TYPES.VALIDATION_FAILED, 'Validation failed', detail);
}

interface ParseFailure {
  readonly issues: readonly { readonly path: readonly (string | number)[]; readonly message: string }[];
}
interface SafeParser<T> {
  safeParse(value: unknown): { success: true; data: T } | { success: false; error: ParseFailure };
}

/**
 * Validates with a contract schema or throws a 400. Every route body, param and
 * query goes through this — an unvalidated `request.params.id` reaching a query
 * is how "cursor pointing at a deleted row" becomes "cursor pointing at
 * anything at all".
 */
export function parseOrThrow<T>(schema: SafeParser<T>, value: unknown, source: string): T {
  const result = schema.safeParse(value);
  if (result.success) return result.data;
  return (() => {
    throw new HttpProblem(
      400,
      ERROR_TYPES.VALIDATION_FAILED,
      'Validation failed',
      `The request ${source} did not match the expected shape.`,
      {
        errors: result.error.issues.map((issue) => ({
          path: issue.path.join('.'),
          message: issue.message,
        })),
      },
    );
  })();
}

function render(error: unknown, request: FastifyRequest): Problem {
  if (error instanceof HttpProblem) {
    return ProblemSchema.parse({
      type: error.type,
      title: error.title,
      status: error.status,
      ...(error.detail === undefined ? {} : { detail: error.detail }),
      instance: request.url,
      requestId: request.id,
      ...error.extensions,
    });
  }

  // Fastify's own errors (bad JSON body, unsupported media type, payload too
  // large) arrive with a statusCode. Anything else is ours and is a bug: the
  // message never reaches the client.
  const status = (error as FastifyError)?.statusCode ?? 500;
  if (status >= 400 && status < 500) {
    return ProblemSchema.parse({
      type: ERROR_TYPES.VALIDATION_FAILED,
      title: 'Bad request',
      status,
      detail: (error as FastifyError).message,
      instance: request.url,
      requestId: request.id,
    });
  }
  return ProblemSchema.parse({
    type: ERROR_TYPES.INTERNAL,
    title: 'Internal server error',
    status: 500,
    instance: request.url,
    requestId: request.id,
  });
}

export function problemErrorHandler(error: unknown, request: FastifyRequest, reply: FastifyReply): void {
  const problem = render(error, request);
  if (problem.status >= 500) request.log.error({ err: error }, 'unhandled error');
  sendProblem(reply, problem, error instanceof HttpProblem ? error.headers : undefined);
}

export function sendProblem(
  reply: FastifyReply,
  problem: Problem,
  headers?: Record<string, string>,
): void {
  // A 401 without a challenge is not a 401 anyone can act on (RFC 9110 §11.6.1).
  if (problem.status === 401) void reply.header('WWW-Authenticate', 'Bearer');
  for (const [name, value] of Object.entries(headers ?? {})) void reply.header(name, value);
  void reply.code(problem.status).type('application/problem+json').send(problem);
}
