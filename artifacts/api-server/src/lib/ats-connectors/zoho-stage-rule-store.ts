import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { z } from "zod/v4";
import { auditLogsTable as audits, dbAdmin } from "@workspace/db";
import { CalendarError } from "../outlook-calendar-core";
import type { StageWriteActor, StageWriteScope } from "./zoho-stage-write-core";
import {
  ruleRecordSchema,
  ruleConflict,
  ruleRevision,
  type StageRuleEntry,
  type StageRuleRecord,
} from "./zoho-stage-rule-policy";
import type { CampaignTx } from "./zoho-interview-campaigns";

const action = "zoho.stage_rule";
const envelope = z.strictObject({
  version: z.literal(1),
  sequence: z.number().int().positive(),
  previousRevision: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .nullable(),
  requestId: z.uuid(),
  commandHash: z.string().regex(/^[a-f0-9]{64}$/),
  record: ruleRecordSchema,
});
type Reader = Pick<typeof dbAdmin, "select">;
export function zohoStageRuleStore(database = dbAdmin) {
  async function list(
    actor: StageWriteActor,
    scope: StageWriteScope,
    handle: Reader = database,
  ): Promise<StageRuleEntry[]> {
    const rows = await handle
      .select()
      .from(audits)
      .where(
        and(
          eq(audits.tenantId, actor.tenantId),
          eq(audits.subjectId, scope.recipientId),
          eq(audits.action, action),
          sql`${audits.metadata}->'record'->'base'->>'campaignId'=${scope.campaignId}`,
        ),
      )
      .limit(1001);
    if (rows.length > 1000)
      throw new CalendarError(
        409,
        "zoho_stage_rule_history_limit",
        "Rule history requires administrator review; no partial history was used.",
      );
    const parsed = rows
      .map((row) => ({ row, value: envelope.parse(row.metadata) }))
      .sort((a, b) => a.value.sequence - b.value.sequence);
    const result: StageRuleEntry[] = [];
    const commands = new Set<string>();
    for (const { row, value } of parsed) {
      const r = value.record,
        previous = result.at(-1);
      if (
        value.sequence !== result.length + 1 ||
        commands.has(value.requestId) ||
        value.previousRevision !== (previous?.revision ?? null) ||
        row.actorType !== "user" ||
        r.base.tenantId !== actor.tenantId ||
        r.base.campaignId !== scope.campaignId ||
        r.base.recipientId !== scope.recipientId ||
        row.actorId !==
          (r.state === "proposed"
            ? r.submittedBy
            : r.state === "verified"
              ? r.verifiedBy
              : r.revokedBy)
      )
        throw ruleConflict();
      if (r.state === "proposed") {
        if (result.some((entry) => entry.record.id === r.id)) throw ruleConflict();
      } else {
        if (
          !previous ||
          previous.record.id !== r.id ||
          previous.record.state === "revoked" ||
          (r.state === "verified" && previous.record.state !== "proposed") ||
          ruleRevision([r.base, r.evidence, r.submittedBy, r.submittedAt]) !==
            ruleRevision([
              previous.record.base,
              previous.record.evidence,
              previous.record.submittedBy,
              previous.record.submittedAt,
            ])
        )
          throw ruleConflict();
        if (
          r.state === "revoked" &&
          ruleRevision([r.verifiedBy, r.verifiedAt, r.expiresAt, r.reviewReference]) !==
            ruleRevision([
              previous.record.verifiedBy,
              previous.record.verifiedAt,
              previous.record.expiresAt,
              previous.record.reviewReference,
            ])
        )
          throw ruleConflict();
      }
      commands.add(value.requestId);
      result.push({
        record: r,
        revision: ruleRevision(value),
        requestId: value.requestId,
        commandHash: value.commandHash,
      });
    }
    return result;
  }
  return {
    list,
    async append(
      actor: StageWriteActor,
      scope: StageWriteScope,
      expectedRevision: string | null,
      requestId: string,
      commandHash: string,
      raw: StageRuleRecord,
      tx: CampaignTx,
    ) {
      const record = ruleRecordSchema.parse(raw);
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(
        ${JSON.stringify([actor.tenantId, "zoho-stage-rule", scope.campaignId, scope.recipientId])},0))`);
      const rows = await list(actor, scope, tx);
      const replay = rows.find((r) => r.requestId === requestId);
      if (replay) {
        if (replay.commandHash !== commandHash) throw ruleConflict();
        return replay;
      }
      if ((rows.at(-1)?.revision ?? null) !== expectedRevision) throw ruleConflict();
      if (
        record.base.tenantId !== actor.tenantId ||
        record.base.campaignId !== scope.campaignId ||
        record.base.recipientId !== scope.recipientId ||
        actor.id !==
          (record.state === "proposed"
            ? record.submittedBy
            : record.state === "verified"
              ? record.verifiedBy
              : record.revokedBy)
      )
        throw ruleConflict();
      const metadata = envelope.parse({
        version: 1,
        sequence: rows.length + 1,
        previousRevision: expectedRevision,
        requestId,
        commandHash,
        record,
      });
      // Source bindings use hashes, not raw external IDs. References must be
      // non-sensitive: no tokens, candidate data or evidence document bytes.
      await tx.insert(audits).values({
        id: randomUUID(),
        tenantId: actor.tenantId,
        actorId: actor.id,
        actorType: "user",
        subjectType: "external",
        subjectId: scope.recipientId,
        action,
        channel: "system",
        direction: "internal",
        title: `Zoho employer transition evidence: ${record.state}`,
        metadata,
      });
      return (await list(actor, scope, tx)).at(-1)!;
    },
  };
}
