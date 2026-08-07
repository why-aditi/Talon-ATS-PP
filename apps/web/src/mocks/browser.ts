import { setupWorker } from 'msw/browser';
import { handlers } from './handlers';

// ponytail: the worker starts unconditionally, including in a production build —
// there is no API to talk to yet. Delete this module and `Providers`' bootstrap when
// the real client lands; nothing else imports it.
export const worker = setupWorker(...handlers);
