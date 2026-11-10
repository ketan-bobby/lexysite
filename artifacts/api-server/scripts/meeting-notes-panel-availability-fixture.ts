import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import {
  dbAdmin,
  staffGoogleCalendarsTable as grants,
  calendarWorkingHoursTable as hours,
  googlePanelConsentsTable as consents,
} from "@workspace/db";
import { calendarStaff } from "../src/lib/calendar-staff";
import { googleInvitationStore } from "../src/lib/google-invitation-store";
import { prepareGooglePanelOperation } from "../src/lib/google-panel-operation-availability";
import { googleInterviewEventChanges } from "../src/lib/google-interview-event-changes";
import { googleStaffProvider } from "../src/lib/google-staff-provider";
import { googleStaffConfig } from "../src/lib/google-staff-config";
import { sealGoogleCredential } from "../src/lib/google-staff-service";
import type { GoogleEventDetails } from "../src/lib/google-interview-event";

/** Invoked only inside the existing fingerprint-guarded synthetic fixture.
 * Real private joins/locks/credential CAS; provider transport is entirely fake.
 */
export async function checkPanelAvailabilityFixture(
  actorId: string,
  memberId: string,
  scheduleId: string,
) {
  const actor = await calendarStaff(actorId),
    store = googleInvitationStore();
  const old = await dbAdmin
    .select()
    .from(grants)
    .where(inArray(grants.userId, [actorId, memberId]));
  const [consent] = await dbAdmin.select().from(consents).where(eq(consents.userId, memberId));
  const [oldHours] = await dbAdmin.select().from(hours).where(eq(hours.userId, memberId));
  let locked = false,
    busy = false,
    checked = 0,
    refreshed = 0,
    failSecond = false;
  const provider = (() => ({
    async refresh(raw: string) {
      assert.equal(locked, false, "Refresh must precede the panel/grant lock transaction");
      refreshed++;
      if (failSecond && refreshed === 2) throw Error("Synthetic member refresh failure");
      return { accessToken: `access-${raw}`, refreshToken: `rotated-${raw}` };
    },
  })) as unknown as typeof googleStaffProvider;
  const rollback = new Error("rollback-locked-availability-check");
  try {
    for (const grant of old)
      await dbAdmin
        .update(grants)
        .set({
          refreshTokenEnc: sealGoogleCredential(
            { id: grant.userId, tenantId: grant.tenantId },
            "refresh",
            `${grant.userId}-fixture-refresh`,
          ),
        })
        .where(eq(grants.userId, grant.userId));
    const original = await store.read(actor, scheduleId);
    const schedule = original.context.schedule;
    const d: GoogleEventDetails = {
      transactionId: original.attempt!.transactionId,
      binding: "synthetic",
      jobTitle: original.context.job.title,
      organizerEmail: original.connection!.accountEmail!,
      recipientEmail: original.context.candidate.email,
      panelEmails: original
        .panel!.recipients.filter((p) => p.userId !== actorId)
        .map((p) => p.email),
      startAt: schedule.scheduledAt.toISOString(),
      endAt: new Date(
        schedule.scheduledAt.getTime() + schedule.durationMinutes * 60_000,
      ).toISOString(),
    };
    const source = {
      id: original.attempt!.eventId!,
      iCalUID: "synthetic-original-uid",
      etag: '"synthetic"',
      startAt: new Date(schedule.scheduledAt.getTime() - 15 * 60_000).toISOString(),
      endAt: new Date(schedule.scheduledAt.getTime() + 15 * 60_000).toISOString(),
      meetUrl: original.attempt!.googleSnapshot!.meetUrl,
      conferenceStatus: "ready" as const,
      changeId: null,
    };
    const member = original.panel!.recipients.find((p) => p.userId === memberId)!;
    const events = googleInterviewEventChanges((async (_url, init) => {
      assert.equal(locked, true);
      assert.equal(init!.method, "GET");
      assert.ok(
        (init!.headers as Record<string, string>).Authorization.startsWith("Bearer access-"),
      );
      checked++;
      const copy = {
        id: "member-copy",
        iCalUID: source.iCalUID,
        status: "confirmed",
        organizer: { email: d.organizerEmail },
        start: { dateTime: source.startAt },
        end: { dateTime: source.endAt },
        attendees: [{ email: d.recipientEmail }, { email: member.email, self: true }],
      };
      return new Response(
        JSON.stringify({
          kind: "calendar#events",
          items: busy
            ? [copy, { ...copy, id: "private-second-booking", iCalUID: "other" }]
            : [copy],
        }),
        { status: 200 },
      );
    }) as typeof fetch);
    const beforeRefresh = await dbAdmin
      .select()
      .from(grants)
      .where(inArray(grants.userId, [actorId, memberId]));
    const prepared = await prepareGooglePanelOperation(actor, original, dbAdmin, provider, events);
    assert.equal(refreshed, 2);
    const rotated = await dbAdmin
      .select()
      .from(grants)
      .where(inArray(grants.userId, [actorId, memberId]));
    assert.ok(
      rotated.every(
        (c) =>
          c.refreshTokenEnc !== beforeRefresh.find((g) => g.userId === c.userId)!.refreshTokenEnc,
      ),
    );
    async function check() {
      return store.run(actor, original, async (current) => {
        locked = true;
        try {
          assert.ok(prepared.access(current).startsWith("access-"));
          await prepared.check(current, d, source);
          throw rollback;
        } finally {
          locked = false;
        }
      });
    }
    await assert.rejects(check, (error) => error === rollback);
    assert.equal(checked, 1);
    // Rolling back the later availability transaction cannot undo rotations.
    assert.deepEqual(
      (
        await dbAdmin
          .select()
          .from(grants)
          .where(inArray(grants.userId, [actorId, memberId]))
      ).map((c) => c.refreshTokenEnc),
      rotated.map((c) => c.refreshTokenEnc),
    );
    busy = true;
    await assert.rejects(check, (error) => error !== rollback);
    busy = false;
    const before = checked;
    await dbAdmin.delete(consents).where(eq(consents.userId, memberId));
    await assert.rejects(check);
    assert.equal(checked, before);
    await dbAdmin.insert(consents).values(consent!);
    await dbAdmin.update(grants).set({ revision: randomUUID() }).where(eq(grants.userId, memberId));
    await assert.rejects(check);
    assert.equal(checked, before);
    await dbAdmin
      .update(grants)
      .set({ revision: old.find((c) => c.userId === memberId)!.revision })
      .where(eq(grants.userId, memberId));
    await dbAdmin
      .insert(hours)
      .values({
        userId: memberId,
        revision: randomUUID(),
        tenantId: old.find((c) => c.userId === memberId)!.tenantId,
        timeZone: "UTC",
        windows: [],
      })
      .onConflictDoUpdate({ target: hours.userId, set: { windows: [] } });
    assert.equal((await store.read(actor, scheduleId)).hoursAllowed, false);
    await assert.rejects(check);
    assert.equal(checked, before);
    await dbAdmin.delete(hours).where(eq(hours.userId, memberId));
    refreshed = 0;
    failSecond = true;
    await assert.rejects(() =>
      prepareGooglePanelOperation(actor, original, dbAdmin, provider, events),
    );
    const afterFailure = await dbAdmin
      .select()
      .from(grants)
      .where(inArray(grants.userId, [actorId, memberId]));
    assert.ok(
      afterFailure.some(
        (c) => c.refreshTokenEnc !== rotated.find((g) => g.userId === c.userId)!.refreshTokenEnc,
      ),
      "A preceding rotation must commit even when another participant fails",
    );
    assert.equal(refreshed, 2);
    assert.ok(googleStaffConfig(), "The synthetic fixture configuration remains in use");
    return 8;
  } finally {
    for (const grant of old)
      await dbAdmin
        .update(grants)
        .set({
          revision: grant.revision,
          refreshTokenEnc: grant.refreshTokenEnc,
        })
        .where(eq(grants.userId, grant.userId));
    await dbAdmin.insert(consents).values(consent!).onConflictDoNothing();
    await dbAdmin.delete(hours).where(eq(hours.userId, memberId));
    if (oldHours) await dbAdmin.insert(hours).values(oldHours);
  }
}
