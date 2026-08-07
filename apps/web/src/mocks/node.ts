import { setupServer } from 'msw/node';
import { fixtureJobsHandler, handlers } from './handlers';

/**
 * Component tests have no API to pass through to, so the fixture handler is
 * registered ahead of the shared set and answers the default path. It declines
 * `_scenario` requests by returning nothing, which lets MSW fall through to the
 * scenario handlers — the same ones the browser uses.
 */
export const server = setupServer(fixtureJobsHandler, ...handlers);
