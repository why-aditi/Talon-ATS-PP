import { asClass, type AwilixContainer } from 'awilix';
import type { Cradle } from '../../context.js';
import { LocalIdentityProvider } from './local-provider.js';
import { IdentityRepository } from './repository.js';
import { IdentityService } from './service.js';

/**
 * The one place a concrete IdentityProvider is named. Swapping Cognito in (spec
 * 002) is an edit to this line and nothing else — which is the entire point of
 * the interface, and why no other file may import an implementation.
 */
export function registerIdentity(container: AwilixContainer<Cradle>): void {
  container.register({
    identityProvider: asClass(LocalIdentityProvider).singleton(),
    identityService: asClass(IdentityService).singleton(),
    identityRepository: asClass(IdentityRepository).singleton(),
  });
}
