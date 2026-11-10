import { createHash } from "node:crypto";
import { and, eq, notInArray, sql } from "drizzle-orm";
import {
  dbAdmin,
  jobsTable,
  recruitingWorkflowsTable as workflows,
  userNotificationsTable as notifications,
} from "@workspace/db";
import type { WorkflowScope } from "./recruiting-workflows";
import { offerAuthority } from "./offer-routing";
import { offerView } from "./controlled-offer-view";
import { logger } from "./logger";

type Handle = typeof dbAdmin | Parameters<Parameters<typeof dbAdmin.transaction>[0]>[0];
const type = "offer_action_required";
const fields = ["ownerUserId", "approverUserId", "senderUserId"] as const;

/** Called inside the workflow transaction: state, recipients and alerts commit together. */
export async function syncOfferNotifications(
  tx: Handle,
  scope: WorkflowScope,
  workflowId: string,
  enroll = false,
) {
  const [row] = await tx
    .select()
    .from(workflows)
    .where(
      and(
        eq(workflows.id, workflowId),
        eq(workflows.tenantId, scope.tenantId),
        eq(workflows.jobId, scope.jobId),
      ),
    );
  if (!row) return;
  const step = row.steps.find((s) => s.key === "hiring_decision");
  if (!step || (!enroll && !step.offerNotificationsTracked)) return;
  if (enroll && !step.offerNotificationsTracked) {
    step.offerNotificationsTracked = true;
    await tx
      .update(workflows)
      .set({ steps: row.steps })
      .where(
        and(
          eq(workflows.id, row.id),
          eq(workflows.tenantId, row.tenantId),
          eq(workflows.jobId, row.jobId),
        ),
      );
  }
  const inboxUrl = `/offer-inbox?workflow=${encodeURIComponent(row.id)}`;
  const recoveryUrl = `/jobs/${encodeURIComponent(row.jobId)}?tab=overview`;
  const prefix = `offer-action:${createHash("sha256").update(`${row.tenantId}:${row.id}`).digest("hex").slice(0, 24)}:`;
  // Alerts intentionally contain no names, compensation, response capabilities or legal terms.
  const pending: Array<{
    userId: string;
    key: string;
    title: string;
    message: string;
    actionUrl: string;
  }> = [];
  const authority = await offerAuthority(tx, scope, row);
  const config = authority.config;
  const offer = step.controlledOffer;
  const status = offer ? offerView(offer).status : "unprepared";
  const { candidateAllowed } = await import("../routes/recruiting-workflows");
  const [job] = await tx
    .select()
    .from(jobsTable)
    .where(and(eq(jobsTable.id, row.jobId), eq(jobsTable.tenantId, row.tenantId)));
  // Reuse the current application-link/compliance/platform-privacy seal, not historical visibility.
  const visible =
    job &&
    authority.available.length > 0 &&
    (await candidateAllowed(
      tx,
      {
        job,
        user: authority.available[0],
        allowed: [row.tenantId],
        scope: {
          ...scope,
          actorName: scope.actorName ?? "Offer notification service",
          canEdit: true,
        },
      },
      row.candidateId,
    ));
  const { eligibility } = await import("./controlled-offers");
  const ready = visible && (await eligibility(tx, scope, row)) === null;
  const add = (
    userId: string | null,
    key: string,
    title: string,
    message: string,
    recovery = false,
  ) => {
    if (!userId || !authority.available.some((u) => u.id === userId)) return;
    pending.push({
      userId,
      key,
      title: `${offer?.testOnly || step.humanDecision?.testOnly ? "[TEST ONLY] " : ""}${title}`,
      message,
      actionUrl: recovery ? recoveryUrl : inboxUrl,
    });
  };
  if (
    visible &&
    config?.mode === "native" &&
    !["withdrawn", "expired", "cancelled"].includes(status)
  ) {
    const missing = fields.filter(
      (field) => !authority.available.some((u) => u.id === config[field]),
    );
    if (missing.length && offer) {
      for (const admin of authority.available.filter((u) => u.role === "tenant_admin"))
        add(
          admin.id,
          `recovery:${missing.join(",")}`,
          "Offer ownership needs recovery",
          "A designated offer operator is unavailable. Review employer ownership. Recovery does not approve, send, or release uncertain delivery.",
          true,
        );
    }
    if (status === "send_uncertain") {
      for (const id of new Set([config.ownerUserId, config.senderUserId]))
        add(
          id,
          "delivery",
          "Offer delivery needs investigation",
          "The original send attempt is uncertain. Check recorded evidence; do not resend.",
        );
    } else if (
      !missing.length &&
      !ready &&
      ["draft", "review_required", "approved", "unprepared"].includes(status)
    ) {
      add(
        config.ownerUserId,
        "governance",
        "Offer requires hiring review",
        "The work order or hiring decision does not currently permit offer actions. Review the current work order; this alert does not release any approval or delivery hold.",
        true,
      );
    } else if (!missing.length && ready && status === "review_required") {
      add(
        config.approverUserId,
        "review",
        "Offer review required",
        "Review the exact saved version. Approval will not send the offer.",
      );
    } else if (!missing.length && ready && status === "approved") {
      add(
        config.senderUserId,
        "send",
        "Approved offer awaits human send",
        "A human approved the saved version. Review it and use the separate Send confirmation; nothing has been sent automatically.",
      );
    } else if (
      !missing.length &&
      ["draft", "unprepared"].includes(status) &&
      step.status === "completed" &&
      step.humanDecision?.outcome === "hire"
    ) {
      add(
        config.ownerUserId,
        "prepare",
        "Offer preparation required",
        "Prepare or revise employer-authored terms, then submit for human review. No automatic approval or delivery.",
      );
    }
  }
  const rows = pending.map((p) => ({
    id: `${prefix}${createHash("sha256")
      .update(
        JSON.stringify([
          row.tenantId,
          row.id,
          p.userId,
          p.key,
          status,
          offer?.id,
          offer?.version,
          offer?.approvedAt,
          config?.ownerUserId,
          config?.approverUserId,
          config?.senderUserId,
        ]),
      )
      .digest("hex")}`,
    tenantId: row.tenantId,
    userId: p.userId,
    type,
    title: p.title,
    message: p.message,
    actionUrl: p.actionUrl,
  }));
  // Delete obsolete actionable alerts, preserving mark-read for an unchanged pending task.
  await tx.delete(notifications).where(
    and(
      eq(notifications.tenantId, row.tenantId),
      eq(notifications.type, type),
      sql`${notifications.id} LIKE ${`${prefix}%`}`,
      rows.length
        ? notInArray(
            notifications.id,
            rows.map((r) => r.id),
          )
        : undefined,
    ),
  );
  if (rows.length) await tx.insert(notifications).values(rows).onConflictDoNothing();
}

