/**
 * Syntax/reserved-domain safety, not proof of delivery or DNS availability.
 * Keep in-app warnings, but never submit fixture/local addresses to public mail.
 */
export function isPublicNotificationAddress(email: string): boolean {
  const match = email.trim().match(/^[^@\s]+@([^@\s]+)$/);
  if (!match) return false;
  const domain = match[1].toLowerCase().replace(/\.$/, "");
  return (
    domain.includes(".") &&
    !/(^|\.)(invalid|test|example|localhost|local|localdomain)$/.test(domain) &&
    !/(^|\.)example\.(com|net|org)$/.test(domain)
  );
}
