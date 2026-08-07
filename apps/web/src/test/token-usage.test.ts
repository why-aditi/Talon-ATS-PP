// Clearing Tailwind's own scales (`--spacing-*: initial` in the generated theme) means
// a utility naming a value we don't ship simply produces no declaration — the element
// renders with that property unset instead of failing loudly. That cost two real bugs
// during step 5: an invisible active-nav marker (`top-1.5`) and an unpadded ⌘K chip
// (`px-1.5`). This test turns the silence into a failure.
//
// The regexes below have their own test block. The first version of this gate was
// itself broken — it ended in `\b`, and since Tailwind joins arbitrary-value segments
// with `_` (a word character), a literal followed by `_` never matched. It caught
// `grid-cols-[minmax(0,1fr)_239px_142px_106px_88px]` only because the *last* track
// ended in `px]`; reordering the tracks would have hidden the same violation. A gate
// nobody tests is a gate nobody can trust.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { extname, join, sep } from 'node:path';
import { describe, expect, it } from 'vitest';
import { TOKENS } from '@talon/tokens';

// Not import.meta.url: under jsdom that resolves to an http:// URL, not a file path.
const SRC = join(process.cwd(), 'src');

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return ['.ts', '.tsx', '.css'].includes(extname(path)) ? [path] : [];
  });
}

// Only the test directory, not every path containing the substring "test".
const FILES = sourceFiles(SRC).filter((path) => !path.startsWith(join(SRC, 'test') + sep));

/** Prefixes whose numeric value is looked up in the spacing scale. */
const SPACING_PREFIX =
  '(?:w|h|size|min-w|min-h|max-w|max-h|p|px|py|pt|pb|pl|pr|m|mx|my|mt|mb|ml|mr|-m|-mx|-my|-mt|-mb|-ml|-mr|gap|gap-x|gap-y|top|bottom|left|right|inset|inset-x|inset-y|space-x|space-y|basis|translate-x|translate-y|scroll-m|scroll-mt|scroll-mb)';

/**
 * Every prefix that can carry an arbitrary value. Wider than the spacing list: a
 * literal is wrong in `border-[3px]` and `flex-[0_0_130px]` too, even though neither
 * resolves against the spacing scale.
 */
const ARBITRARY_PREFIX = `(?:${SPACING_PREFIX.slice(3, -1)}|text|leading|tracking|rounded|shadow|border|ring|outline|divide|divide-x|divide-y|stroke|fill|flex|indent|aspect|z|opacity|duration|delay|col-span|row-span|grid-cols|grid-rows)`;

// `(?!\/)` so `w-1/6` is a fraction, not the spacing step `w-1` — fractions are
// relative and need no token. Without it the check passes for the wrong reason.
const SPACING_UTILITY = new RegExp(`\\b${SPACING_PREFIX}-([0-9][0-9.]*)(?!\\/)\\b`, 'g');

/** The `[...]` in `w-[130px]` or `h-[var(--x)]`. */
const ARBITRARY_UTILITY = new RegExp(`\\b${ARBITRARY_PREFIX}-\\[([^\\]]+)\\]`, 'g');

