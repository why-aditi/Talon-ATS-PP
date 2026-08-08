/**
 * A fake Cognito, stubbed at the NETWORK layer (CLAUDE.md §6).
 *
 * Two boundaries, both intercepted where the bytes leave the process rather than
 * where the code is convenient to mock:
 *
 *   1. The AWS SDK's HTTPS calls — redirected with `AWS_ENDPOINT_URL` to a real
 *      `node:http` server that speaks AWS JSON 1.1 (`x-amz-target` + a JSON
 *      body), which is exactly what the SDK sends. Nothing in `src/` knows this
 *      is happening; the client, the signer, the serializer, the deserializer and
 *      the retry middleware all run for real.
 *   2. The JWKS fetch — `globalThis.fetch` is replaced for the duration, and
 *      answers ONLY the pool's well-known URL. Every other URL throws, so an
 *      un-stubbed call is a loud failure and never a silent request to AWS.
 *
 * The point is that the suite exercises the adapter, not a hand-written double of
 * it. `CognitoIdentityProvider` maps SDK error *names* to `IdentityFailure`s, and
 * a mocked SDK would let us assert that mapping against names we invented. Here
 * the SDK's own deserializer produces the error object from an `__type` on the
 * wire, the way it will in production.
 *
 * Tokens are signed with a per-run RSA key, so `JwksVerifier` does real RS256
 * verification against a real JWKS document.
 */
import { createSign, generateKeyPairSync, randomUUID, type KeyObject } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

const TARGET_PREFIX = 'AWSCognitoIdentityProviderService.';

export interface StubUser {
  sub: string;
  email: string;
  password: string;
  /** Set to make the next sign-in answer a challenge instead of tokens. */
  challenge?: string;
}

/** Claims we can bend, so a token that must fail verification can be produced. */
export interface IdTokenOverrides {
  iss?: string;
  aud?: string;
  token_use?: string;
  iat?: number;
  exp?: number;
  auth_time?: number;
  kid?: string;
}

interface AwsError {
  status: number;
  type: string;
  message: string;
}

function awsError(type: string, message = type): AwsError {
  return { status: 400, type, message };
}

export class CognitoStub {
  readonly region = 'us-east-1';
  readonly userPoolId = 'us-east-1_stubpool';
  readonly clientId = 'stubclientid0000000000';
  readonly issuer = `https://cognito-idp.${this.region}.amazonaws.com/${this.userPoolId}`;

  readonly #kid = 'stub-key-1';
  readonly #privateKey: KeyObject;
  readonly #publicKey: KeyObject;
  #server: Server | undefined;
  #previousEnv: Record<string, string | undefined> = {};
  #previousFetch?: typeof globalThis.fetch;

  /** Every user the fake pool knows, keyed by lowercased email. */
  readonly users = new Map<string, StubUser>();
  /** Live refresh tokens → sub. Cognito's are opaque; so are these. */
  readonly refreshTokens = new Map<string, string>();
  /** Requests seen, so a test can assert what the adapter actually called. */
  readonly calls: { target: string; body: Record<string, unknown> }[] = [];

  /** Applied to the next id token minted. Cleared after one use. */
  nextIdTokenOverrides: IdTokenOverrides | undefined;
  /**
   * Fails every AdminInitiateAuth with this AWS error name until cleared.
   *
   * Sticky, not one-shot, and that is not a convenience: the SDK retries
   * throttling and 5xx errors on its own (three attempts by default), so a
   * one-shot error would be swallowed by the retry and the test would assert
   * the opposite of what it claims.
   */
  authError: string | undefined;

  constructor() {
    const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    this.#privateKey = privateKey;
    this.#publicKey = publicKey;
  }

  get jwksUri(): string {
    return `${this.issuer}/.well-known/jwks.json`;
  }

  addUser(email: string, password: string, sub = randomUUID()): StubUser {
    const user: StubUser = { sub, email, password };
    this.users.set(email.toLowerCase(), user);
    return user;
  }

