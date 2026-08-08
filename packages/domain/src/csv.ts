/**
 * CSV decoding, dialect sniffing and — the part that matters — safe writing.
 *
 * Lives in `domain` for the same reason `permissions.ts` does: two consumers need the
 * identical rules and neither may import the other. The api presigns and validates,
 * `apps/workers` parses and commits, and if their idea of "what is a delimiter" or
 * "what is a dangerous cell" ever diverged, a file would validate one way and import
 * another. Everything here is pure — no I/O, nothing from `db` (CLAUDE.md §3).
 */

// ---------------------------------------------------------------------------
// Writing — spec 008 §6.2a
// ---------------------------------------------------------------------------

/**
 * Characters that make a spreadsheet treat a cell as a formula rather than text.
 *
 * `=` and `+` are the obvious ones. `-` matters because `-1+1` is arithmetic. `@` is
 * Lotus-inherited and still live in Excel. Tab and CR are here because Excel strips
 * leading whitespace before deciding, so `\t=cmd|...` is `=cmd|...` by the time it is
 * evaluated — a filter that only looked at index 0 for `=` would pass it through.
 */
const FORMULA_PREFIXES = ['=', '+', '-', '@', '\t', '\r'];

/**
 * Makes one cell safe to write into a CSV that a human will open in Excel.
 *
 * The error report we hand back is built from the rows somebody uploaded, so every
 * value in it is attacker-controlled by definition — that is the whole premise of an
 * import feature. A cell beginning with one of the prefixes above is executed on open,
 * with the recruiter's privileges: `=cmd|'/c calc'!A1` is the textbook payload, and
 * the modern ones exfiltrate over `WEBSERVICE()` without any dialog at all.
 *
 * The fix is a leading apostrophe, which every spreadsheet reads as "the rest is
 * literal text" and does not display. It is applied to EVERY column, not just the
 * `_error` one we add — the echoed original columns are exactly where the payload
 * arrives (spec 008 §6.2a).
 *
 * This is §4.17's reasoning about attacker-controlled resumes applied to a document we
 * generate ourselves: the danger was never storing the bytes, it is something else
 * executing them.
 */
export function escapeCsvCell(value: string): string {
  const guarded = FORMULA_PREFIXES.some((p) => value.startsWith(p)) ? `'${value}` : value;
  // Quoting is a separate concern from injection and both are always needed: a cell
  // containing the delimiter, a quote or a newline has to be wrapped, and an embedded
  // quote doubled (RFC 4180). Done unconditionally — a conditional quote is one more
  // branch to get wrong for no saving a human can perceive.
  return `"${guarded.replaceAll('"', '""')}"`;
}

/** One CSV document from a header and rows. Every cell goes through `escapeCsvCell`. */
export function writeCsv(header: readonly string[], rows: readonly (readonly string[])[]): string {
  const lines = [header, ...rows].map((row) => row.map((cell) => escapeCsvCell(cell)).join(','));
  // CRLF, not LF: RFC 4180 says so, and Excel on Windows is the consumer that cares.
  // Trailing terminator so the last row is not special-cased by whatever reads it.
  return lines.join('\r\n') + '\r\n';
}

// ---------------------------------------------------------------------------
// Decoding — spec 008 §6.4
// ---------------------------------------------------------------------------

export type Encoding = 'utf-8' | 'utf-8-bom' | 'latin-1';

/**
 * `TextDecoder` reached through `globalThis` with a local structural type, rather than
 * from `lib.dom` or `@types/node`.
 *
 * This package's `exports.types` points at `src/index.ts`, so every consumer — contracts,
 * api, workers AND the browser bundle — type-checks this file with its own tsconfig.
 * Naming the global directly would make it each of their problems to declare, and adding
 * `lib: ["DOM"]` here would hand a package that must never touch the DOM the entire DOM
 * surface. The decoder is a WHATWG global present in both runtimes; three lines of
 * structural type is the cheapest way to say exactly that and nothing more.
 */
type Decoder = { decode(input?: Uint8Array): string };
const TextDecoderCtor = (globalThis as unknown as {
  TextDecoder: new (label?: string, options?: { fatal?: boolean }) => Decoder;
}).TextDecoder;

