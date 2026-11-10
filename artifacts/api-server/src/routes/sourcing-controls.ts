import { Router } from "express";
import { z } from "zod";
import { CommandJobSourcingControlsBody } from "@workspace/api-zod";
import { db } from "@workspace/db";
import { gateJobAccess } from "./recruiting-workflows";
import { validate } from "../middlewares/validate";
import { WorkflowConflict } from "../lib/recruiting-workflows";
import { startInternalSourcing } from "../lib/sourcing-internal-run";
import { startNativeSourcing } from "../lib/sourcing-native-run";
import { importNativeProfile } from "../lib/sourcing-native-import";
import { NativeImportInput } from "../lib/sourcing-native-records";
import { getSourcingMonthlyPackages } from "../lib/sourcing-monthly-packages";
import {
  getSourcingControls,
  saveSourcingPolicy,
  approveSourcingPolicy,
  reserveSourcingRun,
  controlSourcingReservation,
} from "../lib/sourcing-controls";

const router = Router();
const accountRate = z
  .object({
    microsPerCredit: z.number().int().min(1).max(100_000_000),
    basis: z.enum(["prepaid_allocation", "payg"]),
    source: z
      .string()
      .trim()
      .min(3)
      .max(160)
      .refine(
        (s) =>
          !/@|\b(sk|pk|key|token|secret)[-_:= ]*[A-Za-z0-9_-]{12,}|[A-Za-z0-9_-]{32,}/i.test(s),
        "Use only a non-secret plan name and billing period; no credentials or contact details.",
      ),
    expiresAt: z.string().datetime(),
  })
  .strict();
const limits = z
  .object({
    allowExternal: z.boolean(),
    providers: z
      .array(z.enum(["github", "pdl", "serp", "enrichlayer"]))
      .max(4)
      .refine((v) => new Set(v).size === v.length, "Duplicate provider"),
    maxCandidates: z.number().int().min(1).max(25),
    maxDurationSeconds: z.number().int().min(30).max(900),
    maxRuns: z.number().int().min(1).max(20),
    runBudgetCents: z.number().int().min(1).max(1_000_000),
    totalBudgetCents: z.number().int().min(1).max(10_000_000),
    accountRates: z
      .object({
        pdl: accountRate.optional(),
        serp: accountRate.optional(),
        enrichlayer: accountRate.optional(),
      })
      .strict()
      .optional(),
  })
  .strict()
  .refine((v) => v.totalBudgetCents >= v.runBudgetCents, "Per-run cap exceeds requisition cap");
const body = CommandJobSourcingControlsBody.extend({
  idempotencyKey: z.string().min(8).max(128),
  expectedRevision: z.number().int().min(0),
  expectedBriefHash: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .optional(),
  limits: limits.optional(),
  journeyId: z.string().min(1).optional(),
  reservationId: z.string().min(1).optional(),
  operationId: NativeImportInput.shape.operationId.optional(),
  profileUrl: NativeImportInput.shape.profileUrl.optional(),
  fullName: NativeImportInput.shape.fullName.optional(),
})
  .strict()
  .superRefine((v, ctx) => {
    const allowed = ["action", "idempotencyKey", "expectedRevision"];
    if (["save", "approve", "reserve", "import_profile"].includes(v.action))
      allowed.push("expectedBriefHash");
    if (v.action === "save") allowed.push("limits");
    if (v.action === "approve") allowed.push("journeyId");
    if (
      ["pause", "resume", "cancel", "start_internal", "start_external", "import_profile"].includes(
        v.action,
      )
    )
      allowed.push("reservationId");
    if (v.action === "import_profile") allowed.push("operationId", "profileUrl", "fullName");
    for (const key of [
      "expectedBriefHash",
      "limits",
      "journeyId",
      "reservationId",
      "operationId",
      "profileUrl",
      "fullName",
    ] as const) {
      if (allowed.includes(key) && v[key] === undefined)
        ctx.addIssue({ code: "custom", path: [key], message: "Required for this action" });
      if (!allowed.includes(key) && v[key] !== undefined)
        ctx.addIssue({ code: "custom", path: [key], message: "Not permitted for this action" });
    }
  });

router.get("/jobs/:jobId/sourcing-controls", async (req, res) => {
  const gate = await gateJobAccess(req, res);
  if (!gate) return;
  res.json({
    ...(await getSourcingControls(db, gate.scope)),
    monthlyPackages: await getSourcingMonthlyPackages(gate.scope.tenantId),
    canEdit: gate.user.role !== "interviewer",
  });
});

router.post("/jobs/:jobId/sourcing-controls", async (req, res, next) => {
  // Gate first; validation never grants authority for a foreign requisition.
  const gate = await gateJobAccess(
    req,
    res,
    true,
    ["approve", "reserve", "start_external", "import_profile"].includes(req.body?.action),
  );
  if (!gate) return;
  validate({ body })(req, res, async () => {
    const input = req.body as z.infer<typeof body>;
    try {
      const common = {
        idempotencyKey: input.idempotencyKey,
        expectedRevision: input.expectedRevision,
      };
      const result =
        input.action === "import_profile"
          ? await importNativeProfile(
              gate.scope,
              NativeImportInput.parse({
                ...common,
                reservationId: input.reservationId,
                operationId: input.operationId,
                profileUrl: input.profileUrl,
                fullName: input.fullName,
                expectedBriefHash: input.expectedBriefHash,
              }),
            )
          : input.action === "save"
            ? await saveSourcingPolicy(gate.scope, {
                ...common,
                expectedBriefHash: input.expectedBriefHash!,
                limits: input.limits!,
              })
            : input.action === "approve"
              ? await approveSourcingPolicy(gate.scope, {
                  ...common,
                  expectedBriefHash: input.expectedBriefHash!,
                  journeyId: input.journeyId!,
                })
              : input.action === "start_external"
                ? await startNativeSourcing(
                    gate.scope,
                    input.reservationId!,
                    input.expectedRevision,
                  )
                : input.action === "start_internal"
                  ? await startInternalSourcing(
                      gate.scope,
                      input.reservationId!,
                      input.expectedRevision,
                    )
                  : input.action === "reserve"
                    ? await reserveSourcingRun(gate.scope, {
                        ...common,
                        expectedBriefHash: input.expectedBriefHash!,
                      })
                    : await controlSourcingReservation(gate.scope, {
                        ...common,
                        reservationId: input.reservationId!,
                        action: input.action,
                      });
      res.json(result);
    } catch (error) {
      if (error instanceof WorkflowConflict)
        res.status(error.status).json({ error: error.message });
      else next(error);
    }
  });
});
export default router;
