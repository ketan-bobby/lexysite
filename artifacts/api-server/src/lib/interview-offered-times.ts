import { randomUUID } from "node:crypto";
import { interviewOfferedTimesTable, interviewSchedulesTable } from "@workspace/db";
import { candidateTimeVersion } from "./candidate-schedule-confirmation";

type Offer = typeof interviewOfferedTimesTable.$inferSelect;
type Schedule = Pick<
  typeof interviewSchedulesTable.$inferSelect,
  "id" | "scheduledAt" | "durationMinutes"
> &
  Record<string, unknown>;

export function offeredTimesView(
  schedule: Schedule,
  candidateId: string,
  applicationId: string,
  offer: Offer | undefined,
  now: number,
) {
  const version = candidateTimeVersion(schedule);
  const active =
    offer &&
    offer.candidateId === candidateId &&
    offer.applicationId === applicationId &&
    offer.proposalVersion === version &&
    offer.expiresAt.getTime() > now;
  return {
    scheduleId: schedule.id,
    version,
    scheduledAt: schedule.scheduledAt.toISOString(),
    durationMinutes: schedule.durationMinutes,
    offerVersion: active ? offer.version : null,
    startsAt: [schedule.scheduledAt.toISOString(), ...(active ? offer.alternatives : [])],
    expiresAt: active ? offer.expiresAt.toISOString() : null,
  };
}

export function makeOfferedTimes(
  schedule: Schedule,
  candidateId: string,
  applicationId: string,
  alternatives: string[],
  now: number,
): Offer {
  const instants = alternatives.map((value) => new Date(value).getTime());
  const original = schedule.scheduledAt.getTime();
  if (
    instants.length > 4 ||
    instants.some(
      (instant) => !Number.isFinite(instant) || instant <= now || instant === original,
    ) ||
    new Set(instants).size !== instants.length
  )
    throw new Error(
      "Offer up to four distinct future alternatives, different from the original time.",
    );
  return {
    scheduleId: schedule.id,
    candidateId,
    applicationId,
    proposalVersion: candidateTimeVersion(schedule),
    version: randomUUID(),
    alternatives: instants.map((instant) => new Date(instant).toISOString()),
    // Alternatives never outlive the first offered time or a seven-day window.
    expiresAt: new Date(Math.min(now + 7 * 86400000, original, ...instants)),
  };
}