let running = false;
export async function sweepOfferNotifications() {
  if (running) return;
  running = true;
  try {
    const tracked = await dbAdmin
      .select({
        id: workflows.id,
        tenantId: workflows.tenantId,
        jobId: workflows.jobId,
      })
      .from(workflows).where(sql`EXISTS (SELECT 1 FROM jsonb_array_elements(${workflows.steps}) s
      WHERE s->>'key'='hiring_decision' AND s->>'offerNotificationsTracked'='true')`);
    for (const row of tracked) {
      try {
        await dbAdmin.transaction(async (tx) => {
          await tx.execute(
            sql`SELECT pg_advisory_xact_lock(hashtextextended(${`recruiting-workflow:${row.jobId}`},0))`,
          );
          await syncOfferNotifications(
            tx,
            {
              jobId: row.jobId,
              tenantId: row.tenantId,
              actorId: "",
              canApprove: false,
            },
            row.id,
          );
        });
      } catch (err) {
        logger.error({ err, workflowId: row.id }, "Offer notification refresh failed");
      }
    }
  } finally {
    running = false;
  }
}

export function startOfferNotificationScheduler() {
  setInterval(() => {
    void sweepOfferNotifications().catch((err) =>
      logger.error({ err }, "Offer notification sweep failed"),
    );
  }, 300_000).unref();
}
