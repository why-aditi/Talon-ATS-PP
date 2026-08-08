import { asClass, asValue, type AwilixContainer } from 'awilix';
import type { Cradle } from '../../context.js';
import { CognitoIdentityProvider } from './cognito-provider.js';
import { LocalIdentityProvider } from './local-provider.js';
import { IdentityRepository } from './repository.js';
import { IdentityService } from './service.js';

/**
 * The one place a concrete IdentityProvider is named — which is the entire point
 * of the interface, and why no other file may import an implementation. The
 * ESLint `moduleInternalPatterns` rule enforces it, and `eslint` is not a
 * suggestion here: a route that reached for `CognitoIdentityProvider` directly
 * would compile perfectly and quietly couple the whole app to AWS.
 *
 * Selection is by configuration, and **local is the default**. A clean clone
 * with no AWS account must still `pnpm dev` and sign in, so the AWS path is
 * opt-in (`TALON_IDENTITY_PROVIDER=cognito`) and never the fallback.
 */
export function registerIdentity(container: AwilixContainer<Cradle>): void {
  const { auth } = container.cradle.config;
  container.register({
    identityService: asClass(IdentityService).singleton(),
    identityRepository: asClass(IdentityRepository).singleton(),
  });

  if (auth.provider === 'cognito') {
    if (!auth.cognito) {
      // Unreachable via loadConfig, which validates at boot. Belt for a
      // hand-built ApiConfig in a test or a script.
      throw new Error('auth.provider is cognito but auth.cognito is missing');
    }
    container.register({
      cognitoConfig: asValue(auth.cognito),
      identityProvider: asClass(CognitoIdentityProvider).singleton(),
    });
    return;
  }

  container.register({ identityProvider: asClass(LocalIdentityProvider).singleton() });
}