  async start(): Promise<void> {
    const server = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on('data', (chunk: Buffer) => chunks.push(chunk));
      request.on('end', () => {
        const target = String(request.headers['x-amz-target'] ?? '').replace(TARGET_PREFIX, '');
        let body: Record<string, unknown> = {};
        try {
          body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as Record<
            string,
            unknown
          >;
        } catch {
          /* an empty body is a valid shape for some operations */
        }
        this.calls.push({ target, body });
        try {
          const result = this.#dispatch(target, body);
          response.writeHead(200, { 'content-type': 'application/x-amz-json-1.1' });
          response.end(JSON.stringify(result));
        } catch (err) {
          const error = err as AwsError;
          // The wire format the SDK's deserializer reads. `__type` is what
          // becomes `error.name`, which is what the adapter switches on.
          response.writeHead(error.status ?? 400, {
            'content-type': 'application/x-amz-json-1.1',
            'x-amzn-errortype': error.type,
          });
          response.end(JSON.stringify({ __type: error.type, message: error.message }));
        }
      });
    });
    this.#server = server;
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;

    // Dummy credentials, deliberately: the suite must pass with no AWS account
    // and no ambient profile. The SDK still signs every request with them, so
    // the signing middleware is exercised rather than skipped.
    this.#setEnv('AWS_ENDPOINT_URL', `http://127.0.0.1:${port}`);
    this.#setEnv('AWS_ACCESS_KEY_ID', 'stub-access-key');
    this.#setEnv('AWS_SECRET_ACCESS_KEY', 'stub-secret-key');
    this.#setEnv('AWS_SESSION_TOKEN', undefined);
    this.#setEnv('AWS_PROFILE', undefined);

    this.#previousFetch = globalThis.fetch;
    const jwksUri = this.jwksUri;
    type FetchInput = Parameters<typeof globalThis.fetch>[0];
    globalThis.fetch = (async (input: FetchInput) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      // Anything but the pool's key set is a bug in the test, not a fallback to
      // the real network. Failing loudly here is what keeps the suite offline.
      if (url !== jwksUri) throw new Error(`network stub: unexpected fetch to ${url}`);
      return new Response(JSON.stringify(this.jwks()), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof globalThis.fetch;
  }

  async stop(): Promise<void> {
    if (this.#previousFetch) globalThis.fetch = this.#previousFetch;
    for (const [name, value] of Object.entries(this.#previousEnv)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    this.#previousEnv = {};
    const server = this.#server;
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
    this.#server = undefined;
  }

  jwks(): { keys: unknown[] } {
    const jwk = this.#publicKey.export({ format: 'jwk' });
    return { keys: [{ ...jwk, kid: this.#kid, alg: 'RS256', use: 'sig' }] };
  }

  mintIdToken(sub: string, email: string, overrides: IdTokenOverrides = {}): string {
    const iat = overrides.iat ?? Math.floor(Date.now() / 1000);
    const header = { alg: 'RS256', typ: 'JWT', kid: overrides.kid ?? this.#kid };
    const claims = {
      sub,
      email,
      email_verified: true,
      iss: overrides.iss ?? this.issuer,
      aud: overrides.aud ?? this.clientId,
      token_use: overrides.token_use ?? 'id',
      auth_time: overrides.auth_time ?? iat,
      iat,
      exp: overrides.exp ?? iat + 3600,
      jti: randomUUID(),
      'cognito:username': sub,
    };
    const signingInput = `${b64(header)}.${b64(claims)}`;
    const signature = createSign('RSA-SHA256')
      .update(signingInput, 'utf8')
      .sign(this.#privateKey)
      .toString('base64url');
    return `${signingInput}.${signature}`;
  }

  // ── operations ────────────────────────────────────────────────────────────

  #dispatch(target: string, body: Record<string, unknown>): Record<string, unknown> {
    // Real Cognito rejects a request addressed at the wrong pool or client, so
    // the stub must too. Without this, deleting `ClientId` from a command still
    // passes every test here and fails only against AWS — which would make this
    // stub a way to keep a broken adapter green rather than a way to test one.
    if (body['UserPoolId'] !== undefined && body['UserPoolId'] !== this.userPoolId) {
      throw awsError('ResourceNotFoundException', `no pool ${String(body['UserPoolId'])}`);
    }
    if (body['ClientId'] !== undefined && body['ClientId'] !== this.clientId) {
      throw awsError('ResourceNotFoundException', `no client ${String(body['ClientId'])}`);
    }
    if (target.startsWith('Admin') && body['UserPoolId'] === undefined) {
      throw awsError('InvalidParameterException', `${target} requires UserPoolId`);
    }
    if (target === 'AdminInitiateAuth' && body['ClientId'] === undefined) {
      throw awsError('InvalidParameterException', 'AdminInitiateAuth requires ClientId');
    }
    switch (target) {
      case 'AdminInitiateAuth':
        return this.#adminInitiateAuth(body);
      case 'AdminCreateUser':
        return this.#adminCreateUser(body);
      case 'AdminGetUser':
        return this.#adminGetUser(body);
      case 'AdminSetUserPassword':
        return this.#adminSetUserPassword(body);
      default:
        throw awsError('InvalidParameterException', `stub does not implement ${target}`);
    }
  }

  #adminInitiateAuth(body: Record<string, unknown>): Record<string, unknown> {
    if (this.authError) throw awsError(this.authError);
    const flow = String(body['AuthFlow']);
    const parameters = (body['AuthParameters'] ?? {}) as Record<string, string>;

    let user: StubUser | undefined;
    if (flow === 'REFRESH_TOKEN_AUTH') {
      const sub = this.refreshTokens.get(parameters['REFRESH_TOKEN'] ?? '');
      user = sub ? [...this.users.values()].find((u) => u.sub === sub) : undefined;
      if (!user) throw awsError('NotAuthorizedException', 'Refresh Token has been revoked');
    } else if (flow === 'ADMIN_USER_PASSWORD_AUTH') {
      user = this.users.get((parameters['USERNAME'] ?? '').toLowerCase());
      if (!user) throw awsError('UserNotFoundException', 'User does not exist.');
      if (user.password !== parameters['PASSWORD']) {
        throw awsError('NotAuthorizedException', 'Incorrect username or password.');
      }
      if (user.challenge) {
        return { ChallengeName: user.challenge, Session: 'stub-session', ChallengeParameters: {} };
      }
    } else {
      throw awsError('InvalidParameterException', `unsupported AuthFlow ${flow}`);
    }

    const overrides = this.nextIdTokenOverrides ?? {};
    this.nextIdTokenOverrides = undefined;
    const idToken = this.mintIdToken(user.sub, user.email, overrides);
    // Cognito only rotates the refresh token when rotation is enabled on the app
    // client; REFRESH_TOKEN_AUTH otherwise omits it. Modelled: a refresh returns
    // no new one, which is the case `cognito-provider` has to carry forward.
    const result: Record<string, unknown> = {
      AccessToken: this.mintIdToken(user.sub, user.email, { ...overrides, token_use: 'access' }),
      IdToken: idToken,
      ExpiresIn: 3600,
      TokenType: 'Bearer',
    };
    if (flow !== 'REFRESH_TOKEN_AUTH') {
      const refreshToken = `refresh-${randomUUID()}`;
      this.refreshTokens.set(refreshToken, user.sub);
      result['RefreshToken'] = refreshToken;
    }
    return { AuthenticationResult: result };
  }

  #adminCreateUser(body: Record<string, unknown>): Record<string, unknown> {
    const email = String(body['Username'] ?? '').toLowerCase();
    if (this.users.has(email)) {
      throw awsError('UsernameExistsException', 'User account already exists');
    }
    const user = this.addUser(email, '');
    return {
      User: {
        Username: user.sub,
        Attributes: [
          { Name: 'sub', Value: user.sub },
          { Name: 'email', Value: user.email },
        ],
        UserStatus: 'FORCE_CHANGE_PASSWORD',
        Enabled: true,
      },
    };
  }

  #adminGetUser(body: Record<string, unknown>): Record<string, unknown> {
    const user = this.users.get(String(body['Username'] ?? '').toLowerCase());
    if (!user) throw awsError('UserNotFoundException', 'User does not exist.');
    return {
      Username: user.sub,
      UserAttributes: [
        { Name: 'sub', Value: user.sub },
        { Name: 'email', Value: user.email },
      ],
      Enabled: true,
    };
  }

  #adminSetUserPassword(body: Record<string, unknown>): Record<string, unknown> {
    const user = this.users.get(String(body['Username'] ?? '').toLowerCase());
    if (!user) throw awsError('UserNotFoundException', 'User does not exist.');
    user.password = String(body['Password'] ?? '');
    return {};
  }

  #setEnv(name: string, value: string | undefined): void {
    this.#previousEnv[name] = process.env[name];
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
}

const b64 = (value: unknown): string =>
  Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
