import {
  AtsContractError,
  atsSystemKey,
  type AtsMappingIdentity,
  type AtsRecordReader,
} from "./records";

type Resource = "jobs" | "candidates" | "applications";
type ReadPath = `/v3/${Resource}?ids=${string}`;

/**
 * Implement only with an employer-authorized server-side connection.
 * The transport must pin harvest.greenhouse.io, disallow redirects, bound
 * response size/time and never accept credentials or a host from request JSON.
 * A project-level connector alone is not an employer authorization.
 */
export type GreenhouseReadConnection = Readonly<{
  tenantId: string;
  accountRef: string;
  assertCurrentReadGrant(): Promise<void>;
  get(path: ReadPath): Promise<unknown>;
}>;

function requestId(value: string): string {
  // Harvest IDs are positive integers. Reject lossy/coerced/ambiguous inputs.
  if (!/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(Number(value)))
    throw new AtsContractError("invalid_identifier");
  return value;
}

function responseId(value: unknown): string {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0)
    throw new AtsContractError("invalid_response");
  return String(value);
}

function oneRecord(payload: unknown, expectedId: string): Record<string, unknown> {
  // Exact-ID lookup must not quietly accept a broad/unfiltered or partial list.
  if (!Array.isArray(payload) || payload.length !== 1)
    throw new AtsContractError("invalid_response");
  const row: unknown = payload[0];
  if (
    !row ||
    typeof row !== "object" ||
    Array.isArray(row) ||
    responseId((row as Record<string, unknown>).id) !== expectedId
  )
    throw new AtsContractError("invalid_response");
  return row as Record<string, unknown>;
}

/**
 * Read-only Harvest v3 adapter. This is deliberately not an OAuth connection
 * factory, HTTP endpoint, sync engine, or proof that an account is connected.
 */
export function createGreenhouseRecordReader(
  connection: GreenhouseReadConnection,
): AtsRecordReader {
  // Freeze binding and callbacks against caller mutation during I/O.
  const tenantId = connection.tenantId;
  const accountRef = connection.accountRef;
  const checkGrant = connection.assertCurrentReadGrant.bind(connection);
  const get = connection.get.bind(connection);
  return Object.freeze({
    tenantId,
    accountRef,
    system: "greenhouse",
    async readRecords(mapping: AtsMappingIdentity) {
      if (atsSystemKey(mapping.system) !== "greenhouse" || mapping.accountRef !== accountRef)
        throw new AtsContractError("scope_mismatch");
      const jobId = requestId(mapping.externalJobId);
      const candidateId = requestId(mapping.externalCandidateId);
      const applicationId = requestId(mapping.externalApplicationId);
      try {
        const read = async (resource: Resource, id: string) => {
          await checkGrant();
          return oneRecord(await get(`/v3/${resource}?ids=${id}`), id);
        };
        // Sequential reads stop immediately on invalid grants or records.
        await read("jobs", jobId);
        await read("candidates", candidateId);
        const application = await read("applications", applicationId);
        if (
          responseId(application.job_id) !== jobId ||
          responseId(application.candidate_id) !== candidateId
        )
          throw new AtsContractError("invalid_response");
        // Revocation during any of the reads invalidates the entire result.
        await checkGrant();
        return {
          job: { id: jobId },
          candidate: { id: candidateId },
          application: { id: applicationId, jobId, candidateId },
        };
      } catch (error) {
        if (error instanceof AtsContractError) throw new AtsContractError(error.code);
        // Never expose transport URLs, tokens, response bodies or provider causes.
        throw new AtsContractError("read_failed");
      }
    },
  });
}
