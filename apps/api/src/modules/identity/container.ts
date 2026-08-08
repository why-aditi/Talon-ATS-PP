import { asClass, asValue, type AwilixContainer } from 'awilix';
import type { Cradle } from '../../context.js';
import { CognitoIdentityProvider } from './cognito-provider.js';
import { IdentityRepository } from './repository.js';
import { IdentityService } from './service.js';

/**
 * The one place a concrete IdentityProvider is named — which is the entire point
 * of the interface, and why no other file may import an implementation. The
 * ESLint `moduleInternalPatterns` rule enforces it, and `eslint` is not a
 * suggestion here: a route that reached for `CognitoIdentityProvider` directly
 * would compile perfectly and quietly couple the whole app to AWS.
 *
 * There is exactly one implementation now (spec 002 open question 1, answered
 * "Cognito only"). The seam stays because it is what makes the identity provider
 * substitutable at all — spec 003's SSO work sits behind it, and `cognito-stub.ts`
 * substitutes the *network*, not the class, precisely because this file names
 * only one.
 *
 * There is deliberately no fallback branch. `loadConfig` refuses to produce an
 * `ApiConfig` without a pool id, a client id, a region and a real signing key,
 * so an under-configured deployment stops at boot rather than serving
 * unauthenticated traffic or 500ing every sign-in.
 */
export function registerIdentity(container: AwilixContainer<Cradle>): void {
  const { auth } = container.cradle.config;
  container.register({
    identityService: asClass(IdentityService).singleton(),
    identityRepository: asClass(IdentityRepository).singleton(),
    cognitoConfig: asValue(auth.cognito),
    identityProvider: asClass(CognitoIdentityProvider).singleton(),
  });
}
