/**
 * Connection URLs for the api suite.
 *
 * A DEDICATED database, and deliberately NOT the one packages/db uses: turbo
 * runs package test tasks in parallel, and that suite opens with
 * `drop schema public cascade`. Two suites, two databases, no race.
 *
 * The dev database is never opened by either.
 */
import { appUrl, ownerUrl } from '@talon/testing';

export const TEST_DATABASE_NAME = process.env['API_TEST_DATABASE_NAME'] ?? 'talon_api_test';

/** Owner/migration role: superuser, bypasses RLS. Fixtures and assertions only. */
export const OWNER_URL = ownerUrl(TEST_DATABASE_NAME);

/** What the api itself connects as: subject to RLS, no BYPASSRLS. */
export const APP_URL = appUrl(TEST_DATABASE_NAME);
