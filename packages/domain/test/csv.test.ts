// Spec 008 §6.2a, §6.4, §9.
//
// The escaping block is the one that matters. The error CSV is built from rows somebody
// uploaded and opened in Excel by a recruiter, so a cell that begins `=` is code, not
// text. Every dangerous prefix gets its own case: a regression that only re-allowed
// `@` would otherwise pass on a suite that tested `=`.
import { describe, expect, it } from 'vitest';
import {
  UnsupportedEncodingError,
  decodeCsv,
  escapeCsvCell,
  normaliseHeader,
  sniffDelimiter,
  writeCsv,
} from '../src/csv.js';

const utf8 = (s: string) => new TextEncoder().encode(s);

describe('escapeCsvCell — formula injection', () => {
  it.each([
    ['=cmd|\'/c calc\'!A1', 'the classic command payload'],
    ['=1+1', 'a bare formula'],
    ['+1234567890', 'a phone number Excel would evaluate'],
    ['-1+1', 'arithmetic, which is why `-` is on the list'],
    ['@SUM(A1:A9)', 'the Lotus-inherited prefix Excel still honours'],
    ['\t=1+1', 'leading tab — Excel strips whitespace before deciding'],
    ['\r=1+1', 'leading CR, same reason'],
  ])('neutralises %j (%s)', (payload) => {
    const out = escapeCsvCell(payload);
    // The apostrophe sits inside the quotes, immediately before the payload. Anything
    // else — escaping after the quote, or stripping the character — either fails to
    // neutralise it or silently changes the user's data.
    expect(out.startsWith(`"'`)).toBe(true);
    expect(out).toContain(payload.replaceAll('"', '""'));
  });

  it('leaves ordinary values alone apart from quoting', () => {
    expect(escapeCsvCell('Ana Petrova')).toBe('"Ana Petrova"');
    expect(escapeCsvCell('')).toBe('""');
    // A dangerous character that is not FIRST is not a formula and must not be touched:
    // mangling it would corrupt real data to fix a threat that isn't there.
    expect(escapeCsvCell('a=b')).toBe('"a=b"');
  });

  it('doubles embedded quotes and survives delimiters and newlines (RFC 4180)', () => {
    expect(escapeCsvCell('say "hi"')).toBe('"say ""hi"""');
    expect(escapeCsvCell('Smith, John')).toBe('"Smith, John"');
    expect(escapeCsvCell('line1\nline2')).toBe('"line1\nline2"');
  });

  it('escapes a payload that arrives through an ECHOED column, not just _error', () => {
    // §6.2a: the original columns are where the payload arrives. An implementation that
    // escaped only the column it adds would be no protection at all.
    const doc = writeCsv(['name', 'email', '_error'], [['=HYPERLINK("http://x","click")', 'a@b.c', 'bad email']]);
    expect(doc).toContain(`"'=HYPERLINK`);
    expect(doc).not.toContain(`,"=HYPERLINK`);
  });
});

describe('writeCsv', () => {
  it('writes CRLF and a trailing terminator', () => {
    expect(writeCsv(['a', 'b'], [['1', '2']])).toBe('"a","b"\r\n"1","2"\r\n');
  });

  it('round-trips a header with no rows', () => {
    expect(writeCsv(['a'], [])).toBe('"a"\r\n');
  });
});

describe('decodeCsv', () => {
  it('reads plain UTF-8', () => {
    const { text, encoding } = decodeCsv(utf8('name,email\nAna Petrova,ana@x.com'));
    expect(encoding).toBe('utf-8');
    expect(text).toContain('Ana Petrova');
  });

  it('strips the UTF-8 BOM rather than decoding it', () => {
    const bytes = new Uint8Array([0xef, 0xbb, 0xbf, ...utf8('email,name')]);
    const { text, encoding } = decodeCsv(bytes);
    expect(encoding).toBe('utf-8-bom');
    // Left in place, the BOM becomes an invisible prefix and "email" stops matching
    // the column literally named "email" — a missing-required-column error on a file
    // that plainly has it.
    expect(text.startsWith('email')).toBe(true);
    expect(text.charCodeAt(0)).toBe(101);
  });

  it('falls back to Latin-1 for bytes that are not valid UTF-8', () => {
    // 0xE9 alone is `é` in Latin-1 and an invalid lead byte in UTF-8. This is the
    // Excel-on-Windows export that §6.4 calls the most common real failure.
    const bytes = new Uint8Array([...utf8('name\nAndr'), 0xe9]);
    const { text, encoding } = decodeCsv(bytes);
    expect(encoding).toBe('latin-1');
    expect(text).toContain('André');
  });

  it('prefers UTF-8 over Latin-1 when the bytes are valid UTF-8', () => {
    // Every byte sequence is valid Latin-1, so guessing it first would mis-decode
    // legitimate UTF-8 into mojibake. Strict decoding is what keeps the order honest.
    const { text, encoding } = decodeCsv(utf8('name\nAndré'));
    expect(encoding).toBe('utf-8');
    expect(text).toContain('André');
    expect(text).not.toContain('Ã©');
  });

  it('rejects UTF-16 with a message that says what to do', () => {
    const bytes = new Uint8Array([0xff, 0xfe, 0x6e, 0x00]);
    expect(() => decodeCsv(bytes)).toThrow(UnsupportedEncodingError);
    expect(() => decodeCsv(bytes)).toThrow(/UTF-16/);
    expect(() => decodeCsv(bytes)).toThrow(/Save it as CSV UTF-8/);
  });
});

describe('sniffDelimiter', () => {
  it('finds comma, semicolon, tab and pipe', () => {
    expect(sniffDelimiter('a,b,c')).toBe(',');
    // Excel writes semicolons in every locale with a comma decimal separator, which is
    // most of Europe. Hard-coding `,` reads such a file as one column.
    expect(sniffDelimiter('a;b;c')).toBe(';');
    expect(sniffDelimiter('a\tb\tc')).toBe('\t');
    expect(sniffDelimiter('a|b|c')).toBe('|');
  });

  it('ignores delimiters inside quotes', () => {
    // The quoted field is stuffed with the rival delimiter; a naive count picks it.
    expect(sniffDelimiter('"a;b;c;d";x')).toBe(';');
    expect(sniffDelimiter('"a,b,c,d";x')).toBe(';');
  });

  it('looks only at the header line', () => {
    expect(sniffDelimiter('a;b\n1,2,3,4,5,6')).toBe(';');
  });

  it('falls back to comma for a single column', () => {
    expect(sniffDelimiter('email')).toBe(',');
    expect(sniffDelimiter('')).toBe(',');
  });
});

describe('normaliseHeader', () => {
  it('treats case, spacing and separators as the same column', () => {
    for (const variant of ['First Name', 'first_name', 'first-name', '  FIRST   NAME  ']) {
      expect(normaliseHeader(variant)).toBe('first name');
    }
  });

  it('strips a stray BOM off the first header cell', () => {
    expect(normaliseHeader('﻿email')).toBe('email');
  });
});
