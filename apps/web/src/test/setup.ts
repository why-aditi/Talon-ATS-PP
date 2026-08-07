import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterAll, afterEach, beforeAll, vi } from 'vitest';
import { server } from '../mocks/node';

/** Set by tests to drive `useSearchParams`; see `renderJobs` in the screen test. */
export const searchParams = { current: new URLSearchParams() };
export const routerReplace = vi.fn();

vi.mock('next/navigation', () => ({
  usePathname: () => '/jobs',
  useSearchParams: () => searchParams.current,
  useRouter: () => ({ replace: routerReplace, push: vi.fn(), refresh: vi.fn() }),
  redirect: vi.fn(),
}));

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterEach(() => {
  cleanup();
  server.resetHandlers();
  searchParams.current = new URLSearchParams();
  routerReplace.mockClear();
});
afterAll(() => server.close());
