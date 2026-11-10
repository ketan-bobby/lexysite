import { z } from "zod";

export const NATIVE_DISCOVERY_ACTION = "sourcing.native_discovery";
export const NATIVE_IMPORT_ACTION = "sourcing.native_import";
export const NativeDiscoveryRecord = z.object({
  reservationId: z.string(),
  operationId: z.string(),
  profiles: z.array(z.object({ title: z.string(), url: z.string(), snippet: z.string() })).max(10),
  provider: z.enum(["serp", "pdl", "enrichlayer"]).default("serp"),
  status: z.enum(["succeeded", "skipped"]).default("succeeded"),
  reason: z.string().optional(),
});
export const NativeImportRecord = z.object({
  reservationId: z.string(),
  operationId: z.string(),
  profileUrl: z.string(),
  candidateId: z.string(),
  sourceId: z.string(),
  idempotencyKey: z.string(),
  inputHash: z.string(),
});
export const NativeImportInput = z
  .object({
    reservationId: z.string().min(1),
    operationId: z.string().min(1).max(128),
    profileUrl: z.string().min(1).max(500),
    fullName: z
      .string()
      .trim()
      .min(2)
      .max(160)
      .refine((v) => !/[<>\u0000-\u001f]/.test(v)),
    idempotencyKey: z.string().min(8).max(128),
    expectedRevision: z.number().int().min(0),
    expectedBriefHash: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
