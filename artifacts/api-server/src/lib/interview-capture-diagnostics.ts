import { and, asc, eq } from "drizzle-orm";
import { db, auditLogsTable } from "@workspace/db";
import { RecordInterviewCaptureDiagnosticBody } from "@workspace/api-zod";
import { z } from "zod";

export const CaptureDiagnosticBody = RecordInterviewCaptureDiagnosticBody.strict().extend({
  turnNumber: z.number().int().min(1).max(100),
  longestRunMs: z.number().int().min(0).max(3600000).optional(),
  sampleCount: z.number().int().min(0).max(1000000).optional(),
  aboveThresholdSamples: z.number().int().min(0).max(1000000).optional(),
});
export type CaptureDiagnosticInput = z.infer<typeof CaptureDiagnosticBody>;
export const CAPTURE_DIAGNOSTIC_ACTION = "interview.capture_diagnostic";

// Only validated, content-free fields enter this audit stream. These are
// client reports, never authoritative speech, integrity or grading evidence.
export async function saveCaptureDiagnostic(
  session: { id: string; tenantId: string; candidateId: string },
  input: CaptureDiagnosticInput,
) {
  const diagnostic = CaptureDiagnosticBody.parse(input);
  await db
    .insert(auditLogsTable)
    .values({
      id: diagnostic.eventId,
      tenantId: session.tenantId,
      actorType: "candidate",
      actorId: session.candidateId,
      actorLabel: "Interview capture diagnostics",
      subjectType: "candidate",
      subjectId: session.id,
      channel: "system",
      direction: "internal",
      action: CAPTURE_DIAGNOSTIC_ACTION,
      title: `Question ${diagnostic.turnNumber}: ${diagnostic.event} (${diagnostic.reason})`,
      metadata: { ...diagnostic, clientReported: true },
    })
    .onConflictDoNothing();
}

export async function readCaptureDiagnostics(session: { id: string; tenantId: string }) {
  const rows = await db
    .select({
      metadata: auditLogsTable.metadata,
      createdAt: auditLogsTable.createdAt,
    })
    .from(auditLogsTable)
    .where(
      and(
        eq(auditLogsTable.subjectId, session.id),
        eq(auditLogsTable.tenantId, session.tenantId),
        eq(auditLogsTable.action, CAPTURE_DIAGNOSTIC_ACTION),
      ),
    )
    .orderBy(asc(auditLogsTable.createdAt))
    .limit(500);
  return {
    clientReported: true,
    events: rows.flatMap((row) => {
      // Historical or malformed metadata must never leak arbitrary fields.
      const parsed = CaptureDiagnosticBody.safeParse(
        Object.fromEntries(
          Object.entries(row.metadata ?? {}).filter(([key]) => key !== "clientReported"),
        ),
      );
      return parsed.success ? [{ ...parsed.data, recordedAt: row.createdAt.toISOString() }] : [];
    }),
  };
}
