import { z } from "zod/v4";

// No arbitrary provider attributes, attachments, custom fields or demographics.
const bounded = z.string().trim().min(1).max(200);
const schema = z.object({
  id: z.number().int().positive().safe(),
  private: z.literal(false),
  can_email: z.literal(true),
  first_name: bounded,
  last_name: bounded,
  email_addresses: z
    .array(z.object({ value: z.string().trim().email().max(320) }))
    .min(1)
    .max(10),
  title: z.string().trim().max(500).nullable().optional(),
  company: z.string().trim().max(500).nullable().optional(),
});

export function candidateProfile(records: unknown, candidateId: string, professional: boolean) {
  if (!Array.isArray(records) || records.length !== 1) throw new Error("Profile unavailable");
  const p = schema.parse(records[0]);
  if (String(p.id) !== candidateId) throw new Error("Profile unavailable");
  return {
    firstName: p.first_name,
    lastName: p.last_name,
    emails: [...new Set(p.email_addresses.map((e) => e.value.toLowerCase()))],
    currentTitle: professional ? p.title || null : null,
    currentCompany: professional ? p.company || null : null,
    includeProfessional: professional,
  };
}
export type CandidateProfile = ReturnType<typeof candidateProfile>;
