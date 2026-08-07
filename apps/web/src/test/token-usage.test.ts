// Clearing Tailwind's own scales (`--spacing-*: initial` in the generated theme) means
// a utility naming a value we don't ship simply produces no declaration — the element
// renders with that property unset instead of failing loudly. That cost two real bugs
// during step 5: an invisible active-nav marker (`top-1.5`) and an unpadded ⌘K chip
// (`px-1.5`). This test turns the silence into a failure.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { extname, join } from 'node:path';
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

const FILES = sourceFiles(SRC).filter((path) => !path.includes('test'));

const SPACING_SCALE = new Set(
  Object.keys(TOKENS)
    .filter((name) => name.startsWith('--spacing-'))
    .map((name) => name.replace('--spacing-', '')),
);

const SPACING_UTILITY =
  /\b(?:w|h|p|px|py|pt|pb|pl|pr|m|mx|my|mt|mb|ml|mr|gap|gap-x|gap-y|size|top|bottom|left|right|inset|inset-x|inset-y|space-x|space-y)-([0-9][0-9.]*)\b/g;

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

  it('no raw hex color outside packages/tokens', () => {
    const offenders: string[] = [];
    for (const file of FILES) {
      const source = readFileSync(file, 'utf8');
      // Skip SVG path data, which is digits and letters but never a color.
      for (const [hex] of source.matchAll(/#[0-9a-fA-F]{3,8}\b/g)) {
        offenders.push(`${file.replace(SRC, '')}: ${hex}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
