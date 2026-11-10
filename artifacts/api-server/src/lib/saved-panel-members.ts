import { createHash } from "node:crypto";
import { z } from "zod/v4";
import type { GooglePanelPerson } from "./google-panel-times";
import { unavailable } from "./calendar-panel-access";

const outlook = z
  .object({
    userId: z.string().min(1),
    mailboxHash: z.string().regex(/^[a-f0-9]{64}$/),
    grantedAt: z.iso.datetime(),
  })
  .strict();
const google = z
  .object({
    provider: z.literal("google"),
    userId: z.string().min(1),
    connectionRevision: z.uuid(),
    subjectHash: z.string().regex(/^[a-f0-9]{64}$/),
    grantedAt: z.iso.datetime(),
  })
  .strict();
export const savedPanelMembers = z
  .array(z.union([google, outlook]))
  .max(5)
  .refine(
    (members) =>
      new Set(members.map((m) => m.userId)).size === members.length &&
      (members.every((m) => "provider" in m) || members.every((m) => !("provider" in m))),
  );
export function readSavedPanelMembers(value: unknown) {
  const parsed = savedPanelMembers.safeParse(value);
  if (!parsed.success) throw unavailable();
  return parsed.data;
}
export function savedPanelProvider(value: unknown): "google" | "outlook" | null {
  const members = readSavedPanelMembers(value);
  return members.length ? ("provider" in members[0] ? "google" : "outlook") : null;
}
export function googlePanelBinding(p: GooglePanelPerson) {
  if (!p.connection.subject) throw unavailable();
  return {
    provider: "google" as const,
    userId: p.member.id,
    connectionRevision: p.connection.revision,
    subjectHash: createHash("sha256").update(p.connection.subject).digest("hex"),
    grantedAt: p.consent.grantedAt.toISOString(),
  };
}
export function assertGooglePanelBindings(value: unknown, people: GooglePanelPerson[]) {
  const saved = readSavedPanelMembers(value);
  if (savedPanelProvider(saved) !== "google" || saved.length !== people.length) throw unavailable();
  for (const member of saved) {
    if (!("provider" in member)) throw unavailable();
    const person = people.find((p) => p.member.id === member.userId);
    if (!person) throw unavailable();
    const current = googlePanelBinding(person);
    if (
      member.connectionRevision !== current.connectionRevision ||
      member.subjectHash !== current.subjectHash ||
      member.grantedAt !== current.grantedAt
    )
      throw unavailable();
  }
}
