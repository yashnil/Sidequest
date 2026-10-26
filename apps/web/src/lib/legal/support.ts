/**
 * PRODUCTION PASS — WHERE A TRAVELLER CAN REACH A PERSON.
 *
 * `SIDEQUEST_SUPPORT_EMAIL` is the only source of an address. Unset or not an
 * email, the pages say plainly that no contact address is published yet:
 * Sidequest never invents one. Import-free, read at request time.
 */
const EMAIL = /^[^\s@<>"]+@[^\s@<>"]+\.[^\s@<>"]+$/;

export function supportEmail(env: Record<string, string | undefined> = process.env): string | null {
  const raw = env.SIDEQUEST_SUPPORT_EMAIL?.trim() ?? '';
  return EMAIL.test(raw) && raw.length <= 254 ? raw : null;
}

export const NO_SUPPORT_EMAIL_COPY = 'A support address has not been published for this deployment yet. If you were invited to the alpha, reply to your invitation.';
