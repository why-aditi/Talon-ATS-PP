import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach, beforeAll, vi } from 'vitest';
import { installFetchStub, resetRoutes } from './fetch-stub';

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
  /*
    jsdom ships HTMLDialogElement without showModal/close, so any component that
    opens a dialog throws without these. They are jsdom gaps rather than
    behaviour worth asserting: the real focus trap, Escape handling and
    top-layer stacking are the platform's, and a browser is the only place they
    can be verified.

    `open` is set and cleared because tests query by role, and a <dialog>
    without the attribute is hidden from the accessibility tree.
  */
  HTMLDialogElement.prototype.showModal ??= function showModal(this: HTMLDialogElement) {
    this.open = true;
  };
  HTMLDialogElement.prototype.close ??= function close(this: HTMLDialogElement) {
    this.open = false;
    this.dispatchEvent(new Event('close'));
  };

  installFetchStub();
});

afterEach(() => {
  cleanup();
  resetRoutes();
  searchParams.current = new URLSearchParams();
  pathname.current = '/jobs';
  routerReplace.mockClear();
  routerPush.mockClear();
});
