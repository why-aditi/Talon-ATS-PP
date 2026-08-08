/**
 * Offers and reports — spec 007 §12.
 *
 * Driven through the real mock handler, so the offer tests exercise the comp gate
 * rather than a stub's idea of it.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { GET } from '../app/api/mock/[...path]/route';
import { OfferDetail, OffersScreen } from '../components/offers-screen';
import { ReportsScreen } from '../components/reports-screen';
import { SessionProvider } from '../lib/session';
import { json, route } from './fetch-stub';

const OFFER_ID = '0198f3a7-0001-7000-8000-000000000001';

const sessionFor = (role: string) => ({
  accessToken: `header.${Buffer.from(JSON.stringify({ role })).toString('base64url')}.sig`,
  expiresIn: 3600,
  user: {
    id: '0198f3a1-0007-7000-8000-000000000001',
    tenantId: '0198f3a1-0000-7000-8000-000000000001',
    email: 'maya@taloninc.com',
    name: 'Maya Reyes',
    role,
    timezone: 'America/Los_Angeles',
  },
});

function serve(role: string, override?: (url: URL) => Response | undefined) {
  route(async (url, init) => {
    if (url.pathname === '/api/auth/refresh') return json(sessionFor(role));
    const forced = override?.(url);
    if (forced) return forced;
    if (!url.pathname.startsWith('/api/mock/')) return undefined;
    const path = url.pathname.replace('/api/mock/', '').split('/');
    return GET(new Request(url.href, { headers: (init?.headers ?? {}) as HeadersInit }), {
      params: Promise.resolve({ path }),
    });
  });
}

function renderWith(ui: React.ReactElement) {
  return render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <SessionProvider>{ui}</SessionProvider>
    </QueryClientProvider>,
  );
}

describe('offers list', () => {
  it('links to the offer and shows no compensation anywhere', async () => {
    serve('recruiter');
    renderWith(<OffersScreen />);

    const link = await screen.findByRole('link', { name: /Sofia Lindqvist/ });
    expect(link).toHaveAttribute('href', `/offers/${OFFER_ID}`);
    // Even for a role that may see comp: the list payload cannot carry it (§5.1).
    expect(screen.queryByText(/\$210k/)).not.toBeInTheDocument();
    expect(screen.queryByText(/band/)).not.toBeInTheDocument();
  });
});

describe('offer builder', () => {
  it('renders the terms, the band badges and the letter', async () => {
    serve('recruiter');
    renderWith(<OfferDetail offerId={OFFER_ID} />);

    expect(await screen.findByRole('heading', { name: 'Offer: Sofia Lindqvist' })).toBeInTheDocument();
    expect(screen.getByText('$210k')).toBeInTheDocument();
    expect(screen.getByText('band $190k to $225k')).toBeInTheDocument();
    expect(screen.getByText('22,000 options over 4 yr')).toBeInTheDocument();
    expect(screen.getByText('band midpoint')).toBeInTheDocument();
    expect(screen.getByText('$15k')).toBeInTheDocument();
    expect(screen.getByText(/We are delighted to offer you the position/)).toBeInTheDocument();
  });

  it('names every approval state as text, not only as a dot', async () => {
    serve('recruiter');
    renderWith(<OfferDetail offerId={OFFER_ID} />);

    // §4.15 — a green dot alone would carry the state by colour.
    expect(await screen.findAllByText('Approved')).toHaveLength(2);
    expect(screen.getByText('Pending')).toBeInTheDocument();
    expect(screen.getByText('Sam Altmann')).toBeInTheDocument();
  });

  it('leaves send-for-approval inert', async () => {
    serve('recruiter');
    renderWith(<OfferDetail offerId={OFFER_ID} />);

    // The worst of the four inert actions to mock: it starts a chain that outlives
    // the screen (§6).
    expect(await screen.findByRole('button', { name: 'Send for approval' })).toHaveAttribute('aria-disabled', 'true');
  });

  it('replaces the whole terms card when the role may not see comp', async () => {
    serve('member');
    renderWith(<OfferDetail offerId={OFFER_ID} />);

    expect(await screen.findByText('Compensation is not visible to your role.')).toBeInTheDocument();
    // Not blanked values: the field names are themselves the withheld information,
    // so the labels must be absent too (§10 case 9).
    for (const label of ['Base salary', 'Equity', 'Sign-on bonus', 'Start date']) {
      expect(screen.queryByText(label)).not.toBeInTheDocument();
    }
    expect(screen.queryByText('$210k')).not.toBeInTheDocument();
    // The rest of the screen still works.
    expect(screen.getByText('Sam Altmann')).toBeInTheDocument();
  });
});

describe('reports', () => {
  it('renders the tiles, both panels and the trend', async () => {
    serve('recruiter');
    renderWith(<ReportsScreen />);

    expect(await screen.findByText('24d')).toBeInTheDocument();
    for (const value of ['86%', '9', '22']) expect(screen.getAllByText(value).length).toBeGreaterThan(0);
    expect(screen.getByRole('heading', { name: 'Pipeline conversion' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Hires by source' })).toBeInTheDocument();
    // Twice on purpose — once visibly, once in the sr-only table beneath it.
    expect(screen.getAllByText('412')).toHaveLength(2);
    expect(screen.getByText('4 hires')).toBeInTheDocument();
    // Singular, not "1 hires".
    expect(screen.getByText('1 hire')).toBeInTheDocument();
  });

  it('labels every bar, so identity never rests on the fill colour', async () => {
    serve('recruiter');
    renderWith(<ReportsScreen />);

    // This is what makes the palette legal. stage.screen and stage.onsite measure
    // ΔE 0.6 apart for deuteranopes — indistinguishable — so the written label beside
    // each bar is the identity carrier, not the swatch (see reports-screen.tsx, OQ-8).
    // Scoped to the chart itself, so this proves the VISIBLE bar carries its label —
    // which is the accessibility claim. Matching anywhere on the page would pass on
    // the sr-only table alone and prove nothing about what a sighted user sees.
    const chart = await screen.findByRole('img', { name: /Applied 412/ });
    for (const label of ['Applied', 'Screen', 'Onsite', 'Offer', 'Hired']) {
      expect(within(chart).getByText(label)).toBeInTheDocument();
    }
    for (const label of ['Referrals', 'Outbound', 'Careers page', 'Agencies']) {
      expect(screen.getByText(label)).toBeInTheDocument();
    }
  });

  it('exposes each chart to a screen reader as a label and a table', async () => {
    serve('recruiter');
    renderWith(<ReportsScreen />);

    // Coloured divs are invisible without this.
    expect(await screen.findByRole('img', { name: /Applied 412/ })).toBeInTheDocument();
    expect(screen.getByRole('img', { name: /W8 28/ })).toBeInTheDocument();
    expect(screen.getByRole('table', { name: 'Pipeline conversion' })).toBeInTheDocument();
    expect(screen.getByRole('table', { name: 'Interviews per week' })).toBeInTheDocument();
  });

  it('renders zero-width bars rather than NaN when every count is zero', async () => {
    serve('recruiter', (url) =>
      url.pathname === '/api/mock/reports/overview'
        ? json({
            period: 'No data',
            tiles: [{ key: 'time_to_hire', label: 'Time to hire', value: '—', delta: null, direction: 'flat' }],
            conversion: [{ stage: 'applied', label: 'Applied', count: 0 }],
            sources: [],
            interviewsPerWeek: [{ label: 'W1', count: 0 }],
          })
        : undefined,
    );
    renderWith(<ReportsScreen />);

    await screen.findByRole('heading', { name: 'Pipeline conversion' });
    // §10 case 11 — the guard exists so a style attribute never reads "NaN%".
    for (const bar of document.querySelectorAll('[style*="width"], [style*="height"]')) {
      expect(bar.getAttribute('style')).not.toContain('NaN');
    }
    // §10 case 12 — a tile with no delta omits the line entirely.
    expect(screen.getByText('—')).toBeInTheDocument();
  });

  it('offers an error state', async () => {
    serve('recruiter', (url) => (url.pathname === '/api/mock/reports/overview' ? json({}, 500) : undefined));
    renderWith(<ReportsScreen />);

    await waitFor(() => expect(screen.getByText('Reports could not be loaded.')).toBeInTheDocument());
  });
});
