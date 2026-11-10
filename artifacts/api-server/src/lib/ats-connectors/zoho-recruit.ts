import { zohoApplicationIdentity } from "./zoho-application-identity";
import {
  AtsContractError,
  atsRecordId,
  atsSystemKey,
  type AtsMappingIdentity,
  type AtsRecordReader,
} from "./records";

type Module = "Job_Openings" | "Candidates" | "Applications";
export type ZohoRecruitReadPath = `/recruit/v2/${Module}/${string}`;

/**
 * Supply only from an employer-authorized server connection. Its transport must
 * pin the account's verified Zoho data centre, prohibit redirects, bound response
 * time/size, and sanitize provider failures. A generic Zoho/CRM connection is not
 * proof of Recruit access or employer ownership.
 */
export type ZohoRecruitReadConnection = Readonly<{
  tenantId: string;
  accountRef: string;
  assertCurrentReadGrant(): Promise<void>;
  get(path: ZohoRecruitReadPath): Promise<unknown>;
}>;

// Zoho returns long IDs as strings. Number coercion can merge distinct records.
function recordId(value: unknown, code: "invalid_identifier" | "invalid_response"): string {
  if (typeof value !== "string" || !/^[1-9]\d{0,39}$/.test(value)) throw new AtsContractError(code);
  return value;
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new AtsContractError("invalid_response");
  return value as Record<string, unknown>;
}

function oneRecord(payload: unknown, expectedId: string): Record<string, unknown> {
  const envelope = object(payload);
  if (!Array.isArray(envelope.data) || envelope.data.length !== 1)
    throw new AtsContractError("invalid_response");
  const row = object(envelope.data[0]);
  if (recordId(row.id, "invalid_response") !== expectedId)
    throw new AtsContractError("invalid_response");
  return row;
}

/**
 * Read-only Recruit v2 adapter for the shared mapping verifier. No persistence,
 * stage transitions, candidate enrollment, outbound messages or offer operations.
 *
 * Applications must expose native $Candidate_Id / $Job_Opening_Id or verified
 * object lookup IDs. Missing/customized fields require review, never a guess
 * from names, email, history entries, or an association-list position.
 */
export function createZohoRecruitRecordReader(
  connection: ZohoRecruitReadConnection,
): AtsRecordReader {
  const tenantId = atsRecordId(connection.tenantId);
  const accountRef = atsRecordId(connection.accountRef);
  const checkGrant = connection.assertCurrentReadGrant.bind(connection);
  const get = connection.get.bind(connection);
  return Object.freeze({
    tenantId,
    accountRef,
    system: "zoho_recruit",
    async readRecords(mapping: AtsMappingIdentity) {
      if (atsSystemKey(mapping.system) !== "zoho_recruit" || mapping.accountRef !== accountRef)
        throw new AtsContractError("scope_mismatch");
      const jobId = recordId(mapping.externalJobId, "invalid_identifier");
      const candidateId = recordId(mapping.externalCandidateId, "invalid_identifier");
      const applicationId = recordId(mapping.externalApplicationId, "invalid_identifier");
      try {
        const read = async (module: Module, id: string) => {
          await checkGrant();
          return oneRecord(await get(`/recruit/v2/${module}/${id}`), id);
        };
        // Exact record reads only; stop before fetching more data on any failure.
        await read("Job_Openings", jobId);
        await read("Candidates", candidateId);
        const application = await read("Applications", applicationId);
        const identity = zohoApplicationIdentity(application);
        if (!identity || identity.jobId !== jobId || identity.candidateId !== candidateId)
          throw new AtsContractError("invalid_response");
        await checkGrant();
        return {
          job: { id: jobId },
          candidate: { id: candidateId },
          application: { id: applicationId, jobId, candidateId },
        };
      } catch (error) {
        if (error instanceof AtsContractError) throw new AtsContractError(error.code);
        throw new AtsContractError("read_failed");
      }
    },
  });
}
