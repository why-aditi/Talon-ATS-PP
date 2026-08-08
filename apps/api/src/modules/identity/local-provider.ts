/**
 * LocalIdentityProvider — dev and test (spec 001 §6.1). Signs its own HS256
 * tokens and keeps password hashes in `local_identities`.
 *
 * Concrete class: importable only from inside `modules/identity/`. Everything
 * else resolves `identityProvider` from the container and sees the interface.
 *
 * The claim shape it emits (§6.2) comes from `session.ts`, which
 * `CognitoIdentityProvider` also calls — "identical in both implementations" is
 * one function, not two files that agree today.
 */
import { randomUUID } from 'node:crypto';
import { AccessTokenClaimsSchema } from '@talon/contracts';
import type { AuthConfig } from '../../config.js';
import { JwtError, verifyJwt } from './jwt.js';
import { burnVerification, hashPassword, verifyPassword } from './password.js';
import {
  IdentityFailure,
  type AuthResult,
  type CreateUserInput,
  type IdentityProvider,
  type VerifiedIdentity,
} from './provider.js';
import type { IdentityRepository, UserRecord } from './repository.js';
import { issueTokens, toSessionUser } from './session.js';
import { generateTotpSecret, totpUri, verifyTotpCode } from './totp.js';

function failureFor(error: JwtError): IdentityFailure {
  switch (error.failure) {
    case 'expired':
      return new IdentityFailure('token_expired', 'The access token has expired.');
    case 'not_yet_valid':
      return new IdentityFailure('token_not_yet_valid', 'The token is dated in the future.');
    default:
      return new IdentityFailure('invalid_token', 'The token could not be verified.');
  }
}

export class LocalIdentityProvider implements IdentityProvider {
  readonly #repository: IdentityRepository;
  readonly #config: AuthConfig;

  constructor({
    identityRepository,
    authConfig,
  }: {
    identityRepository: IdentityRepository;
    authConfig: AuthConfig;
  }) {
    this.#repository = identityRepository;
    this.#config = authConfig;
  }

  async verifyToken(token: string): Promise<VerifiedIdentity> {
    let claims: Record<string, unknown>;
    try {
      claims = verifyJwt(token, {
        secret: this.#config.secret,
        issuer: this.#config.issuer,
        audience: this.#config.audience,
        expLeewaySeconds: this.#config.expLeewaySeconds,
      });
    } catch (err) {
      throw err instanceof JwtError ? failureFor(err) : err;
    }
    // Signature verified; shape still has to be checked, because "signed by us"
    // says nothing about "issued by a version of us that agreed on the claims".
    const parsed = AccessTokenClaimsSchema.safeParse(claims);
    if (!parsed.success) {
      throw new IdentityFailure('invalid_token', 'The token is missing required claims.');
    }
    return { sub: parsed.data.sub, email: parsed.data.email, claims: parsed.data };
  }

  async createUser(input: CreateUserInput): Promise<{ sub: string }> {
    const sub = input.sub ?? randomUUID();
    await this.#repository.putIdentity({
      sub,
      email: input.email,
      passwordHash: await hashPassword(input.password),
    });
    return { sub };
  }

  async initiatePasswordAuth(email: string, password: string): Promise<AuthResult> {
    const identity = await this.#repository.findIdentityByEmail(email);
    // Same work, same answer, whether the email is unknown or the password is
    // wrong: anything else is an account-enumeration oracle.
    const ok = identity
      ? await verifyPassword(password, identity.passwordHash)
      : await burnVerification(password);
    if (!identity || !ok) {
      throw new IdentityFailure('invalid_credentials', 'Email or password is incorrect.');
    }

    const byEmail = await this.#requireUser(() => this.#repository.findUserByEmail(email));
    // Resolve again by SUBJECT, which is the lookup the request chain actually
    // uses. `auth_user_by_email` finds anyone; `auth_user_by_sub` matches
    // `users.id` only where `external_id is null` (migration 0004), so a person
    // currently provisioned against Cognito is NOT reachable by their id.
    //
    // Without this, flipping TALON_IDENTITY_PROVIDER back to local without
    // re-running the identity seed mints a token that signs in perfectly and
    // then 401s on every subsequent request — the user sees "signed in",
    // immediately followed by "session invalid", with nothing naming the cause.
    // One extra query on the sign-in path buys failing at the door instead.
    const user = await this.#requireUser(() => this.#repository.findUserBySub(byEmail.id));

    if (user.mfaEnabled) {
      if (!identity.totpSecret) {
        // Fail closed. An MFA-required account with nothing enrolled cannot sign
        // in until enrolment happens out of band — the alternative is letting a
        // password alone satisfy a policy that says it must not.
        throw new IdentityFailure('mfa_not_enrolled', 'This account requires an authenticator app.');
      }
      return { status: 'mfa_required', challenge: 'totp' };
    }

    return {
      status: 'authenticated',
      tokens: issueTokens(user, this.#config),
      user: toSessionUser(user),
    };
  }

  async refreshSession(refreshToken: string): Promise<AuthResult> {
    let claims: Record<string, unknown>;
    try {
      claims = verifyJwt(refreshToken, {
        secret: this.#config.secret,
        issuer: this.#config.issuer,
        // A token minted for the api audience is refused here, and vice versa.
        audience: this.#config.refreshAudience,
        expLeewaySeconds: this.#config.expLeewaySeconds,
      });
    } catch (err) {
      throw err instanceof JwtError ? failureFor(err) : err;
    }
    const sub = claims['sub'];
    if (typeof sub !== 'string') {
      throw new IdentityFailure('invalid_token', 'The refresh token is missing its subject.');
    }

    // Claims are re-read from `users`, never copied from the old token: a role
    // or tenant change takes effect at the next refresh instead of being frozen
    // for the life of a 30-day token.
    const user = await this.#requireUser(() => this.#repository.findUserBySub(sub));
    this.#assertNotInvalidated(user, claims['iat']);
    return {
      status: 'authenticated',
      tokens: issueTokens(user, this.#config),
      user: toSessionUser(user),
    };
  }

  async enrollTotp(sub: string): Promise<{ secretUri: string }> {
    const identity = await this.#repository.findIdentityBySub(sub);
    if (!identity) throw new IdentityFailure('invalid_credentials', 'No such identity.');
    const secret = generateTotpSecret();
    await this.#repository.setTotpSecret(sub, secret);
    return { secretUri: totpUri(secret, { issuer: this.#config.issuer, account: identity.email }) };
  }

  async verifyTotp(sub: string, code: string): Promise<boolean> {
    const identity = await this.#repository.findIdentityBySub(sub);
    // No secret means not enrolled, and not enrolled can never verify. This is
    // the check that stops "MFA passed" from meaning "MFA was never set up".
    if (!identity?.totpSecret) return false;
    return verifyTotpCode(identity.totpSecret, code);
  }

  async #requireUser(load: () => Promise<UserRecord | null>): Promise<UserRecord> {
    const user = await load();
    if (!user) {
      // Credentials were good but this deployment has no `users` row — §9 edge
      // case 1. A distinct failure, because it is an operator problem and no
      // amount of retyping a password fixes it.
      throw new IdentityFailure('user_not_provisioned', 'No user record exists for this identity.');
    }
    return user;
  }

  #assertNotInvalidated(user: UserRecord, iat: unknown): void {
    if (!user.tokensValidAfter) return;
    if (typeof iat !== 'number' || iat * 1000 < user.tokensValidAfter.getTime()) {
      throw new IdentityFailure('invalid_token', 'This token was invalidated.');
    }
  }
}
