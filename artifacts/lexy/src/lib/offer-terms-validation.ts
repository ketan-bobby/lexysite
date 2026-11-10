import type { ControlledOfferTerms } from "@workspace/api-client-react";

export type OfferTermsForm = {
  employerName: string;
  roleTitle: string;
  amount: string;
  currency: string;
  frequency: string;
  location: string;
  startDate: string;
  expiresAt: string;
  letter: string;
};

/** Client guidance only. Server validation and authority remain authoritative. */
export function validateOfferTerms(
  f: OfferTermsForm,
  now = Date.now(),
): { terms?: ControlledOfferTerms; error?: string } {
  const amount = Number(f.amount);
  if (!f.employerName.trim() || !f.roleTitle.trim() || !f.location.trim())
    return { error: "Employer, role and location are required." };
  if (
    f.employerName.trim().length > 200 ||
    f.roleTitle.trim().length > 200 ||
    f.location.trim().length > 300
  )
    return { error: "Employer and role must be at most 200 characters; location at most 300." };
  if (!Number.isFinite(amount) || amount <= 0)
    return { error: "Amount must be a finite positive number." };
  if (!/^[A-Z]{3}$/.test(f.currency)) return { error: "Currency must be three uppercase letters." };
  if (!["hourly", "monthly", "annual"].includes(f.frequency))
    return { error: "Choose a valid pay frequency." };
  const start = new Date(`${f.startDate}T00:00:00Z`);
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(f.startDate) ||
    !Number.isFinite(start.getTime()) ||
    start.toISOString().slice(0, 10) !== f.startDate
  )
    return { error: "Choose a valid calendar start date." };
  const expiry = new Date(f.expiresAt);
  if (!Number.isFinite(expiry.getTime())) return { error: "Choose an expiry date and time." };
  if (expiry.getTime() <= now) return { error: "Offer expiry must be a valid future date." };
  const letter = f.letter.trim();
  if (letter.length < 10 || letter.length > 12000)
    return { error: "Letter must be 10 to 12000 characters." };
  return {
    terms: {
      employerName: f.employerName.trim(),
      roleTitle: f.roleTitle.trim(),
      amount,
      currency: f.currency,
      frequency: f.frequency as ControlledOfferTerms["frequency"],
      location: f.location.trim(),
      startDate: f.startDate,
      expiresAt: expiry.toISOString(),
      letter,
    },
  };
}
