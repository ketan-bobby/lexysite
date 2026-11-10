import { z } from "zod/v4";
import { CalendarError } from "../outlook-calendar-core";
import { zohoApplicationIdentity } from "./zoho-application-identity";

export type ZohoImportKind = "job" | "candidate";
export const zohoImportId = z.string().regex(/^[1-9]\d{0,39}$/);
export const zohoImportSelection = z.strictObject({
  revision: z.uuid(),
  kind: z.enum(["job", "candidate"]),
  recordId: zohoImportId,
  confirm: z.literal(true),
});
export const zohoImportConfirmation = zohoImportSelection.extend({
  previewToken: z.string().min(1).max(8000),
  existingId: z.string().min(1).max(200).nullable(),
});
export const zohoJobApplicantSelection = z.strictObject({
  revision: z.uuid(),
  jobId: zohoImportId,
  page: z.number().int().min(1).max(100),
  confirm: z.literal(true),
});
export type ZohoJobApplicantSelection = z.infer<typeof zohoJobApplicantSelection>;
export function zohoJobApplicants(jobId: string, page: number, payload: unknown) {
  try {
    const parsed = z
      .object({
        data: z.array(z.unknown()).max(25),
        info: z.object({ more_records: z.boolean() }).optional(),
      })
      .parse(payload);
    const applications = parsed.data.map((record) => {
      const identity = zohoApplicationIdentity(record);
      if (!identity) throw Error("Unverified application identity");
      return identity;
    });
    if (
      applications.some((record) => record.jobId !== jobId) ||
      new Set(applications.map((record) => record.applicationId)).size !== applications.length ||
      (parsed.data.length && !parsed.info) ||
      (parsed.data.length === 25 && !parsed.info)
    )
      throw Error("Invalid page");
    return {
      jobId,
      page,
      moreRecords: parsed.info?.more_records ?? false,
      applications: applications.map((record) => ({
        applicationId: record.applicationId,
        candidateId: record.candidateId,
      })),
    };
  } catch {
    throw zohoIntakeFailure(
      "Zoho did not confirm this job's application identities. No applicants were added or contacted.",
    );
  }
}
export type ZohoImportSelection = z.infer<typeof zohoImportSelection>;
export type ZohoImportConfirmation = z.infer<typeof zohoImportConfirmation>;
export const zohoIntakeFailure = (
  message = "The selected record requires an identity or privacy review. Nothing was imported.",
) => new CalendarError(409, "zoho_import_review_required", message);

const text = z.string().trim().min(1);
const job = z.object({
  id: zohoImportId,
  Posting_Title: text.max(500),
  Job_Description: text.max(20000),
  City: z.string().trim().max(500).nullable().optional(),
});
const candidate = z.object({
  id: zohoImportId,
  First_Name: z.string().trim().max(200).nullable().optional(),
  Last_Name: text.max(200),
  Email: z.string().trim().email().max(320),
  // Unknown/missing opt-out status is not permission to import.
  Email_Opt_Out: z.literal(false),
});
export function zohoIntakeRecord(kind: ZohoImportKind, id: string, body: unknown) {
  try {
    const envelope = z.object({ data: z.array(z.unknown()).length(1) }).parse(body);
    const fields = {
      title: null,
      description: null,
      location: null,
      firstName: null,
      lastName: null,
      email: null,
    };
    if (kind === "job") {
      const r = job.parse(envelope.data[0]);
      if (r.id !== id) throw new Error();
      return {
        ...fields,
        title: r.Posting_Title,
        description: r.Job_Description,
        location: r.City || null,
      };
    }
    const r = candidate.parse(envelope.data[0]);
    if (r.id !== id) throw new Error();
    return {
      ...fields,
      firstName: r.First_Name || "",
      lastName: r.Last_Name,
      email: r.Email.toLowerCase(),
    };
  } catch {
    throw zohoIntakeFailure(
      "Zoho did not return the expected fields, identity, or candidate opt-out clearance. Nothing was imported.",
    );
  }
}
export type ZohoIntakeFields = ReturnType<typeof zohoIntakeRecord>;
