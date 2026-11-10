import type { AtsRecordMapping } from "@workspace/db";

/** Common identities, not credentials or proof of a remote connection. */
export type AtsMappingIdentity = Pick<
  AtsRecordMapping,
  "system" | "accountRef" | "externalJobId" | "externalCandidateId" | "externalApplicationId"
>;

export type LocalAtsBinding = {
  tenantId: string;
  workflowId: string;
  jobId: string;
  candidateId: string;
  mapping: AtsMappingIdentity;
};

export class AtsContractError extends Error {
  constructor(
    public readonly code:
      | "invalid_identifier"
      | "scope_mismatch"
      | "invalid_response"
      | "read_failed",
  ) {
    super(
      {
        invalid_identifier: "Supply a valid non-empty ATS record identifier, not credentials.",
        scope_mismatch: "ATS connection does not cover this employer and account.",
        invalid_response: "ATS records could not be verified against this mapping.",
        read_failed: "ATS record verification is unavailable. No synchronization occurred.",
      }[code],
    );
    this.name = "AtsContractError";
  }
}

export function atsRecordId(value: string): string {
  const result = value.trim();
  if (!result || result.length > 128 || /[\u0000-\u001f\u007f]/.test(result))
    throw new AtsContractError("invalid_identifier");
  return result;
}

export function atsSystemKey(system: string): string {
  return atsRecordId(system).toLowerCase();
}

/** Account identifiers stay case-sensitive; provider names do not. */
export function sameAtsAccount(a: AtsMappingIdentity, b: AtsMappingIdentity): boolean {
  return atsSystemKey(a.system) === atsSystemKey(b.system) && a.accountRef === b.accountRef;
}

/**
 * One external application per workflow; job/person mappings are bijective
 * within one tenant/provider/account. Never compare across employer boundaries.
 */
export function atsMappingConflicts(proposed: LocalAtsBinding, existing: LocalAtsBinding): boolean {
  if (
    proposed.tenantId !== existing.tenantId ||
    proposed.workflowId === existing.workflowId ||
    !sameAtsAccount(proposed.mapping, existing.mapping)
  )
    return false;
  const a = proposed.mapping;
  const b = existing.mapping;
  return (
    (a.externalJobId === b.externalJobId && proposed.jobId !== existing.jobId) ||
    (proposed.jobId === existing.jobId && a.externalJobId !== b.externalJobId) ||
    (a.externalCandidateId === b.externalCandidateId &&
      proposed.candidateId !== existing.candidateId) ||
    (proposed.candidateId === existing.candidateId &&
      a.externalCandidateId !== b.externalCandidateId) ||
    a.externalApplicationId === b.externalApplicationId
  );
}

/** Minimal normalized read result. No names, contact data, offers or demographics. */
export type AtsRecordSet = {
  job: { id: string };
  candidate: { id: string };
  application: { id: string; jobId: string; candidateId: string };
};

/**
 * A server-side adapter must load these facts from an authorized employer
 * connection, not from request JSON. No generic write/offer operation exists.
 */
export type AtsRecordReader = {
  tenantId: string;
  system: string;
  accountRef: string;
  readRecords(mapping: AtsMappingIdentity): Promise<AtsRecordSet>;
};

export async function verifyAtsRecordMapping(
  tenantId: string,
  mapping: AtsMappingIdentity,
  reader: AtsRecordReader,
): Promise<AtsRecordSet> {
  if (
    reader.tenantId !== tenantId ||
    !sameAtsAccount(mapping, {
      ...mapping,
      system: reader.system,
      accountRef: reader.accountRef,
    })
  )
    throw new AtsContractError("scope_mismatch");
  // Copy primitive fields: a caller cannot mutate identity while awaiting I/O.
  const expected: AtsMappingIdentity = {
    system: atsRecordId(mapping.system),
    accountRef: atsRecordId(mapping.accountRef),
    externalJobId: atsRecordId(mapping.externalJobId),
    externalCandidateId: atsRecordId(mapping.externalCandidateId),
    externalApplicationId: atsRecordId(mapping.externalApplicationId),
  };
  let result: AtsRecordSet;
  try {
    result = await reader.readRecords({ ...expected });
  } catch {
    // Provider exceptions can contain credentials, URLs and private response bodies.
    throw new AtsContractError("read_failed");
  }
  if (
    !result ||
    result.job?.id !== expected.externalJobId ||
    result.candidate?.id !== expected.externalCandidateId ||
    result.application?.id !== expected.externalApplicationId ||
    result.application.jobId !== expected.externalJobId ||
    result.application.candidateId !== expected.externalCandidateId
  )
    throw new AtsContractError("invalid_response");
  // Reconstruct rather than spreading the provider payload.
  return {
    job: { id: result.job.id },
    candidate: { id: result.candidate.id },
    application: {
      id: result.application.id,
      jobId: result.application.jobId,
      candidateId: result.application.candidateId,
    },
  };
}
