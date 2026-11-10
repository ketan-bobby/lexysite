import { createHash } from "node:crypto";
import {
  dbAdmin,
  recruitingWorkflowsTable as workflows,
  recruitingWorkflowEventsTable as workflowEvents,
  type ControlledOfferRecord,
} from "@workspace/db";
import { and, eq, sql } from "drizzle-orm";

type Delivery = NonNullable<ControlledOfferRecord["providerDelivery"]>;
type Status = Delivery["status"];
export type OfferProviderEvent = {
  workflowId: string;
  offerId: string;
  version: number;
  attemptId: string;
  messageId: string;
  recipients: string[];
  status: Status;
  occurredAt: string;
  id: string;
};

const tagNames = ["lexy_workflow", "lexy_offer", "lexy_version", "lexy_attempt"] as const;
const safeId = (v: unknown): v is string =>
  typeof v === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(v);

/** Only server-owned controlled-offer audit metadata becomes SES correlation tags.
 * Never tag financial terms, recipient capabilities or candidate answers. */
export function offerEmailTags(
  action: unknown,
  metadata: Record<string, unknown> | null | undefined,
) {
  if (
    action !== "offer.delivery" ||
    !metadata ||
    !safeId(metadata.workflowId) ||
    !safeId(metadata.offerId) ||
    !safeId(metadata.deliveryAttemptId) ||
    !Number.isSafeInteger(metadata.version) ||
    Number(metadata.version) < 1
  )
    return undefined;
  const values = [
    metadata.workflowId,
    metadata.offerId,
    String(metadata.version),
    metadata.deliveryAttemptId,
  ];
  return tagNames.map((Name, i) => ({ Name, Value: values[i] as string }));
}

/** Bounded SES facts only; caller must verify the signed envelope and correlation. */
export function parseSesDelivery(payload: any) {
  const messageId = payload?.mail?.messageId;
  if (typeof messageId !== "string" || !messageId.length || messageId.length > 256) return null;
  const kind = payload.eventType ?? payload.notificationType;
  let status: Status;
  let detail: any;
  switch (kind) {
    case "Send":
      status = "accepted";
      detail = payload.mail;
      break;
    case "Delivery":
      status = "delivered";
      detail = payload.delivery;
      break;
    case "DeliveryDelay":
      status = "delayed";
      detail = payload.deliveryDelay;
      break;
    case "Bounce":
      status = payload.bounce?.bounceType === "Permanent" ? "bounced" : "delayed";
      detail = payload.bounce;
      break;
    case "Reject":
      status = "rejected";
      detail = payload.reject;
      break;
    case "Rendering Failure":
      status = "rejected";
      detail = payload.failure;
      break;
    case "Complaint":
      status = "complained";
      detail = payload.complaint;
      break;
    default:
      return null;
  }
  const timestamp = detail?.timestamp ?? payload.mail?.timestamp;
  if (typeof timestamp !== "string" || !Number.isFinite(Date.parse(timestamp))) return null;
  // Recipient-specific results must actually name our intended recipient.
  const addressList = (list: unknown) =>
    Array.isArray(list) ? list.map((r) => r?.emailAddress) : null;
  const raw =
    kind === "Bounce"
      ? addressList(detail?.bouncedRecipients)
      : kind === "Complaint"
        ? addressList(detail?.complainedRecipients)
        : kind === "Delivery"
          ? detail?.recipients
          : kind === "DeliveryDelay"
            ? addressList(detail?.delayedRecipients)
            : payload.mail?.destination;
  if (!Array.isArray(raw) || raw.length > 100) return null;
  const recipients = raw
    .filter((r: unknown): r is string => typeof r === "string")
    .map((r) => r.trim().toLowerCase())
    .filter((r) => r.length > 0 && r.length <= 320);
  if (!recipients.length) return null;
  const occurredAt = new Date(timestamp).toISOString();
  return { messageId, recipients, status, occurredAt, kind };
}

/** Called only after SNS signature AND exact topic allowlist verification. */
export function parseOfferProviderEvent(payload: any): OfferProviderEvent | null {
  const tags = payload?.mail?.tags;
  const values = tagNames.map((name) =>
    Array.isArray(tags?.[name]) && tags[name].length === 1 ? tags[name][0] : null,
  );
  const [workflowId, offerId, versionText, attemptId] = values;
  if (
    !safeId(workflowId) ||
    !safeId(offerId) ||
    !safeId(attemptId) ||
    typeof versionText !== "string" ||
    !/^[1-9]\d{0,8}$/.test(versionText)
  )
    return null;
  const facts = parseSesDelivery(payload);
  if (!facts) return null;
  const { messageId, recipients, status, occurredAt, kind } = facts;
  const version = Number(versionText);
  const id = createHash("sha256")
    .update(
      JSON.stringify([
        workflowId,
        offerId,
        version,
        attemptId,
        messageId,
        kind,
        status,
        occurredAt,
        [...new Set(recipients)].sort(),
      ]),
    )
    .digest("hex");
  return { workflowId, offerId, version, attemptId, messageId, recipients, status, occurredAt, id };
}

