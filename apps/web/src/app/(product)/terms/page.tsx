import type { Metadata } from 'next';
import Link from 'next/link';
import { LegalDocument, type LegalSection } from '@/components/LegalDocument';
import { NO_SUPPORT_EMAIL_COPY, supportEmail } from '@/lib/legal/support';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Terms — Sidequest',
  description: 'The terms of using Sidequest, a travel planning tool in beta.',
};

/** PRODUCTION PASS — terms of use, drafted from what the product does. Draft until an owner and a lawyer review it. */
export default function TermsPage() {
  const email = supportEmail();
  const sections: LegalSection[] = [
    {
      id: 'service',
      heading: 'What Sidequest is',
      body: (
        <>
          <p>Sidequest is a travel planning tool in beta. It proposes places, plans days and estimates travel times, costs and conditions from public and licensed data and from an AI model. It does not book anything, hold reservations or take payment.</p>
          <p>Booking links open other companies’ sites (for example accommodation, car hire or rail sellers). Sidequest is not a party to anything you book there; their terms and prices apply, and Sidequest never shows live prices or availability.</p>
        </>
      ),
    },
    {
      id: 'verify',
      heading: 'Plans are suggestions — check before you rely on them',
      body: (
        <>
          <p>Opening hours, closures, prices, travel times, weather, road and trail conditions can be wrong or out of date. Sidequest labels what it measured and what it estimated, but a “Ready” or feasibility verdict is a planning aid, not a guarantee.</p>
          <p>Entry, visa, health and safety information is never confirmed by Sidequest itself; always check the official sources it links, and the rules that apply to your nationality, before you travel. You are responsible for your own safety and decisions on the trip.</p>
        </>
      ),
    },
    {
      id: 'eligibility',
      heading: 'Who can use Sidequest',
      body: (
        <p>You must be old enough to agree to these terms where you live. If you plan a trip for children or other people, you are responsible for what you share about them.</p>
      ),
    },
    {
      id: 'use',
      heading: 'Acceptable use',
      body: (
        <ul>
          <li>Use Sidequest to plan real trips for yourself and the people you travel with.</li>
          <li>Do not automate requests, try to get around the daily research allowance or rate limits, or probe other people’s trips.</li>
          <li>Do not upload content you have no right to share, or other people’s personal data beyond what planning a shared trip needs.</li>
        </ul>
      ),
    },
    {
      id: 'content',
      heading: 'Your content',
      body: (
        <p>Your trips and what you write remain yours. You let Sidequest store and process them to provide the service, including sending them to the services listed in the <Link className="underline" href="/privacy">privacy notice</Link>. A share link you create lets anyone holding it read a copy of the plan until you revoke it.</p>
      ),
    },
    {
      id: 'attribution',
      heading: 'Map data and images',
      body: (
        <p>Map data © OpenStreetMap contributors, available under the Open Database Licence. Images and facts from Wikimedia Commons and Wikidata are credited on the page where they appear under their own licences. Place data includes the Overture Maps Foundation’s open place files, used under their published licences. “Help me choose” draws on Wikivoyage (contributors, CC BY-SA 4.0) and the open datasets credited beside its results. Place data from Google is shown under Google’s terms where it is used. Water crossings are judged against OpenStreetMap coastline land polygons (© OpenStreetMap contributors, ODbL) and HydroLAKES (Messager et al. 2016, CC BY 4.0).</p>
      ),
    },
    {
      id: 'availability',
      heading: 'Availability and changes',
      body: (
        <p>As a beta, Sidequest may change, pause, or lose data, and features may be removed. The operator may suspend access that breaks these terms or puts the service at risk. Download anything you need to keep from the <Link className="underline" href="/profile#your-data">Your data</Link> page. These terms may change; the date at the top says when they last did.</p>
      ),
    },
    {
      id: 'liability',
      heading: 'Liability',
      body: (
        <>
          <p>Sidequest is provided “as is” during the beta, without warranties of any kind, to the extent the law allows. The operator is not liable for indirect or consequential loss, or for decisions made on the strength of a plan, to the extent the law allows. Nothing here limits rights you have that cannot be limited by law.</p>
          <p>The operator’s legal entity, the governing law and any liability cap are still to be filled in after owner and legal review.</p>
        </>
      ),
    },
    {
      id: 'contact',
      heading: 'Contact',
      body: email ? (
        <p>
          <a className="underline" href={`mailto:${email}`}>{email}</a>
        </p>
      ) : (
        <p>{NO_SUPPORT_EMAIL_COPY}</p>
      ),
    },
  ];
  return <LegalDocument eyebrow="Sidequest" title="Terms of use" updated="15 November 2026" intro={<p>By using Sidequest you agree to these terms.</p>} sections={sections} />;
}
