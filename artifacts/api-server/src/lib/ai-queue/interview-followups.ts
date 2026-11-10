import type { EnqueueArgs } from "./queue";

interface InterviewFollowupContext {
  sessionId: string;
  tenantId: string | null;
  candidateId: string | null;
  jobId: string | null;
}

type EnqueueInterviewJob = (args: EnqueueArgs) => Promise<{ id: string } | null>;

/** Same interview retries reuse work; a new interview supplies new evidence. */
export async function enqueueInterviewFollowups(
  context: InterviewFollowupContext,
  enqueue: EnqueueInterviewJob,
): Promise<void> {
  const { sessionId, tenantId, candidateId, jobId } = context;
  if (!jobId || !candidateId) return;

  // A missing child must retry the parent, without repeating saved grading.
  const insights = await enqueue({
    type: "generate_candidate_insights",
    payload: { sessionId },
    tenantId,
    interviewSessionId: sessionId,
    dedupeKey: `insights:${sessionId}`,
    priority: 5,
  });
  if (!insights) {
    throw new Error(
      `chainDownstream: failed to enqueue generate_candidate_insights for session ${sessionId}`,
    );
  }
  const match = await enqueue({
    type: "match_candidate_to_job",
    payload: { candidateId, jobId },
    tenantId,
    interviewSessionId: sessionId,
    dedupeKey: `match:${candidateId}:${jobId}:interview:${sessionId}`,
    priority: 1,
  });
  if (!match) {
    throw new Error(
      `chainDownstream: failed to enqueue match_candidate_to_job for session ${sessionId}`,
    );
  }
}