const severity: Record<Status, number> = {
  accepted: 0,
  delayed: 1,
  delivered: 2,
  bounced: 3,
  rejected: 4,
  complained: 5,
};

export function applyOfferProviderEvent(
  offer: ControlledOfferRecord,
  event: OfferProviderEvent,
  receivedAt = new Date().toISOString(),
): ControlledOfferRecord | null {
  if (
    offer.id !== event.offerId ||
    offer.version !== event.version ||
    offer.deliveryAttemptId !== event.attemptId ||
    !event.recipients.includes(offer.recipientEmail.trim().toLowerCase()) ||
    !["sending", "send_uncertain", "sent", "accepted", "declined", "expired", "withdrawn"].includes(
      offer.status,
    ) ||
    (offer.deliveryReceiptId && offer.deliveryReceiptId !== event.messageId)
  )
    return null;
  const previous = offer.providerDelivery;
  if (
    previous &&
    (previous.messageId !== event.messageId ||
      previous.deliveryAttemptId !== event.attemptId ||
      previous.events.some((e) => e.id === event.id))
  )
    return null;
  // Never let delayed/duplicated/out-of-order events erase terminal failure or complaint.
  const advances =
    !previous ||
    severity[event.status] > severity[previous.status] ||
    (event.status === previous.status && event.occurredAt > previous.occurredAt);
  const events = [
    ...(previous?.events ?? []),
    {
      id: event.id,
      status: event.status,
      occurredAt: event.occurredAt,
    },
  ]
    .sort((a, b) => b.occurredAt.localeCompare(a.occurredAt) || a.id.localeCompare(b.id))
    .slice(0, 16);
  // Beyond the bounded window, a replay must not produce another write/revision.
  if (previous && !advances && !events.some((e) => e.id === event.id)) return null;
  return {
    ...offer,
    providerDelivery: {
      provider: "ses",
      messageId: event.messageId,
      deliveryAttemptId: event.attemptId,
      status: advances ? event.status : previous!.status,
      occurredAt: advances ? event.occurredAt : previous!.occurredAt,
      receivedAt,
      events,
    },
  };
}

/** Durable, job-serialized update; never modifies offer authority, tokens,
 * candidate stage, financial terms, responses or employment/fee outcomes. */
export async function recordOfferProviderEvent(event: OfferProviderEvent) {
  const [target] = await dbAdmin
    .select({ tenantId: workflows.tenantId, jobId: workflows.jobId })
    .from(workflows)
    .where(eq(workflows.id, event.workflowId));
  if (!target) return { updated: false };
  return dbAdmin.transaction(async (tx) => {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${`recruiting-workflow:${target.jobId}`},0))`,
    );
    const [row] = await tx
      .select()
      .from(workflows)
      .where(
        and(
          eq(workflows.id, event.workflowId),
          eq(workflows.tenantId, target.tenantId),
          eq(workflows.jobId, target.jobId),
        ),
      )
      .for("update");
    if (!row) return { updated: false };
    let updated = false;
    const steps = row.steps.map((step) => {
      const apply = (offer: ControlledOfferRecord) => {
        const result = applyOfferProviderEvent(offer, event);
        if (result) updated = true;
        return result ?? offer;
      };
      return {
        ...step,
        ...(step.controlledOffer ? { controlledOffer: apply(step.controlledOffer) } : {}),
        ...(step.controlledOfferHistory
          ? { controlledOfferHistory: step.controlledOfferHistory.map(apply) }
          : {}),
      };
    });
    if (!updated) return { updated: false };
    await tx
      .update(workflows)
      .set({ steps, revision: row.revision + 1, updatedAt: new Date() })
      .where(
        and(
          eq(workflows.id, row.id),
          eq(workflows.tenantId, target.tenantId),
          eq(workflows.jobId, target.jobId),
        ),
      );
    await tx.insert(workflowEvents).values({
      tenantId: target.tenantId,
      jobId: target.jobId,
      workflowId: row.id,
      actorId: "ses-provider",
      action: "offer.provider_delivery",
      note: `SES ${event.status}; offer ${event.offerId} v${event.version}; attempt ${event.attemptId}; message ${event.messageId}; event ${event.id}. No approval, resend, response or employment action.`,
    });
    return { updated: true };
  });
}
