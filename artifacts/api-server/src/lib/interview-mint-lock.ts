import { createHash } from "node:crypto";

/** Shared with native generate-link: never mint parallel native/ATS sessions. */
export function interviewMintLockKey(
  tenantId: string,
  candidateId: string,
  jobId: string,
  interviewType: string,
): bigint {
  return createHash("sha256")
    .update(`interview_mint:${tenantId}:${candidateId}:${jobId}:${interviewType}`)
    .digest()
    .readBigInt64BE(0);
}
