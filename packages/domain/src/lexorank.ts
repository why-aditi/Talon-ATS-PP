/**
 * Lexorank — ordering keys that let an insert between two neighbours be a single-row
 * update (ARCHITECTURE §6.1), instead of renumbering everything below it.
 *
 * Lives in `domain` because it is pure and two consumers need the same rule: the
 * repository generates keys, and the rebalance job regenerates them.
 *
 * ## The alphabet is deliberately lowercase base-36
 *
 * These keys are compared in JavaScript here and by `ORDER BY board_rank` in Postgres,
 * and those two only agree if the comparison is byte-order. Postgres text ordering
 * follows the database collation, and under a typical `en_US.UTF-8` an alphabet mixing
 * upper and lower case sorts differently from JS: 'B' < 'a' by byte, 'a' < 'B' by
 * collation. Base-62 would be denser and would silently disagree.
 *
 * Digits-then-lowercase avoids the case question entirely. The repository still orders
 * with an explicit `collate "C"` so the SQL side is byte-exact regardless of what the
 * database was created with — belt and braces, because the failure is a board that
 * renders in a different order than it was saved in, which reads as a bug in dragging.
 */
const ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyz';
const BASE = ALPHABET.length;

function index(char: string): number {
  const i = ALPHABET.indexOf(char);
  if (i === -1) throw new RangeError(`Not a lexorank key: ${JSON.stringify(char)}`);
  return i;
}

/**
 * A key strictly between `a` and `b`. `null` means "the start" and "the end".
 *
 * ## The invariant: no key ends in the lowest digit
 *
 * `between` is total over keys that satisfy that, and only over those. It is not a
 * style rule — it is what makes the guarantee possible at all. There is genuinely no
 * string between `'a'` and `'a0'`: every extension of `'a'` starts with a digit, and
 * `'0'` is the smallest one there is, so `'a0'` is already the immediate successor.
 *
 * An earlier version claimed unconditional totality and, for exactly those pairs,
 * returned a key GREATER than its upper bound — silently, because the property test
 * generated candidates with `.filter(s => !s.endsWith('0'))` and so excluded the only
 * inputs that break it. Both are fixed: this throws rather than lying, `rebalance`
 * no longer emits such keys, and the property test asserts the invariant instead of
 * filtering for it.
 */
export function between(a: string | null, b: string | null): string {
  if (a !== null && b !== null && a >= b) {
    // Not a silent swap: callers pass the neighbours of a computed position, so an
    // inverted pair means the caller's ordering is wrong and hiding it hides that.
    throw new RangeError(`Lexorank bounds are not ordered: ${a} >= ${b}`);
  }

  const lower = a ?? '';
  let upper = b;
  let result = '';

  for (let i = 0; ; i += 1) {
    const ca = i < lower.length ? index(lower[i] as string) : 0;

    // Still matching `upper` digit for digit and it has run out: `result` now EQUALS
    // `upper`, so every continuation is greater than it. That only happens when `upper`
    // ends in the lowest digit — the shape the invariant above forbids — so this is a
    // caller supplying a key it should never have generated, not a gap to paper over.
    if (upper !== null && i >= upper.length) {
      throw new RangeError(
        `No key exists between ${JSON.stringify(a)} and ${JSON.stringify(b)}: ` +
          `${JSON.stringify(b)} ends in the lowest digit, which lexorank keys must not.`,
      );
    }

    const cb = upper === null ? BASE : index(upper[i] as string);

    if (ca + 1 < cb) {
      // Room at this place: take the midpoint and stop. This is the only exit, and it
      // can never emit the lowest digit — `ca + 1 < cb` fails whenever the midpoint
      // would be 0 — so a key never ends in '0' and `between` always terminates.
      return result + (ALPHABET[Math.floor((ca + cb) / 2)] as string);
    }

    result += ALPHABET[ca] as string;
    // `ca === cb - 1` means we have just gone strictly below `b`, so `b` stops
    // constraining the places after this one and the space opens back up.
    if (ca !== cb) upper = null;
  }
}

/**
 * Evenly spaced keys for `count` items, for the rebalance job: neighbours' keys grow a
 * place every time something is inserted between them, and a column that is reordered
 * all day eventually carries keys long enough to notice.
 *
 * Nothing schedules this yet (spec 004 §2) — it exists so the growth has an answer, and
 * so the answer is tested before it is needed at 3am.
 */
export function rebalance(count: number): string[] {
  if (count < 0 || !Number.isInteger(count)) throw new RangeError(`Not a count: ${count}`);
  if (count === 0) return [];

  // Enough places to give every item its own slot with gaps left over.
  const width = Math.max(1, Math.ceil(Math.log(count + 1) / Math.log(BASE)));
  const span = BASE ** width;
  const step = Math.floor(span / (count + 1));

  return Array.from({ length: count }, (_, i) => {
    let n = (i + 1) * step;
    let key = '';
    for (let place = 0; place < width; place += 1) {
      key = (ALPHABET[n % BASE] as string) + key;
      n = Math.floor(n / BASE);
    }
    // Never end in the lowest digit (see `between`). Appending a mid digit keeps the
    // key strictly greater than the bare prefix and strictly less than the next key,
    // which differs at an earlier place — so the spacing survives and `between` stays
    // total over everything this emits.
    return key.endsWith(ALPHABET[0] as string) ? key + (ALPHABET[Math.floor(BASE / 2)] as string) : key;
  });
}

/** The first key on an empty column. Mid-space, so the first inserts either side of it
 *  stay short rather than immediately descending a place. */
export const FIRST_RANK = between(null, null);