/** A bare arbitrary *property*, `[--row-h:55px]` — the two-line bypass around the above. */
const ARBITRARY_PROPERTY = /(?:^|["'\s])(\[--[a-z][\w-]*:[^\]]+\])/g;

/**
 * A literal dimension or color. Boundaries are lookaheads, not `\b`: `_` is a word
 * character and is exactly what Tailwind puts between arbitrary-value segments, so
 * `\b` would skip every literal that isn't last in the bracket.
 */
const LITERAL_VALUE = /\d(?:\.\d+)?(?:px|rem|em|pt|ch|vh|vw)(?![a-z])|#[0-9a-fA-F]{3,8}(?![0-9a-fA-F])/;

/** An arbitrary value is legitimate when it references a token and nothing else. */
function offendingArbitrary(inner: string): boolean {
  return LITERAL_VALUE.test(inner.replace(/var\([^)]*\)/g, ''));
}

const SPACING_SCALE = new Set(
  Object.keys(TOKENS)
    .filter((name) => name.startsWith('--spacing-'))
    .map((name) => name.replace('--spacing-', '')),
);

describe('the guard itself', () => {
  const flagged = (utility: string) => {
    const m = new RegExp(`^${ARBITRARY_PREFIX}-\\[([^\\]]+)\\]$`).exec(utility);
    if (!m) throw new Error(`not an arbitrary utility: ${utility}`);
    return offendingArbitrary(m[1] as string);
  };

  it.each([
    // The case the first version caught only by luck of the trailing `]`.
    'grid-cols-[minmax(0,1fr)_239px_142px_106px_88px]',
    // The reorderings that version missed entirely.
    'grid-cols-[239px_1fr]',
    'grid-cols-[130px_minmax(0,1fr)]',
    // One token must not launder the literals beside it.
    'grid-cols-[minmax(0,1fr)_239px_var(--a)]',
    'shadow-[0_1px_2px_var(--x)]',
    'border-[3px]',
    'flex-[0_0_130px]',
    'w-[130px]',
    'h-[1.5rem]',
    // Split so the ESLint no-raw-hex rule doesn't flag this fixture. That rule firing
    // on a test case for this very guard is the two checks agreeing, not overlapping
    // waste: ESLint sees .ts/.tsx, the block below sees .css, which ESLint cannot parse.
    `text-[${'#'}4C56C8]`,
  ])('flags %s', (utility) => {
    expect(flagged(utility)).toBe(true);
  });

  it.each([
    'h-[var(--layout-row-height)]',
    'w-[var(--layout-job-row-distribution-bar-width)]',
    'grid-cols-[minmax(0,1fr)_var(--layout-job-row-recruiter-column)]',
    'duration-[var(--duration-instant)]',
    'z-[var(--z-modal)]',
    'grid-cols-[repeat(3,1fr)]',
    'w-[100%]',
  ])('allows %s', (utility) => {
    expect(flagged(utility)).toBe(false);
  });

  it('treats a fraction as a fraction, not a spacing step', () => {
    expect('w-1/6'.match(SPACING_UTILITY)).toBeNull();
    expect('w-1'.match(SPACING_UTILITY)).toEqual(['w-1']);
  });

  it('catches the arbitrary-property bypass', () => {
    expect('className="[--row-h:55px] h-[var(--row-h)]"'.match(ARBITRARY_PROPERTY)).not.toBeNull();
  });
});

describe('token usage', () => {
  it('every spacing utility names a value the token scale ships', () => {
    const offenders: string[] = [];
    for (const file of FILES) {
      const source = readFileSync(file, 'utf8');
      for (const [utility, value] of source.matchAll(SPACING_UTILITY)) {
        if (!SPACING_SCALE.has(value as string)) offenders.push(`${file.replace(SRC, '')}: ${utility}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('every arbitrary value references a token rather than a literal', () => {
    const offenders: string[] = [];
    for (const file of FILES) {
      const source = readFileSync(file, 'utf8');
      for (const [utility, value] of source.matchAll(ARBITRARY_UTILITY)) {
        if (offendingArbitrary(value as string)) offenders.push(`${file.replace(SRC, '')}: ${utility}`);
      }
      for (const [, property] of source.matchAll(ARBITRARY_PROPERTY)) {
        offenders.push(`${file.replace(SRC, '')}: ${property} (arbitrary property — declare it in design-tokens.json)`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('no raw hex color outside packages/tokens', () => {
    const offenders: string[] = [];
    for (const file of FILES) {
      for (const [hex] of readFileSync(file, 'utf8').matchAll(/#[0-9a-fA-F]{3,8}\b/g)) {
        offenders.push(`${file.replace(SRC, '')}: ${hex}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
