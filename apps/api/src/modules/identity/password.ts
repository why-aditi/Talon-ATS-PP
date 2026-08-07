/**
 * Password hashing for the local provider: scrypt from `node:crypto`.
 *
 * argon2id would be the first choice on a greenfield service, but it is a native
 * dependency and the platform already ships a memory-hard KDF that OWASP accepts
 * at these parameters. Nothing here reaches production — Cognito owns passwords
 * in AWS — so a native build step for dev credentials is not a trade worth
 * making (CLAUDE.md §9: say what the dependency would replace).
 *
 * Stored form: `scrypt$N=16384,r=8,p=1$<salt base64>$<hash base64>`. Parameters
 * travel with the hash so raising them later does not invalidate old rows.
 */
import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(scryptCallback) as (
  password: string,
  salt: Buffer,
  keylen: number,
  options: { N: number; r: number; p: number; maxmem: number },
) => Promise<Buffer>;

// 16384 × 8 × 128 B ≈ 16 MiB per hash — OWASP's minimum scrypt profile.
const PARAMS = { N: 16384, r: 8, p: 1 } as const;
const KEY_LENGTH = 32;
const SALT_LENGTH = 16;
// scrypt's default maxmem is 32 MiB; state it so a parameter bump fails loudly
// on the number rather than on an opaque "memory limit exceeded".
const MAXMEM = 64 * 1024 * 1024;

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SALT_LENGTH);
  const hash = await scrypt(password, salt, KEY_LENGTH, { ...PARAMS, maxmem: MAXMEM });
  return [
    'scrypt',
    `N=${PARAMS.N},r=${PARAMS.r},p=${PARAMS.p}`,
    salt.toString('base64'),
    hash.toString('base64'),
  ].join('$');
}

interface Parsed {
  params: { N: number; r: number; p: number };
  salt: Buffer;
  hash: Buffer;
}

function parse(stored: string): Parsed | null {
  const parts = stored.split('$');
  if (parts.length !== 4) return null;
  const [scheme, paramPart, saltPart, hashPart] = parts as [string, string, string, string];
  if (scheme !== 'scrypt') return null;
  const params = { N: 0, r: 0, p: 0 };
  for (const pair of paramPart.split(',')) {
    const [key, value] = pair.split('=');
    if (key !== 'N' && key !== 'r' && key !== 'p') return null;
    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed < 1) return null;
    params[key] = parsed;
  }
  if (params.N < 1 || params.r < 1 || params.p < 1) return null;
  return { params, salt: Buffer.from(saltPart, 'base64'), hash: Buffer.from(hashPart, 'base64') };
}

/**
 * False rather than throwing on an unparseable stored value: a corrupted row
 * must fail closed as "wrong password", not 500 in a way that distinguishes the
 * account from a non-existent one.
 */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parsed = parse(stored);
  if (!parsed || parsed.hash.length === 0) return false;
  const candidate = await scrypt(password, parsed.salt, parsed.hash.length, {
    ...parsed.params,
    maxmem: MAXMEM,
  });
  return candidate.length === parsed.hash.length && timingSafeEqual(candidate, parsed.hash);
}

/**
 * A real hash of a value nobody knows, used to spend the same work when no
 * identity matched. Without it, "unknown email" answers measurably faster than
 * "wrong password" and sign-in becomes an account-enumeration oracle.
 */
let dummy: Promise<string> | undefined;
export async function burnVerification(password: string): Promise<false> {
  dummy ??= hashPassword(randomBytes(24).toString('hex'));
  await verifyPassword(password, await dummy);
  return false;
}
