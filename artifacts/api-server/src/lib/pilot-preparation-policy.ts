import { isIsolatedPilotJob } from "./workflow-pilot-policy";

type Source = { id: string; tenantId: string; status: string; createdById: string | null };
type Operator = { id: string; tenantId: string | null; status: string; role: string };
type Candidate = {
  id: string;
  tenantId: string;
  email: string | null;
  pool: string;
  doNotContact: boolean;
  dataErasedAt: Date | null;
};

/** Configuration only. This deliberately does NOT grant live pilot authority. */
export function assertPilotPreparationScope(
  source: Source | undefined,
  operator: Operator | undefined,
  candidate: Candidate | undefined,
  recipient: string,
) {
  if (
    !source?.id.startsWith("livepilot_") ||
    !source.tenantId.startsWith("livepilot_") ||
    source.status !== "active"
  )
    throw new Error("Source must be an active, isolated livepilot requisition.");
  if (
    !operator ||
    operator.id !== source.createdById ||
    !operator.id.startsWith("livepilot_") ||
    operator.status !== "active" ||
    operator.role !== "tenant_admin" ||
    operator.tenantId !== source.tenantId ||
    !candidate?.id.startsWith("livepilot_candidate_") ||
    candidate.tenantId !== source.tenantId ||
    candidate.pool !== "tenant" ||
    candidate.doNotContact ||
    candidate.dataErasedAt ||
    !recipient.trim() ||
    candidate.email?.trim().toLowerCase() !== recipient.trim().toLowerCase()
  )
    throw new Error("Pilot operator, candidate ownership, privacy or recipient check failed.");
}

export function assertReusablePreparedPilot(
  job: {
    tenantId: string;
    createdById: string | null;
    interviewPath: string | null;
    title: string;
  },
  sourceTenantId: string,
  operatorId: string,
) {
  if (
    job.tenantId !== sourceTenantId ||
    job.createdById !== operatorId ||
    job.interviewPath !== "ai" ||
    !isIsolatedPilotJob(job.title)
  )
    throw new Error(
      "Existing pilot does not match the controlled preparation; nothing will be overwritten.",
    );
}
