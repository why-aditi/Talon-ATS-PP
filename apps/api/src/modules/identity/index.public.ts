// The module's published interface — the only legal import target from other
// modules. Everything not exported here is private, and that emphatically
// includes `LocalIdentityProvider`: implementations are reached through the
// container, as the `IdentityProvider` interface, or not at all (spec 001 §6.1).
export { identityModule as authRoutes } from './index.js';
export { registerIdentity } from './container.js';
export type {
  AuthResult,
  CreateUserInput,
  IdentityProvider,
  VerifiedIdentity,
} from './provider.js';
export type { IdentityService } from './service.js';
