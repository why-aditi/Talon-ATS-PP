/**
 * Request and instance decorations, and the awilix cradle they resolve from.
 *
 * Kept at the api root because the hooks, the composition root and every module
 * need the same types; a module that owned them would have to be imported across
 * a boundary by everything else.
 */
import type { AwilixContainer } from 'awilix';
import type { FastifyRequest } from 'fastify';
import type postgres from 'postgres';
import type { ApiConfig } from './config.js';
import type { AuthenticatedUser, TenantTransaction } from './request-context.js';
import type {
  IdentityProvider,
  IdentityService,
  VerifiedIdentity,
} from './modules/identity/index.public.js';
import type { JobsService } from './modules/jobs/index.public.js';

export interface Cradle {
  config: ApiConfig;
  /** Auth slice of config, registered separately so providers take only what they need. */
  authConfig: ApiConfig['auth'];
  sql: postgres.Sql;
  identityProvider: IdentityProvider;
  identityService: IdentityService;
  jobsService: JobsService;
  /**
   * Module-internal registrations. Typed `unknown` on purpose: awilix injects
   * them by name inside a module, and nothing outside one should be resolving a
   * repository from the container.
   */
  identityRepository: unknown;
  jobsRepository: unknown;
  /**
   * Registered only when `auth.provider === 'cognito'`, and typed `unknown` for
   * the same reason as the repositories: it is `modules/identity`'s business.
   * Its concrete type is `CognitoConfig` in config.ts — a plain interface, so
   * no AWS type reaches the composition root either.
   */
  cognitoConfig: unknown;
}

declare module 'fastify' {
  interface FastifyInstance {
    container: AwilixContainer<Cradle>;
  }
  interface FastifyRequest {
    /** Set by `authenticate`. */
    identity?: VerifiedIdentity;
    /** Set by `resolveTenant`. */
    user?: AuthenticatedUser;
    tenantId?: string;
    /** Set by `openTenantTransaction`. */
    tx?: TenantTransaction;
  }
}

/** Resolves this request's services. Registrations are singletons on the app. */
export function services(request: FastifyRequest): Cradle {
  return request.server.container.cradle;
}

/**
 * These are `?` because Fastify decorates a request before any hook has run, not
 * because a handler should ever cope with their absence: inside the
 * authenticated scope the chain has already set all three, and the
 * route-manifest test proves every non-public route is in that scope. A route
 * that somehow escapes it fails here with a 500 rather than serving data with no
 * caller and no tenant.
 */
function must<T>(value: T | undefined, what: string): T {
  if (value === undefined) {
    throw new Error(`${what} is missing: this route is not inside the authenticated scope`);
  }
  return value;
}

export const requireUser = (request: FastifyRequest): AuthenticatedUser =>
  must(request.user, 'request.user');

export const requireTx = (request: FastifyRequest): TenantTransaction =>
  must(request.tx, 'request.tx');

export const requireIdentity = (request: FastifyRequest): VerifiedIdentity =>
  must(request.identity, 'request.identity');
