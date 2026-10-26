import type { Metadata } from 'next';
import Link from 'next/link';
import { LegalDocument, type LegalSection } from '@/components/LegalDocument';
import { NO_SUPPORT_EMAIL_COPY, supportEmail } from '@/lib/legal/support';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Privacy — Sidequest',
  description: 'What Sidequest stores, what it sends to other services, and how to download or delete it.',
};

/**
 * PRODUCTION PASS — THE PRIVACY NOTICE, AS THE CODE BEHAVES TODAY.
 *
 * Every statement here is traceable to code: cookies (`lib/net/caller.ts`,
 * `lib/auth/session.ts`, `lib/auth/oauth-state.ts`, `lib/net/billable-surface.ts`),
 * storage (`lib/db/client.ts`, SQLite on the Railway volume), browser storage
 * (`components/OfflineSnapshot.tsx`, `components/setup/SetupFlow.tsx`), the
 * providers under `lib/providers/`, logs (`lib/net/product-events.ts`,
 * `instrumentation.ts`) and retention (`lib/db/retention.ts`). Change the code
 * and this page must change with it. Draft until reviewed.
 */
export default function PrivacyPage() {
  const email = supportEmail();
  const sections: LegalSection[] = [
    {
      id: 'what-we-store',
      heading: 'What Sidequest stores',
      body: (
        <>
          <p>Sidequest stores what you give it so it can plan and keep your trip:</p>
          <ul>
            <li>Trip details: destination, dates, arrival and departure times, the questionnaire answers, the places you pick or reject on the Discovery Board, the plan Sidequest builds, and every change you make to it.</li>
            <li>The people you travel with, if you describe them: a name or label, relationship, and any dietary or functional needs you choose to note. These are used only as planning constraints.</li>
            <li>Booking confirmations you import (pasted text, an email file, a PDF or a photo). Card numbers and similar details are removed before anything is stored or sent; only the redacted text and the extracted facts are kept, and only after you confirm them.</li>
            <li>Feedback you send, the decisions you record, and leanings Sidequest learns from your choices (you can dismiss any of these on your profile).</li>
            <li>If you sign in with Google: your Google account identifier, email address, whether Google has verified it, your display name and profile picture URL, plus any travel profile fields you fill in.</li>
          </ul>
          <p>All of this is kept in one SQLite database on the server that runs Sidequest (currently a Railway volume in the operator’s chosen region).</p>
        </>
      ),
    },
    {
      id: 'cookies',
      heading: 'Cookies and browser storage',
      body: (
        <>
          <p>Sidequest uses only cookies it needs to work. There are no advertising or analytics cookies and no third-party scripts.</p>
          <ul>
            <li><code>sidequest_session</code> — an anonymous random identifier that makes your trips yours on this browser. httpOnly, 180 days.</li>
            <li><code>sidequest_auth</code> — set only when you sign in. httpOnly, 90 days; signing out or deleting your account ends it.</li>
            <li><code>sidequest_oauth</code> — set for up to ten minutes while Google sign-in is in progress, to check that the sign-in you finish is the one you started.</li>
            <li><code>sidequest_labs</code> — only for operators of the internal test harness.</li>
          </ul>
          <p>Your browser may also keep an offline copy of trip pages you open (so the plan works without signal) and an unsent trip-setup draft for the current tab. “Delete all my data” on the <Link className="underline" href="/profile#your-data">Your data</Link> page clears the offline copies on that browser.</p>
        </>
      ),
    },
    {
      id: 'third-parties',
      heading: 'Services Sidequest sends data to',
      body: (
        <>
          <p>To research and plan a trip, the server sends the minimum it needs to these services. Which ones are active depends on how this deployment is configured.</p>
          <ul>
            <li><strong>Anthropic</strong> (Claude API, United States) — your trip details, questionnaire answers including free-text notes and the needs of the people you travel with, refinement requests, and redacted booking text are sent so the model can propose places and interpret what you wrote.</li>
            <li><strong>Google</strong> — if sign-in is enabled, Google handles your sign-in. If Google Maps Platform is configured, place names and areas are sent to the Places API to locate them, and place photos are fetched through Sidequest’s server.</li>
            <li><strong>OpenStreetMap services</strong> — place and area names go to Nominatim to find their coordinates, and map areas to Overpass to find nearby food and points of interest.</li>
            <li><strong>Routing</strong> — coordinates of stops go to openrouteservice (HeiGIT) or a Valhalla router to measure travel times.</li>
            <li><strong>Open-Meteo</strong> — coordinates and dates, for forecasts and climate normals. <strong>Frankfurter</strong> — currency codes, for exchange rates.</li>
            <li><strong>Wikimedia and Wikidata</strong> — place names, to find openly licensed images and facts.</li>
            <li><strong>Railway</strong> — hosts the server and its database.</li>
          </ul>
          <p>Your browser itself loads map tiles (OpenFreeMap, and terrain tiles from Amazon S3 where shown) and images from Wikimedia, so those services see your IP address and the area of the map you view, as with any map on the web.</p>
          <p>Sidequest does not sell your data and does not share it for advertising.</p>
        </>
      ),
    },
    {
      id: 'sharing',
      heading: 'Share links and calendar feeds',
      body: (
        <p>A share link shows a read-only copy of a plan to anyone who has it. It leaves out booking references, notes, the people you travel with and their needs, and every owner control. A calendar feed carries no references, notes or costs. You can revoke either at any time; deleting a trip deletes both.</p>
      ),
    },
    {
      id: 'logs',
      heading: 'Logs',
      body: (
        <p>The server writes operational logs: product counters (for example “a build completed”) with a short trip reference and enumerated facts, never trip content; error reports with a request reference and the route; and provider failures. Logs are kept by the hosting provider for the life of the current deployment. Rate limits and the daily research allowance keep a pseudonymous counter per browser or network address for the current day.</p>
      ),
    },
    {
      id: 'retention',
      heading: 'How long it is kept',
      body: (
        <ul>
          <li>Trips, their plans and everything attached to them are kept until you delete them (or delete all your data). Trips made without an account are not swept automatically today.</li>
          <li>An account and its data are kept until you delete the account.</li>
          <li>Sign-in attempts expire after ten minutes; abandoned “help me decide” sessions after 60 days; cached readings of free text after 30 days; weather snapshots shortly after they stop being valid.</li>
          <li>Database backups, if taken by the operator, may hold deleted data until they are rotated.</li>
        </ul>
      ),
    },
    {
      id: 'your-rights',
      heading: 'Download or delete your data',
      body: (
        <p>
          On the <Link className="underline" href="/profile#your-data">Your data</Link> page you can download everything Sidequest holds for you as a JSON file, delete a single trip, or delete all of it — including your account if you are signed in. Without an account, “you” means this browser: Sidequest cannot tell which other browser is yours. Deletion is immediate and cannot be undone.
        </p>
      ),
    },
    {
      id: 'contact',
      heading: 'Contact',
      body: email ? (
        <p>
          Questions or requests about your data: <a className="underline" href={`mailto:${email}`}>{email}</a>. See also <Link className="underline" href="/support">Support</Link>.
        </p>
      ) : (
        <p>{NO_SUPPORT_EMAIL_COPY}</p>
      ),
    },
  ];
  return (
    <LegalDocument
      eyebrow="Sidequest"
      title="Privacy notice"
      updated="24 October 2026"
      intro={<p>Sidequest plans trips from what you tell it. This notice says what it keeps, what it sends to other services to do that, and how to take it back.</p>}
      sections={sections}
    />
  );
}
