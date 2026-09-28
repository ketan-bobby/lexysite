import { candidateLearningRewardLedgerTable } from "@workspace/db";

export type LearningRewardInput = {
  candidateId: string;
  tenantId: string;
  eventKey: string;
  eventType: "first_completed_course" | "completed_course" | "first_completed_assessment" | "completed_voice_growth" | "completed_course_review";
  title: string;
  description: string;
  badgeKey?: string;
  creditsDelta: number;
  sourceType: string;
  sourceId: string;
};

/** Exact-once, append-only recognition. The unique event key is the concurrency boundary. */
export async function awardLearningReward(tx: any, input: LearningRewardInput): Promise<boolean> {
  const inserted = await tx.insert(candidateLearningRewardLedgerTable).values({
    id: crypto.randomUUID(), ...input, badgeKey: input.badgeKey ?? null,
    earnedAt: new Date(), createdAt: new Date(),
  }).onConflictDoNothing({ target: candidateLearningRewardLedgerTable.eventKey }).returning({ id: candidateLearningRewardLedgerTable.id });
  return inserted.length > 0;
}

export async function awardCourseCompletionRewards(tx: any, input: { candidateId: string; tenantId: string; courseId: string; sourceId: string }) {
  await awardLearningReward(tx, {
    ...input, eventKey: `${input.candidateId}:course:first`, eventType: "first_completed_course",
    title: "First course completed", description: "You completed your first learning course.", badgeKey: "first-course", creditsDelta: 25, sourceType: "course",
  });
  await awardLearningReward(tx, {
    ...input, eventKey: `${input.candidateId}:course:${input.courseId}`, eventType: "completed_course",
    title: "Course completed", description: "You completed a learning course.", badgeKey: "course-complete", creditsDelta: 20, sourceType: "course",
  });
}