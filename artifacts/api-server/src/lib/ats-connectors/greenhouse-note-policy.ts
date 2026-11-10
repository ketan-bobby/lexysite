import { z } from "zod/v4";

/** Intentionally not an arbitrary Harvest write proxy. */
export const greenhouseNoteInput = z.strictObject({
  candidate_id: z.number().int().positive().safe(),
  application_id: z.number().int().positive().safe(),
  note_type: z.literal("NOTE"),
  visibility: z.literal("admin_only"),
  subject: z.string().min(1).max(200),
  body: z.string().min(1).max(12000),
});
export type GreenhouseNoteInput = z.infer<typeof greenhouseNoteInput>;

/** A receipt with corrupt/missing provider identity is held, never published. */
export function savedGreenhouseNoteId(action: string | undefined, note: string | null | undefined) {
  if (!["ats.interview.note.published", "ats.interview.note.reconciled"].includes(action ?? ""))
    return null;
  try {
    const id: unknown = JSON.parse(note ?? "{}").noteId;
    return typeof id === "string" && /^[1-9]\d*$/.test(id) && Number.isSafeInteger(Number(id))
      ? id
      : null;
  } catch {
    return null;
  }
}

export function recoveredGreenhouseNote(raw: unknown, id: string) {
  const note = z
    .array(
      z.object({
        id: z.number().int().positive().safe(),
        candidate_id: z.number().int().positive().safe(),
        application_id: z.number().int().positive().safe(),
        type: z.literal("NOTE"),
        visibility: z.literal("admin_only_visible"),
        body: z.string().min(1).max(12000),
        subject: z.string().min(1).max(200),
      }),
    )
    .length(1)
    .parse(raw)[0];
  if (String(note.id) !== id) throw new Error("Note identity mismatch.");
  return greenhouseNoteInput.parse({
    candidate_id: note.candidate_id,
    application_id: note.application_id,
    note_type: note.type,
    visibility: "admin_only",
    body: note.body,
    subject: note.subject,
  });
}

export function greenhouseNoteReceipt(raw: unknown, input: GreenhouseNoteInput): string {
  const note = z
    .object({
      id: z.number().int().positive().safe(),
      candidate_id: z.literal(input.candidate_id),
      application_id: z.literal(input.application_id),
      type: z.literal("NOTE"),
      visibility: z.literal("admin_only_visible"),
      body: z.literal(input.body),
      subject: z.literal(input.subject),
    })
    .parse(raw);
  return String(note.id);
}
