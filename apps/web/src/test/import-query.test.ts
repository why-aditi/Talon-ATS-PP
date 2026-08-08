import { expect, it } from 'vitest';
import { uploadAndAnalyze } from '../lib/import-query';
import { json, route } from './fetch-stub';

it('creates an import, PUTs the exact file to its presigned URL, then analyzes it', async () => {
  const calls: string[] = [];
  route(async (url, init) => {
    if (url.pathname === '/v1/imports') {
      calls.push('create');
      expect(init?.method).toBe('POST');
      expect(init?.headers).toMatchObject({ authorization: 'Bearer access-token' });
      expect(JSON.parse(String(init?.body))).toEqual({ filename: 'people.csv', byteSize: 42 });
      return json(
        {
          importId: '018f2c31-0000-7000-8000-000000000099',
          uploadUrl: 'https://talon-dev-quarantine.s3.amazonaws.com/signed',
          expiresIn: 900,
        },
        201,
      );
    }
    if (url.hostname === 'talon-dev-quarantine.s3.amazonaws.com') {
      calls.push('upload');
      expect(init?.method).toBe('PUT');
      expect(init?.headers).toEqual({ 'content-type': 'text/csv' });
      expect(init?.body).toBeInstanceOf(File);
      return new Response(null, { status: 200 });
    }
    if (url.pathname.endsWith('/analyze')) {
      calls.push('analyze');
      expect(init?.method).toBe('POST');
      expect(init?.headers).toMatchObject({ authorization: 'Bearer access-token' });
      return json({
        delimiter: ',',
        encoding: 'utf-8',
        headers: ['Name', 'Email'],
        sampleRows: [['Ana', 'ana@example.test']],
        rowCount: 1,
        suggested: { Name: 'name', Email: 'email' },
      });
    }
    return undefined;
  });

  const body = 'Name,Email\nAna,ana@example.test\n'.padEnd(42, ' ');
  const result = await uploadAndAnalyze(
    new File([body], 'people.csv', { type: 'text/csv' }),
    'access-token',
  );

  expect(calls).toEqual(['create', 'upload', 'analyze']);
  expect(result.analysis.suggested).toEqual({ Name: 'name', Email: 'email' });
});
