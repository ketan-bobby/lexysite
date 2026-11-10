import { z } from "zod";

const optionalText = z.string().nullable().optional();
const optionalList = z.array(z.string()).nullable().optional();

// Validate provider output before it replaces a saved profile. Missing fields
// remain missing; normalization and all model instructions stay unchanged.
const CareerResumeProfile = z
  .object({
    name: optionalText,
    likely_role: optionalText,
    seniority_level: optionalText,
    total_years_experience: z.number().finite().nullable().optional(),
    current_company: optionalText,
    past_companies: optionalList,
    industries: optionalList,
    core_skills: optionalList,
    tools: optionalList,
    languages: optionalList,
    education: optionalText,
    certifications: optionalList,
    location: optionalText,
    linkedin_url: optionalText,
    github_url: optionalText,
    career_summary: optionalText,
  })
  .passthrough()
  .refine((profile) => Object.keys(profile).length > 0, "Empty résumé profile");

export type CareerResumeProfile = z.infer<typeof CareerResumeProfile>;

export function parseCareerResumeProfile(raw: string): CareerResumeProfile {
  return CareerResumeProfile.parse(JSON.parse(raw));
}
