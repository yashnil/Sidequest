import type { Metadata } from 'next';
import Link from 'next/link';
import { LegalDocument, type LegalSection } from '@/components/LegalDocument';
import { NO_SUPPORT_EMAIL_COPY, supportEmail } from '@/lib/legal/support';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Support — Sidequest',
  description: 'How to get help with Sidequest, report a problem, or ask about your data.',
};

/** PRODUCTION PASS — how to reach a person. The address comes only from `SIDEQUEST_SUPPORT_EMAIL`; none is invented. */
export default function SupportPage() {
  const email = supportEmail();
  const sections: LegalSection[] = [
    {
      id: 'contact',
      heading: 'Contact',
      body: email ? (
        <p>
          Email <a className="underline" href={`mailto:${email}`} data-testid="support-email">{email}</a>. Include the reference shown on any error screen — it lets us find what happened without needing your trip’s contents.
        </p>
      ) : (
        <p data-testid="support-email-missing">{NO_SUPPORT_EMAIL_COPY}</p>
      ),
    },
    {
      id: 'common',
      heading: 'Common questions',
      body: (
        <ul>
          <li><strong>I lost my trips.</strong> Without an account, trips belong to the browser that made them; clearing cookies or switching browsers loses access. Signing in (where offered) saves them to your account.</li>
          <li><strong>“Come back tomorrow”.</strong> Sidequest has a daily research allowance; existing trips stay readable and editable.</li>
          <li><strong>A place, time or price is wrong.</strong> Use the feedback control on the trip, and check anything time-sensitive with the venue or official source.</li>
        </ul>
      ),
    },
    {
      id: 'data',
      heading: 'Your data',
      body: (
        <p>
          Download or delete your data yourself on the <Link className="underline" href="/profile#your-data">Your data</Link> page. The <Link className="underline" href="/privacy">privacy notice</Link> lists what is stored and where it is sent.
        </p>
      ),
    },
    {
      id: 'abuse',
      heading: 'Reporting abuse or a security issue',
      body: <p>Report a shared link that should not be public, or a security problem, to the contact above. Please do not test against other people’s trips.</p>,
    },
  ];
  return <LegalDocument eyebrow="Sidequest" title="Support" updated="24 October 2026" intro={<p>Sidequest is in private alpha, run by a small team.</p>} sections={sections} />;
}
