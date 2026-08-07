import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterAll, afterEach, beforeAll, vi } from 'vitest';
import { server } from '../mocks/node';

/** Set by tests to drive `useSearchParams`; see `renderJobs` in the screen test. */
export const searchParams = { current: new URLSearchParams() };
/** Same, for `usePathname`. Defaults to /jobs so existing tests are unaffected. */
export const pathname = { current: '/jobs' };
export const routerReplace = vi.fn();
export const routerPush = vi.fn();

vi.mock('next/navigation', () => ({
  usePathname: () => pathname.current,
  useSearchParams: () => searchParams.current,
  useRouter: () => ({ replace: routerReplace, push: routerPush, refresh: vi.fn() }),
  redirect: vi.fn(),
}));

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterEach(() => {
  cleanup();
  server.resetHandlers();
  searchParams.current = new URLSearchParams();
  pathname.current = '/jobs';
  routerReplace.mockClear();
  routerPush.mockClear();
});
afterAll(() => server.close());