export class UnsupportedEncodingError extends Error {
  constructor(readonly detected: string) {
    super(
      `This file appears to be ${detected}. Save it as CSV UTF-8 and upload it again — ` +
        `importing it as-is would turn every accented name into mojibake.`,
    );
    this.name = 'UnsupportedEncodingError';
  }
}

const UTF8_BOM = [0xef, 0xbb, 0xbf];
const UTF16_LE_BOM = [0xff, 0xfe];
const UTF16_BE_BOM = [0xfe, 0xff];

const startsWith = (bytes: Uint8Array, sig: number[]) => sig.every((b, i) => bytes[i] === b);

/**
 * Decodes an uploaded file, guessing the encoding the way the real world requires.
 *
 * "Excel on Windows exports Latin-1 with a BOM by default" is the single most common
 * import failure there is, and the failure mode is silent: the bytes decode, and every
 * `é` becomes `Ã©` in a candidate's name. Nobody notices until the person receives an
 * email addressed to someone else's spelling.
 *
 * Order matters. A BOM is decisive, so it is checked first. Absent one, UTF-8 is tried
 * *strictly* — `fatal: true` is the whole trick, because a lenient decode silently
 * substitutes U+FFFD and can never fail, which would make the Latin-1 branch dead code.
 * Latin-1 is the fallback rather than the default because every byte sequence is valid
 * Latin-1; treating it as the first guess would mis-decode legitimate UTF-8.
 *
 * UTF-16 is rejected rather than supported. It is rare from spreadsheets, and a clear
 * message beats a half-working path (§6.4).
 */
export function decodeCsv(bytes: Uint8Array): { text: string; encoding: Encoding } {
  if (startsWith(bytes, UTF16_LE_BOM) || startsWith(bytes, UTF16_BE_BOM)) {
    throw new UnsupportedEncodingError('UTF-16');
  }

  if (startsWith(bytes, UTF8_BOM)) {
    // The BOM is stripped, not decoded. Left in place it becomes an invisible prefix on
    // the first header cell, so "email" fails to match the column named "email" and the
    // mapping step reports a missing required column for a file that plainly has it.
    return { text: new TextDecoderCtor('utf-8').decode(bytes.subarray(3)), encoding: 'utf-8-bom' };
  }

  try {
    return { text: new TextDecoderCtor('utf-8', { fatal: true }).decode(bytes), encoding: 'utf-8' };
  } catch {
    return { text: new TextDecoderCtor('latin1').decode(bytes), encoding: 'latin-1' };
  }
}

// ---------------------------------------------------------------------------
// Dialect — spec 008 §6.1
// ---------------------------------------------------------------------------

export type Delimiter = ',' | ';' | '\t' | '|';

const DELIMITERS: Delimiter[] = [',', ';', '\t', '|'];

/**
 * Guesses the delimiter from the header line.
 *
 * Semicolon is not exotic: Excel writes it in every locale whose decimal separator is a
 * comma, which is most of Europe. A parser hard-coded to `,` reads such a file as a
 * single column and reports "missing required columns" for a file that has them all.
 *
 * Counted outside quotes only — `"Smith, John",email` has two fields and two commas,
 * and a naive count would still pick `,` here but would pick wrongly on
 * `"a;b;c";x` where the quoted field is stuffed with the rival delimiter.
 */
export function sniffDelimiter(text: string): Delimiter {
  const line = text.split(/\r?\n/, 1)[0] ?? '';
  let best: Delimiter = ',';
  let bestCount = -1;

  for (const delimiter of DELIMITERS) {
    let count = 0;
    let inQuotes = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === '"') inQuotes = !inQuotes;
      else if (ch === delimiter && !inQuotes) count++;
    }
    if (count > bestCount) {
      bestCount = count;
      best = delimiter;
    }
  }
  // Ties and empties fall back to comma, which is what a single-column file is.
  return best;
}

// ---------------------------------------------------------------------------
// Header matching
// ---------------------------------------------------------------------------

/**
 * Normalises a header cell for matching: case, surrounding space, and the separators
 * people use interchangeably. "First Name", "first_name" and "first-name" are one
 * column as far as a saved mapping is concerned, and making the user re-map because a
 * colleague exported with different capitalisation is the kind of friction that gets an
 * import feature abandoned.
 */
export const normaliseHeader = (value: string): string =>
  value
    .replace(/^﻿/, '')
    .trim()
    .toLowerCase()
    .replace(/[\s_-]+/g, ' ');
