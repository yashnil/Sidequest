import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: () => {}, push: () => {} }) }));
vi.mock('./actions', () => ({ deleteTripAction: async () => ({ ok: true }) }));
vi.mock('./profile/actions', () => ({ deleteAllMyDataAction: async () => ({ ok: true, trips: 0, account: false }) }));

const { default: PrivacyPage } = await import('./privacy/page');
const { default: TermsPage } = await import('./terms/page');
const { default: SupportPage } = await import('./support/page');
const { DataControls } = await import('./profile/DataControls');
const { supportEmail } = await import('@/lib/legal/support');

/**
 * PRODUCTION PASS — THE LEGAL SURFACES SAY THEY ARE DRAFTS, NAME WHO GETS DATA,
 * AND NEVER INVENT A CONTACT ADDRESS.
 */
afterEach(() => {
  delete process.env.SIDEQUEST_SUPPORT_EMAIL;
});

describe('the legal pages', () => {
  it('each carries the visible draft notice', () => {
    for (const Page of [PrivacyPage, TermsPage, SupportPage]) {
      expect(renderToStaticMarkup(createElement(Page))).toContain('Draft — requires owner/legal review before public launch');
    }
  });

  it('names every service the server sends traveller data to', () => {
    const html = renderToStaticMarkup(createElement(PrivacyPage));
    for (const name of ['Anthropic', 'Google', 'Nominatim', 'Overpass', 'openrouteservice', 'Open-Meteo', 'Wikimedia', 'Railway', 'sidequest_session', 'sidequest_auth', 'sidequest_oauth']) {
      expect(html, name).toContain(name);
    }
  });

  it('shows the configured support address and nothing when there is none', () => {
    expect(renderToStaticMarkup(createElement(SupportPage))).toContain('support-email-missing');
    expect(renderToStaticMarkup(createElement(SupportPage))).not.toContain('mailto:');
    process.env.SIDEQUEST_SUPPORT_EMAIL = 'help@sidequest.test';
    expect(renderToStaticMarkup(createElement(SupportPage))).toContain('mailto:help@sidequest.test');
  });

  it('accepts only something shaped like an address', () => {
    expect(supportEmail({ SIDEQUEST_SUPPORT_EMAIL: 'not an address' })).toBeNull();
    expect(supportEmail({ SIDEQUEST_SUPPORT_EMAIL: ' a@b.co ' })).toBe('a@b.co');
  });
});

describe('the data controls', () => {
  it('offers download, per-trip delete and a full delete, each destructive one behind a confirmation step', () => {
    const html = renderToStaticMarkup(createElement(DataControls, { trips: [{ id: 't1', title: 'Iceland' }], signedIn: true }));
    expect(html).toContain('href="/api/me/export"');
    expect(html).toContain('Delete this trip');
    expect(html).toContain('Delete my account and all my data');
    // The confirmation phrase input only exists after the first press.
    expect(html).not.toContain('delete-all-phrase');
  });
});
