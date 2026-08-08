'use client';

import {
  CommitImportResponseSchema,
  CreateImportResponseSchema,
  DryRunReportSchema,
  ImportAnalysisSchema,
  type AsyncJob,
  type DryRunReport,
  type ImportAnalysis,
  type ImportMapping,
} from '@talon/contracts';

const API_BASE = process.env['NEXT_PUBLIC_API_URL'] ?? '';

async function request(path: string, accessToken: string, init: RequestInit): Promise<unknown> {
  const response = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: {
      accept: 'application/json',
      authorization: `Bearer ${accessToken}`,
      ...(init.body ? { 'content-type': 'application/json' } : {}),
      ...init.headers,
    },
  });
  const body: unknown = await response.json().catch(() => null);
  if (!response.ok) throw new Error(`Import request failed with ${response.status}`);
  return body;
}

export async function uploadAndAnalyze(
  file: File,
  accessToken: string,
): Promise<{
  importId: string;
  analysis: ImportAnalysis;
}> {
  const created = CreateImportResponseSchema.parse(
    await request('/v1/imports', accessToken, {
      method: 'POST',
      body: JSON.stringify({ filename: file.name, byteSize: file.size }),
    }),
  );

  const upload = await fetch(created.uploadUrl, {
    method: 'PUT',
    headers: { 'content-type': 'text/csv' },
    body: file,
  });
  if (!upload.ok) throw new Error(`File upload failed with ${upload.status}`);

  const analysis = ImportAnalysisSchema.parse(
    await request(`/v1/imports/${created.importId}/analyze`, accessToken, { method: 'POST' }),
  );
  return { importId: created.importId, analysis };
}

export async function dryRunImport(
  importId: string,
  mapping: ImportMapping,
  accessToken: string,
): Promise<DryRunReport> {
  return DryRunReportSchema.parse(
    await request(`/v1/imports/${importId}/dry-run`, accessToken, {
      method: 'POST',
      body: JSON.stringify(mapping),
    }),
  );
}

export async function commitImport(
  importId: string,
  mapping: ImportMapping,
  accessToken: string,
): Promise<AsyncJob> {
  return CommitImportResponseSchema.parse(
    await request(`/v1/imports/${importId}/commit`, accessToken, {
      method: 'POST',
      body: JSON.stringify(mapping),
    }),
  ).job;
}
