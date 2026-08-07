import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterAll, afterEach, beforeAll, vi } from 'vitest';
import { server } from '../mocks/node';

/** Set by tests to drive `useSearchParams`; see `renderJobs` in the screen test. */
export const searchParams = { current: new URLSearchParams() };
export const routerReplace = vi.fn();
export const routerPush = vi.fn();

vi.mock('next/navigation', () => ({
  usePathname: () => '/jobs',
  useSearchParams: () => searchParams.current,
  useRouter: () => ({ replace: routerReplace, push: routerPush, refresh: vi.fn() }),
  redirect: vi.fn(),
}));

/*
  Radix Select drives its popup through Pointer Events and scrolls the highlighted
  item into view; jsdom implements neither, so without these the component throws
  before it ever opens. These are jsdom gaps, not behaviour worth asserting — the
  real interaction is covered by the E2E run, which uses a real browser.
*/
beforeAll(() => {
  Element.prototype.hasPointerCapture ??= () => false;
  Element.prototype.setPointerCapture ??= () => {};
  Element.prototype.releasePointerCapture ??= () => {};
  Element.prototype.scrollIntoView ??= () => {};
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
});

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterEach(() => {
  cleanup();
  server.resetHandlers();
  searchParams.current = new URLSearchParams();
  routerReplace.mockClear();
  routerPush.mockClear();
});
afterAll(() => server.close());
